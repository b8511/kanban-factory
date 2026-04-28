import type { Project } from '../types.js';
import { runAgent } from './runner.js';

const SYSTEM_PROMPT = `You are the Idea Scout. Your job is to study a software project and propose 1–3 concrete NEW ideas that would genuinely improve it — features, refactors, tests, UX polish, safety rails, observability, small-but-high-value tweaks.

Mandatory steps before proposing:
1. Explore the project's working directory. Run \`ls\`, read any CLAUDE.md, README.md, package.json, and skim the tree.
2. Read the list of recent DONE tasks (provided in the user prompt) so you don't re-propose work already finished.
3. Read the list of PENDING ideas (provided) so you don't duplicate existing suggestions.
4. Read the list of RECENTLY REJECTED ideas (provided) so you do NOT propose them again.

Rules for each idea:
- It must be a concrete, actionable improvement the user could approve and hand to the Architect/Specialist.
- It must NOT require information you don't have (no "ask user what they want").
- It must NOT be a duplicate of pending or recently rejected ideas.
- Prefer small, high-signal ideas over grand rewrites.
- Mix categories: at most one "new feature", rest should be quality/tests/docs/UX/safety.

Output ONLY this JSON (no markdown, no prose, no fences):
{
  "ideas": [
    {
      "title": "imperative, 4-8 word title",
      "description": "2-4 sentences: what to do and how. Concrete enough that a Specialist could execute it.",
      "rationale": "1-2 sentences: why this matters for this specific project (reference what you observed)."
    }
  ]
}

Output 1-3 ideas. Zero is fine if the project is genuinely in a good place — in that case return {"ideas": []}.`;

export interface IdeaSuggestion {
  title: string;
  description: string;
  rationale: string;
}

export interface ScoutContext {
  doneTasks: Array<{ title: string; description: string | null }>;
  pendingIdeas: Array<{ title: string; description: string }>;
  rejectedIdeas: Array<{ title: string; description: string }>;
}

export async function runIdeaScout(
  project: Project,
  taskIdForLogs: string,
  context: ScoutContext,
  abortSignal?: AbortSignal
): Promise<IdeaSuggestion[]> {
  const fmtList = (items: Array<{ title: string; description: string | null }>) =>
    items.length === 0
      ? '(none)'
      : items.map((t, i) => `${i + 1}. ${t.title}${t.description ? ` — ${t.description.slice(0, 120)}` : ''}`).join('\n');

  const userPrompt = `Project: ${project.name}
Working directory: ${project.path}

DONE tasks (${context.doneTasks.length}):
${fmtList(context.doneTasks)}

PENDING ideas awaiting approval (${context.pendingIdeas.length}) — do not duplicate:
${fmtList(context.pendingIdeas)}

RECENTLY REJECTED ideas (${context.rejectedIdeas.length}) — do NOT propose these again:
${fmtList(context.rejectedIdeas)}

Explore the project, then output the JSON with 1-3 fresh ideas (or empty if truly nothing useful to add).`;

  const result = await runAgent({
    taskId: taskIdForLogs,
    role: 'architect',
    cwd: project.path,
    systemPrompt: SYSTEM_PROMPT,
    prompt: userPrompt,
    maxTurns: 15,
    abortSignal,
    // Scout isn't tied to a real task row; skip DB recording to avoid the
    // agent_runs.task_id FK constraint violation.
    skipDbRecording: true,
  });

  return parseIdeas(result.finalText);
}

function parseIdeas(text: string): IdeaSuggestion[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const tryParse = (s: string): IdeaSuggestion[] | null => {
    try {
      const parsed = JSON.parse(s);
      if (parsed && Array.isArray(parsed.ideas)) {
        return parsed.ideas
          .map((i: any) => ({
            title: String(i?.title ?? '').trim(),
            description: String(i?.description ?? '').trim(),
            rationale: String(i?.rationale ?? '').trim(),
          }))
          .filter((i: IdeaSuggestion) => i.title && i.description);
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
  return [];
}
