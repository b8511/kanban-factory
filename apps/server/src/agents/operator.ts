import type { OperatorAnalysis, OperatorMessage, Project } from '../types.js';
import { runAgent } from './runner.js';

const ANALYSIS_PROMPT = `You are the Operator at Kanban Factory. The user has just opened the Operate page for a finished project. You are given the project's working directory. Your job: figure out what this project is and exactly how to run it.

Mandatory steps:
1. List the top-level files and directories (\`ls\`).
2. Read README.md, CLAUDE.md, package.json, pyproject.toml, requirements.txt, Cargo.toml, go.mod, Dockerfile — whichever exist.
3. Open the top-level source files (main.py, app.py, server.py, index.js, index.ts, src/index.*, etc.) to understand what boots the app.
4. If it is an npm/pnpm project, look at the scripts in package.json. Prefer \`dev\` if the project is a long-running server; prefer \`start\` if \`dev\` is not present.
5. If it is a Python script, decide whether it expects any args / env vars. If it clearly needs an env file, note that in the summary.

Output ONLY this JSON (no prose, no code fences):
{
  "summary": "one to two sentences: what this project is and what running it will do",
  "stack": ["node", "react", "express", "..."],
  "entrypoints": [{ "path": "apps/server/index.js", "kind": "server" | "script" | "cli" | "static" | "worker" | "unknown" }],
  "runCommandGuess": "exact shell command, or null if you cannot confidently propose one",
  "confidence": 0.0 to 1.0
}

Do not run the command. Do not modify files. The user will decide whether to launch it.`;

const CHAT_SYSTEM_PROMPT = `You are the Operator at Kanban Factory. You help the user get a finished project running and debugged in the browser. You can use Bash to inspect files, check versions, and run short diagnostic commands (do NOT start long-running servers yourself — the UI's Run/Stop buttons handle that; the user will push them when ready, though you may recommend when to push Run).

Guidelines:
- Be short and action-oriented. One or two paragraphs per reply, not essays.
- Default posture: take initiative. If the user says "run it", suggest (or confirm) the exact command and tell them to press the green Run button, then stand by to read the output.
- If you can see stderr or a non-zero exit from a prior run, diagnose the root cause in plain English and propose either (a) a fix you can make locally via Bash (small config / env fixes), or (b) a structured diagnostic that can be sent to the factory if the fix needs real code changes.
- Do NOT modify source files. If a fix requires code changes, recommend sending a diagnostic to the factory.
- When the user asks for a fix task for the factory, produce a clean task description including what failed, what you saw, and what the factory should change. Keep it under 12 lines.

End your reply with a short next-step line: e.g. "Next: press Run." or "Next: install deps with \`npm install\`." or "Next: send this to the factory."`;

export async function runOperatorAnalysis(
  project: Project,
  sessionId: string,
  abortSignal?: AbortSignal
): Promise<OperatorAnalysis> {
  const result = await runAgent({
    taskId: `operator-${sessionId}`,
    role: 'operator',
    cwd: project.path,
    systemPrompt: ANALYSIS_PROMPT,
    prompt: `Project name: ${project.name}\nProject path: ${project.path}\n\nProceed with the analysis and output the JSON.`,
    maxTurns: 12,
    abortSignal,
    operatorSessionId: sessionId,
    projectId: project.id,
    maxThinkingTokens: 1500,
  });

  const parsed = parseAnalysis(result.finalText);
  if (!parsed) {
    return {
      summary: `Could not parse operator analysis output. Raw: ${result.finalText.slice(0, 200)}`,
      stack: [],
      entrypoints: [],
      runCommandGuess: project.runCommand ?? null,
      confidence: 0,
    };
  }
  return parsed;
}

export async function runOperatorChat(
  project: Project,
  sessionId: string,
  userMessage: string,
  history: OperatorMessage[],
  analysis: OperatorAnalysis | null,
  terminalTail: string,
  abortSignal?: AbortSignal
): Promise<string> {
  const historyBlock =
    history.length === 0
      ? '(no prior turns)'
      : history
          .slice(-10)
          .map((m) => `[${m.role}] ${m.content}`)
          .join('\n\n');

  const analysisBlock = analysis
    ? `Project analysis so far:\n${JSON.stringify(analysis, null, 2)}`
    : 'Analysis not yet available.';

  const terminalBlock = terminalTail.trim()
    ? `Last terminal output (tail):\n${terminalTail}`
    : 'Terminal is empty — nothing has run yet in this session.';

  const userPrompt = `Project: ${project.name} (${project.path})

${analysisBlock}

${terminalBlock}

Conversation so far:
${historyBlock}

User's new message:
${userMessage}

Respond now.`;

  const result = await runAgent({
    taskId: `operator-${sessionId}`,
    role: 'operator',
    cwd: project.path,
    systemPrompt: CHAT_SYSTEM_PROMPT,
    prompt: userPrompt,
    maxTurns: 10,
    abortSignal,
    operatorSessionId: sessionId,
    projectId: project.id,
  });

  return result.finalText.trim() || '(no response)';
}

function parseAnalysis(text: string): OperatorAnalysis | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const tryParse = (s: string): OperatorAnalysis | null => {
    try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === 'object' && typeof parsed.summary === 'string') {
        return {
          summary: String(parsed.summary),
          stack: Array.isArray(parsed.stack)
            ? parsed.stack.filter((s: unknown): s is string => typeof s === 'string')
            : [],
          entrypoints: Array.isArray(parsed.entrypoints)
            ? parsed.entrypoints
                .filter(
                  (e: any) =>
                    e && typeof e === 'object' && typeof e.path === 'string' && typeof e.kind === 'string'
                )
                .map((e: any) => ({ path: String(e.path), kind: String(e.kind) }))
            : [],
          runCommandGuess:
            typeof parsed.runCommandGuess === 'string' && parsed.runCommandGuess.trim()
              ? parsed.runCommandGuess.trim()
              : null,
          confidence:
            typeof parsed.confidence === 'number'
              ? Math.max(0, Math.min(1, parsed.confidence))
              : 0.5,
        };
      }
    } catch {}
    return null;
  };
  const direct = tryParse(candidate);
  if (direct) return direct;
  const s = candidate.indexOf('{');
  const e = candidate.lastIndexOf('}');
  if (s >= 0 && e > s) return tryParse(candidate.slice(s, e + 1));
  return null;
}
