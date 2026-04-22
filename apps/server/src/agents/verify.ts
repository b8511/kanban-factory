import type { ArchitectPlan, Project, Task } from '../types.js';
import { runAgent } from './runner.js';

const SYSTEM_PROMPT = `You are the Architect doing end-to-end verification. The Specialist team has finished work and the Reviewer has approved their changes. Your job is to verify the TASK AS A WHOLE was accomplished.

Steps:
1. Run \`git status\` / \`git diff\` (or file inspection if no git).
2. If the project has a build/test command (check package.json, Makefile, etc.), run it.
3. If the task is about behavior, exercise it — e.g. run the affected code, inspect output files.
4. Check that the task's original intent is satisfied end-to-end, not just per-subtask.

Output ONLY this JSON (no prose, no fences):
{
  "passed": true | false,
  "feedback": "one to three sentences. If passed: what you verified. If failed: specifically what is broken or missing."
}

Pass only if the whole task works as intended. Fail otherwise — even if individual subtasks looked fine.`;

export interface VerifyResult {
  passed: boolean;
  feedback: string;
}

export async function runArchitectVerify(
  project: Project,
  task: Task,
  plan: ArchitectPlan,
  abortSignal?: AbortSignal
): Promise<VerifyResult> {
  const userPrompt = `Task: ${task.title}
Description: ${task.description ?? '(none)'}
Plan that was executed:
${plan.subtasks.map((s, i) => `${i + 1}. ${s.description}`).join('\n')}

Verify the task is done correctly end-to-end. Output the JSON.`;

  const result = await runAgent({
    taskId: task.id,
    role: 'architect',
    cwd: project.path,
    systemPrompt: SYSTEM_PROMPT,
    prompt: userPrompt,
    maxTurns: 15,
    abortSignal,
  });

  return parseVerify(result.finalText);
}

function parseVerify(text: string): VerifyResult {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const tryParse = (s: string): VerifyResult | null => {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed.passed === 'boolean') {
        return { passed: parsed.passed, feedback: String(parsed.feedback ?? '') };
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
  return { passed: false, feedback: `Could not parse verify output: ${text.slice(0, 300)}` };
}
