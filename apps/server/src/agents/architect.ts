import type { ArchitectPlan, Project, SubtaskHistoryEntry, Task } from '../types.js';
import { runAgent } from './runner.js';

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
  ]
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
  ]
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

export async function runArchitect(
  project: Project,
  task: Task,
  abortSignal?: AbortSignal
): Promise<ArchitectPlan> {
  const userPrompt = `Project: ${project.name}
Task title: ${task.title}
Task description: ${task.description ?? '(none)'}

Explore the project, then output the JSON plan with AT MOST 3 subtasks (the first slice only).`;

  const result = await runAgent({
    taskId: task.id,
    role: 'architect',
    cwd: project.path,
    systemPrompt: INITIAL_SYSTEM_PROMPT,
    prompt: userPrompt,
    maxTurns: 15,
    abortSignal,
  });

  const plan = extractJsonPlan(result.finalText);
  if (!plan || !Array.isArray(plan.subtasks) || plan.subtasks.length === 0) {
    throw new Error(`Architect did not produce a valid plan. Got: ${result.finalText.slice(0, 500)}`);
  }
  if (plan.subtasks.length > 3) plan.subtasks = plan.subtasks.slice(0, 3);
  return plan;
}

export type ReplanResult =
  | { done: true; summary: string; runCommand: string | null }
  | { done: false; subtasks: ArchitectPlan['subtasks'] };

export async function runArchitectReplan(
  project: Project,
  task: Task,
  history: SubtaskHistoryEntry[],
  abortSignal?: AbortSignal
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

  const userPrompt = `Project: ${project.name}
Task title: ${task.title}
Task description: ${task.description ?? '(none)'}

Subtasks already completed (${history.length}):
${historyBlock || '(none yet — should not happen on replan)'}

Inspect the working directory, decide if the original task is satisfied, and output ONE of the two JSON shapes.`;

  const result = await runAgent({
    taskId: task.id,
    role: 'architect',
    cwd: project.path,
    systemPrompt: REPLAN_SYSTEM_PROMPT,
    prompt: userPrompt,
    maxTurns: 20,
    abortSignal,
  });

  const parsed = extractReplan(result.finalText);
  if (!parsed) {
    throw new Error(`Architect replan did not produce valid JSON. Got: ${result.finalText.slice(0, 500)}`);
  }
  if (!parsed.done && parsed.subtasks.length > 3) {
    parsed.subtasks = parsed.subtasks.slice(0, 3);
  }
  return parsed;
}

function extractJsonPlan(text: string): ArchitectPlan | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && Array.isArray(parsed.subtasks)) return parsed as ArchitectPlan;
  } catch {}
  const braceStart = candidate.indexOf('{');
  const braceEnd = candidate.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) {
    try {
      const parsed = JSON.parse(candidate.slice(braceStart, braceEnd + 1));
      if (parsed && Array.isArray(parsed.subtasks)) return parsed as ArchitectPlan;
    } catch {}
  }
  return null;
}

function normalizeRunCommand(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function extractReplan(text: string): ReplanResult | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const tryParse = (s: string): ReplanResult | null => {
    try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === 'object') {
        if (parsed.done === true) {
          return {
            done: true,
            summary: String(parsed.summary ?? ''),
            runCommand: normalizeRunCommand(parsed.runCommand ?? parsed.run_command),
          };
        }
        if (parsed.done === false && Array.isArray(parsed.subtasks)) {
          return { done: false, subtasks: parsed.subtasks };
        }
        if (Array.isArray(parsed.subtasks)) {
          return { done: false, subtasks: parsed.subtasks };
        }
      }
    } catch {}
    return null;
  };
  const direct = tryParse(candidate);
  if (direct) return direct;
  const braceStart = candidate.indexOf('{');
  const braceEnd = candidate.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) {
    const sliced = tryParse(candidate.slice(braceStart, braceEnd + 1));
    if (sliced) return sliced;
  }
  return null;
}
