import type { ArchitectPlan, Project, SubtaskHistoryEntry, Task } from '../types.js';
import { runAgent } from './runner.js';
import { ArchitectRefusalError, detectRefusal } from './refusal.js';

const INITIAL_SYSTEM_PROMPT = `You are the Architect for a software project. You produce a ROLLING plan: only the next 1-3 concrete subtasks, never the whole project up front. After the Specialist executes them, you will be called again to plan the NEXT 1-3 subtasks based on what actually exists in the codebase.

Before planning:
1. Explore the project at the current working directory. Run \`ls\` and read any CLAUDE.md, README.md, package.json or equivalent config files.
2. Skim the directory tree to understand the codebase.

Then output a JSON plan using ONLY this schema (no markdown, no prose, no code fences):
{
  "subtasks": [
    {
      "description": "one concrete action in plain English",
      "touches": ["relative/file/path1", "relative/file/path2"]
    }
  ],
  "notes": "3-8 sentences capturing what you learned: key files and their purpose, conventions, and what's still unclear. The next replan will see this so you don't have to re-explore."
}

Hard rules:
- Output AT MOST 3 subtasks. 1 is fine. Pick the smallest meaningful first slice.
- Each subtask must be small enough that one Specialist can finish it in a few tool calls.
- Use relative paths from the project root in \`touches\`. If a subtask creates a new file, list its intended path.
- Do NOT plan the whole task. Plan only what the Specialist needs next; you will see the result and decide what comes after.

Runnability requirement (applies whenever the task builds or changes app behavior — skip only for pure docs/typo/config-comment tasks):
- The finished project MUST be runnable with a single command. That means EITHER a \`package.json\` with a \`dev\` or \`start\` script that boots the app, OR a top-level entry like \`main.py\` / \`app.py\` / \`server.py\` that runs the app.
- If the current project has no such entry, include a subtask EARLY in the plan that adds one (e.g. "initialise package.json with a 'dev' script that runs the entry point").

Output ONLY the JSON object as your final message. Nothing else.`;

const REPLAN_SYSTEM_PROMPT = `You are the Architect doing a ROLLING replan. The Specialist has executed prior subtasks and the Reviewer signed off on each. You now look at the actual codebase and decide:
(a) the task is complete — return { "done": true, "summary": "..." }, OR
(b) more work is needed — return the NEXT 1-3 subtasks aligned with the original task.

Mandatory steps before deciding:
1. Re-read the original task description.
2. Inspect the working directory. Run \`ls\`, read changed files, and verify what the Specialist actually built.
3. If the project has a quick-to-run check (e.g. \`npm run typecheck\` or \`npm run build\`), run it to confirm the codebase is still healthy before adding more work.

Output ONLY one of these two JSON shapes (no prose, no fences):

Shape A (more work):
{
  "done": false,
  "subtasks": [
    { "description": "...", "touches": ["..."] }
  ],
  "notes": "3-8 sentences updating what you now know about the codebase: key files, conventions, what's still unclear. This replaces the previous notes for the next replan."
}

Shape B (finished):
{
  "done": true,
  "summary": "one to three sentences describing what was built and why the task is now satisfied.",
  "runCommand": "exact shell command, OR null if there's nothing to run"
}

Hard rules:
- Output AT MOST 3 subtasks per replan.
- Each subtask must be the smallest concrete next step. No mega-subtasks like "build the rest of the app".
- Only mark done when the original task is genuinely satisfied end-to-end, not just because the prior subtasks individually passed.
- **Do not re-emit a plan identical to one that has already been tried and failed.** Previously attempted plan summaries will be listed below when they exist. If the codebase has not meaningfully changed since a failing plan, return a materially different approach (different touches, a different decomposition, or a smaller scouting subtask that unblocks understanding). If you truly cannot make progress without external input, say so concretely in a single subtask that asks for exactly what is missing — do not silently loop the same plan.
- **Reuse prior notes.** If "Architect notes from last replan" is provided below, treat it as ground truth and DO NOT redo the same exploration (do not re-cat files you already noted, do not re-list directories you already mapped). Spend your turns on what changed since then and on producing the JSON. You have a limited turn budget — getting to the JSON output matters more than completeness of exploration.
- If the user has provided hints (listed below), take them seriously: treat them as load-bearing constraints that override your defaults.

Runnability + runCommand (applies whenever the task built or changed app behavior — set runCommand to null only for pure docs/typo/config-comment tasks):
- Before declaring \`done: true\`, verify the project is runnable. The entry can live anywhere in the working directory, not just the root — e.g. \`hello_world/main.py\`, \`apps/server/index.js\`, etc.
- ACTUALLY RUN the command from the project's working directory to confirm it executes without crashing. Do not approve based on file existence alone.
- Set \`runCommand\` to the EXACT shell command that boots the app from the project's working directory. Examples:
  - \`npm run dev\`
  - \`python hello_world/main.py\`
  - \`node apps/server/index.js\`
  - \`uvicorn app:app --reload\`
- If the project still has no working entry, do NOT mark done. Return a subtask that adds one and includes the intended run command in its description.

Output ONLY the JSON. Nothing else.`;

