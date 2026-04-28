import type { Project, Subtask, Task } from '../types.js';
import { runAgent } from './runner.js';

const SYSTEM_PROMPT = `You are a Specialist executing ONE concrete subtask in a software project.

Rules:
- Read only the files relevant to this subtask.
- Make the minimal change that satisfies the subtask. Do not expand scope.
- If the project has test/lint commands (visible in package.json scripts), run them after your change.
- When done, write one final short message summarizing what you changed. Do not include preamble.
- If prior reviewer/architect feedback is provided, address every point directly.`;

export interface SpecialistOptions {
  feedback?: string[];
  attempt?: number;
  abortSignal?: AbortSignal;
}

export interface SpecialistResult {
  summary: string;
  toolCount: number;
}

export async function runSpecialist(
  project: Project,
  task: Task,
  subtask: Subtask,
  index: number,
  opts: SpecialistOptions = {}
): Promise<SpecialistResult> {
  const feedbackBlock =
    opts.feedback && opts.feedback.length > 0
      ? `\n\nPRIOR FEEDBACK TO ADDRESS (attempt ${opts.attempt ?? 2}):\n${opts.feedback.map((f, i) => `  ${i + 1}. ${f}`).join('\n')}\n`
      : '';

  const userPrompt = `Parent task: ${task.title}
Subtask ${index + 1}: ${subtask.description}
Files involved (relative paths): ${(subtask.touches ?? []).join(', ') || '(you choose)'}${feedbackBlock}

Execute the subtask now.`;

  const result = await runAgent({
    taskId: task.id,
    role: 'specialist',
    cwd: project.path,
    systemPrompt: SYSTEM_PROMPT,
    prompt: userPrompt,
    maxTurns: 25,
    abortSignal: opts.abortSignal,
  });

  return { summary: result.finalText, toolCount: result.toolCount };
}
