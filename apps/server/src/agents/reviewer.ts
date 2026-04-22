import type { ArchitectPlan, Project, ReviewResult, ReviewSeverity, Subtask, Task } from '../types.js';
import { runAgent } from './runner.js';

const STRICT_PROMPT = `You are a STRICT Reviewer. A Specialist just finished work. Your job is to verify the change actually does what was asked — not just that files were touched.

Mandatory steps (skipping any of these means you cannot approve):
1. Run \`git status\` and \`git diff\` to see exactly what changed. If not a git repo, list the touched files and read each one in full.
2. Read every changed file end-to-end. Do not skim.
3. If the project has a \`package.json\`, run the relevant scripts among: \`npm run typecheck\`, \`npm run lint\`, \`npm test\`, \`npm run build\`. Skip a script only if it does not exist.
4. If the change is behavioral (a script, a feature, a CLI, a server), EXERCISE it. Run the entry point, hit the endpoint, invoke the function. Do not assume it works because the file exists.
5. Compare what you observed to what the task description asked for. Functional gap = reject.

Approval rules:
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
  perSubtask?: PerSubtaskReviewInput
): Promise<ReviewResult> {
  const userPrompt = perSubtask
    ? `Task: ${task.title}
Description: ${task.description ?? '(none)'}

You are reviewing ONE subtask out of the rolling plan. Focus your review on this subtask only — do not require the whole task to be done yet.

Subtask ${perSubtask.index + 1} of ${perSubtask.total}: ${perSubtask.subtask.description}
Files claimed (touches): ${(perSubtask.subtask.touches ?? []).join(', ') || '(specialist chose)'}

Specialist's summary of what they did:
${perSubtask.specialistSummary || '(no summary)'}

Inspect the project, exercise what changed, and output the review JSON.`
    : `Task: ${task.title}
Description: ${task.description ?? '(none)'}

You are doing the FINAL holistic review. The full plan has been executed:
${plan.subtasks.map((s, i) => `${i + 1}. ${s.description} (touches: ${(s.touches ?? []).join(', ')})`).join('\n')}

Verify the entire task is done correctly end-to-end. Output the review JSON.`;

  const result = await runAgent({
    taskId: task.id,
    role: 'reviewer',
    cwd: project.path,
    systemPrompt: STRICT_PROMPT,
    prompt: userPrompt,
    maxTurns: 20,
    abortSignal,
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