export interface PreviousPlanSummary {
  iteration: number;
  hash: string;
  descriptions: string[];
}

export interface ArchitectPlanWithNotes extends ArchitectPlan {
  notes?: string;
}

export async function runArchitect(
  project: Project,
  task: Task,
  abortSignal?: AbortSignal
): Promise<ArchitectPlanWithNotes> {
  const hintsBlock =
    task.hints.length > 0
      ? `\n\nUser hints (load-bearing — honor these):\n${task.hints.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
      : '';

  const userPrompt = `Project: ${project.name}
Task title: ${task.title}
Task description: ${task.description ?? '(none)'}${hintsBlock}

Explore the project, then output the JSON plan with AT MOST 3 subtasks (the first slice only).`;

  const result = await runAgent({
    taskId: task.id,
    role: 'architect',
    cwd: project.path,
    systemPrompt: INITIAL_SYSTEM_PROMPT,
    prompt: userPrompt,
    maxTurns: 35,
    abortSignal,
    // Cap thinking so the JSON plan doesn't get truncated by the shared
    // output-token budget.
    maxThinkingTokens: 5000,
  });

  const plan = extractJsonPlan(result.finalText);
  if (!plan || !Array.isArray(plan.subtasks) || plan.subtasks.length === 0) {
    const refusal = detectRefusal(result.finalText, { toolCount: result.toolCount });
    if (refusal.refused) {
      throw new ArchitectRefusalError(refusal.matched ?? 'unknown', result.finalText);
    }
    if (!result.finalText.trim()) {
      throw new Error(
        `Architect ran out of turns (${result.turns}) before emitting a plan; ${result.toolCount} tool calls used. Try simplifying the task description or raising maxTurns.`
      );
    }
    throw new Error(`Architect did not produce a valid plan. Got: ${result.finalText.slice(0, 500)}`);
  }
  if (plan.subtasks.length > 3) plan.subtasks = plan.subtasks.slice(0, 3);
  return plan;
}

export type ReplanResult =
  | { done: true; summary: string; runCommand: string | null }
  | { done: false; subtasks: ArchitectPlan['subtasks']; notes?: string };

export async function runArchitectReplan(
  project: Project,
  task: Task,
  history: SubtaskHistoryEntry[],
  abortSignal?: AbortSignal,
  opts: {
    hints?: string[];
    previousPlans?: PreviousPlanSummary[];
    architectNotes?: string | null;
  } = {}
): Promise<ReplanResult> {
  const historyBlock = history
    .map(
      (h) =>
        `${h.index + 1}. ${h.description}
   touches: ${h.touches.join(', ') || '(none listed)'}
   rounds: ${h.rounds} (${h.approved ? 'approved' : 'rejected'})
   summary: ${h.finalSummary.slice(0, 300)}`
    )
    .join('\n');

  const hints = opts.hints ?? task.hints;
  const previousPlans = opts.previousPlans ?? [];

  const hintsBlock =
    hints.length > 0
      ? `\n\nUser hints (load-bearing — honor these):\n${hints.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
      : '';

  const previousPlansBlock =
    previousPlans.length > 0
      ? `\n\nPreviously attempted plans (do NOT repeat verbatim):\n${previousPlans
          .map(
            (p) =>
              `- iteration ${p.iteration} (hash ${p.hash.slice(0, 8)}):\n  ${p.descriptions
                .map((d) => `• ${d}`)
                .join('\n  ')}`
          )
          .join('\n')}`
      : '';

  const notesBlock =
    opts.architectNotes && opts.architectNotes.trim().length > 0
      ? `\n\nArchitect notes from last replan (treat as ground truth — do NOT re-explore what's covered here):\n${opts.architectNotes.trim()}`
      : '';

  const userPrompt = `Project: ${project.name}
Task title: ${task.title}
Task description: ${task.description ?? '(none)'}

Subtasks already completed (${history.length}):
${historyBlock || '(none yet — should not happen on replan)'}${notesBlock}${previousPlansBlock}${hintsBlock}

Inspect the working directory, decide if the original task is satisfied, and output ONE of the two JSON shapes.`;

  const result = await runAgent({
    taskId: task.id,
    role: 'architect',
    cwd: project.path,
    systemPrompt: REPLAN_SYSTEM_PROMPT,
    prompt: userPrompt,
    maxTurns: 35,
    abortSignal,
    maxThinkingTokens: 5000,
  });

  const parsed = extractReplan(result.finalText);
  if (!parsed) {
    const refusal = detectRefusal(result.finalText, { toolCount: result.toolCount });
    if (refusal.refused) {
      throw new ArchitectRefusalError(refusal.matched ?? 'unknown', result.finalText);
    }
    if (!result.finalText.trim()) {
      throw new Error(
        `Architect replan ran out of turns (${result.turns}) before emitting a plan; ${result.toolCount} tool calls used.`
      );
    }
    throw new Error(`Architect replan did not produce valid JSON. Got: ${result.finalText.slice(0, 500)}`);
  }
  if (!parsed.done && parsed.subtasks.length > 3) {
    parsed.subtasks = parsed.subtasks.slice(0, 3);
  }
  return parsed;
}

function extractJsonPlan(text: string): ArchitectPlanWithNotes | null {
  const parsed = extractBalancedJson(text);
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).subtasks)) {
    const obj = parsed as ArchitectPlanWithNotes;
    if (typeof (parsed as any).notes !== 'string') delete (obj as any).notes;
    return obj;
  }
  return null;
}

