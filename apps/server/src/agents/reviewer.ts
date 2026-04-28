import type {
  ArchitectPlan,
  Project,
  ReviewResult,
  ReviewSeverity,
  ReviewerRigor,
  Subtask,
  Task,
} from '../types.js';
import { runAgent } from './runner.js';

const STRICT_PROMPT = `You are a STRICT Reviewer. A Specialist just finished work. Your job is to verify the change actually does what was asked — not just that files were touched.

Mandatory steps (skipping any of these means you cannot approve):
1. Run \`git status\` and \`git diff\` to see exactly what changed. If not a git repo, list the touched files and read each one in full.
2. Read every changed file end-to-end. Do not skim.
3. If the project has a \`package.json\`, run the relevant scripts among: \`npm run typecheck\`, \`npm run lint\`, \`npm test\`, \`npm run build\`. Skip a script only if it does not exist.
4. If the change is behavioral (a script, a feature, a CLI, a server), EXERCISE it. Run the entry point, hit the endpoint, invoke the function. Do not assume it works because the file exists.
5. Compare what you observed to what the task description asked for. Functional gap = reject.

Approval rules (STRICT):
- Approving prematurely is WORSE than rejecting. When in doubt, reject.
- Reject if: code does not run, tests/lint/typecheck fail, the change misses a stated requirement, the diff has unrelated edits, error handling for the asked-for behavior is missing, or you could not actually exercise the behavior.
- Approve only if you observed the behavior working AND every available script passed.

Output ONLY this JSON (no prose, no fences):
{
  "approved": true | false,
  "severity": "blocker" | "major" | "minor" | "none",
  "feedback": "two to four sentences. State exactly what you ran/inspected and what you saw. If rejecting, be concrete about what to fix.",
  "suggested_changes": ["short imperative bullet 1", "short imperative bullet 2"]
}

Severity guide: "blocker" = doesn't run / wrong behavior; "major" = missing requirement; "minor" = polish only (you may still approve with minor); "none" = clean approval.
If approved is true, severity must be "none" or "minor". If approved is false, severity must be "blocker" or "major".`;

const NORMAL_PROMPT = `You are a Reviewer (NORMAL rigor). A Specialist just finished work. Verify the change does what was asked.

Mandatory steps:
1. Run \`git status\` and \`git diff\` (or list and read touched files if there's no git).
2. Read every changed file end-to-end.
3. If a \`package.json\` exists, run the most relevant script for the change (typically \`npm run build\` or \`npm test\`). You may skip lint/typecheck for pure behavior changes if running them would duplicate effort.
4. If the change is behavioral, exercise it: run the entry point or hit the endpoint.
5. Compare observed behavior to the task description.

Approval rules (NORMAL):
- Approve if the behavior works and no required script you ran failed. Minor polish issues (style, small unused imports, small docs gaps) are approvable with a note.
- Reject for "blocker" or "major" severity only.

Output ONLY this JSON (no prose, no fences):
{
  "approved": true | false,
  "severity": "blocker" | "major" | "minor" | "none",
  "feedback": "two to four sentences. State what you ran/inspected and what you saw. If rejecting, be concrete about the fix.",
  "suggested_changes": ["short imperative bullet 1", "short imperative bullet 2"]
}

Severity guide: "blocker" = doesn't run / wrong behavior; "major" = missing requirement; "minor" = polish only; "none" = clean approval.
If approved is true, severity must be "none" or "minor". If approved is false, severity must be "blocker" or "major".`;