function normalizeRunCommand(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function extractReplan(text: string): ReplanResult | null {
  const parsed = extractBalancedJson(text) as
    | {
        done?: boolean;
        summary?: unknown;
        runCommand?: unknown;
        run_command?: unknown;
        subtasks?: unknown;
        notes?: unknown;
      }
    | null;
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.done === true) {
    return {
      done: true,
      summary: String(parsed.summary ?? ''),
      runCommand: normalizeRunCommand(parsed.runCommand ?? parsed.run_command),
    };
  }
  if (Array.isArray(parsed.subtasks)) {
    return {
      done: false,
      subtasks: parsed.subtasks as ArchitectPlan['subtasks'],
      notes: typeof parsed.notes === 'string' ? parsed.notes : undefined,
    };
  }
  return null;
}

/**
 * Extract a JSON object from free-form text. Handles:
 * - Optional markdown code fences.
 * - Leading/trailing prose around the object.
 * - Truncated output (missing trailing `}` / `]`) — counts unclosed braces/brackets
 *   while respecting string literals and escapes, then appends the missing closers
 *   and retries the parse.
 */
function extractBalancedJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const source = (fenced ? fenced[1] : text).trim();

  const start = source.indexOf('{');
  if (start < 0) return null;

  try {
    return JSON.parse(source.slice(start));
  } catch {}

  // Walk the string, tracking brace/bracket depth while respecting string escapes.
  // Emit a repaired substring with missing closers appended.
  const out: string[] = [];
  const stack: (']' | '}')[] = [];
  let inStr = false;
  let esc = false;
  let ended = -1;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    out.push(c);
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      stack.pop();
      if (stack.length === 0) { ended = i; break; }
    }
  }

  const candidate = ended >= 0
    ? source.slice(start, ended + 1)
    : out.join('') + (inStr ? '"' : '') + stack.reverse().join('');

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}