const LENIENT_PROMPT = `You are a Reviewer (LENIENT rigor). A Specialist just finished work. You are optimizing for momentum: ship it unless it's actually broken.

Mandatory steps:
1. Run \`git status\` / \`git diff\` (or list touched files).
2. Skim each changed file for obvious errors.
3. Quickly try to run or import the changed code to confirm it's not syntactically broken.

Approval rules (LENIENT):
- Approve if the code runs and obviously addresses the subtask. "major" with a clear fix-forward note is still approvable (surface it in feedback so the next iteration can address it).
- Only reject for "blocker" — i.e., the code doesn't run, actively breaks the project, or completely ignores the subtask.
- Do NOT reject for style, missing tests, missing docs, or minor polish concerns.

Output ONLY this JSON (no prose, no fences):
{
  "approved": true | false,
  "severity": "blocker" | "major" | "minor" | "none",
  "feedback": "one to three sentences. If approving with known gaps, call them out concisely.",
  "suggested_changes": ["short imperative bullet 1"]
}

Severity guide: "blocker" = doesn't run / actively broken; "major" = missing requirement (still approvable in lenient mode if not breaking); "minor" = polish; "none" = clean.
If approved is true, severity may be "none", "minor", or "major". If approved is false, severity must be "blocker".`;

function promptForRigor(rigor: ReviewerRigor): string {
  switch (rigor) {
    case 'lenient':
      return LENIENT_PROMPT;
    case 'strict':
      return STRICT_PROMPT;
    default:
      return NORMAL_PROMPT;
  }
}

export interface PerSubtaskReviewInput {
  subtask: Subtask;
  index: number;
  total: number;
  specialistSummary: string;
}

export async function runReviewer(
  project: Project,
  task: Task,
  plan: ArchitectPlan,
  abortSignal?: AbortSignal,
  perSubtask?: PerSubtaskReviewInput,
  rigor: ReviewerRigor = 'normal'
): Promise<ReviewResult> {
  const userPrompt = perSubtask
    ? `Task: ${task.title}
Description: ${task.description ?? '(none)'}
Reviewer rigor: ${rigor.toUpperCase()}

You are reviewing ONE subtask out of the rolling plan. Focus your review on this subtask only — do not require the whole task to be done yet.

Subtask ${perSubtask.index + 1} of ${perSubtask.total}: ${perSubtask.subtask.description}
Files claimed (touches): ${(perSubtask.subtask.touches ?? []).join(', ') || '(specialist chose)'}

Specialist's summary of what they did:
${perSubtask.specialistSummary || '(no summary)'}

Inspect the project, exercise what changed, and output the review JSON.`
    : `Task: ${task.title}
Description: ${task.description ?? '(none)'}
Reviewer rigor: ${rigor.toUpperCase()}

You are doing the FINAL holistic review. The full plan has been executed:
${plan.subtasks.map((s, i) => `${i + 1}. ${s.description} (touches: ${(s.touches ?? []).join(', ')})`).join('\n')}

Verify the entire task is done correctly end-to-end. Output the review JSON.`;

  const result = await runAgent({
    taskId: task.id,
    role: 'reviewer',
    cwd: project.path,
    systemPrompt: promptForRigor(rigor),
    prompt: userPrompt,
    maxTurns: 20,
    abortSignal,
    // JSON-only output — keep thinking bounded so the verdict isn't truncated.
    maxThinkingTokens: 6000,
  });

  return parseReview(result.finalText);
}

function normalizeSeverity(s: unknown, approved: boolean): ReviewSeverity {
  const str = typeof s === 'string' ? s.toLowerCase() : '';
  if (str === 'blocker' || str === 'major' || str === 'minor' || str === 'none') return str;
  return approved ? 'none' : 'major';
}

function normalizeSuggestions(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter((x) => x.length > 0);
  return out.length > 0 ? out : undefined;
}

function parseReview(text: string): ReviewResult {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const tryParse = (s: string): ReviewResult | null => {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed.approved === 'boolean') {
        return {
          approved: parsed.approved,
          severity: normalizeSeverity(parsed.severity, parsed.approved),
          feedback: String(parsed.feedback ?? ''),
          suggestedChanges: normalizeSuggestions(parsed.suggested_changes ?? parsed.suggestedChanges),
        };
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
  return {
    approved: false,
    severity: 'blocker',
    feedback: `Could not parse reviewer output: ${text.slice(0, 300)}`,
  };
}
