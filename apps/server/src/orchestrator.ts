import { store } from './db.js';
import { broadcast } from './ws.js';
import { runArchitect, runArchitectReplan } from './agents/architect.js';
import { runSpecialist } from './agents/specialist.js';
import { runReviewer } from './agents/reviewer.js';
import { scoutProject } from './routes/ideas.js';
import type {
  ArchitectPlan,
  Subtask,
  SubtaskHistoryEntry,
  TaskStatus,
  Project,
  Task,
  ReviewResult,
} from './types.js';

const MAX_SUBTASK_ROUNDS = 3;
const MAX_REPLAN_ITERATIONS = 12;
const running = new Map<string, AbortController>();

export function cancelTask(taskId: string): boolean {
  const controller = running.get(taskId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function isRunning(taskId: string): boolean {
  return running.has(taskId);
}

function setStatus(taskId: string, status: TaskStatus): void {
  store.setTaskStatus(taskId, status);
  const task = store.getTask(taskId);
  if (task) {
    broadcast({ type: 'task_updated', taskId, projectId: task.projectId, payload: task });
  }
}

function failTask(taskId: string, reason: string): void {
  store.setTaskFailure(taskId, reason);
  setStatus(taskId, 'needs_attention');
}

function broadcastPhase(taskId: string, phase: string, detail: unknown): void {
  broadcast({ type: 'message', taskId, payload: { phase, detail } });
}

function persistProgress(taskId: string, history: SubtaskHistoryEntry[]): void {
  store.setTaskProgress(taskId, JSON.stringify(history));
  const task = store.getTask(taskId);
  if (task) {
    broadcast({ type: 'task_updated', taskId, projectId: task.projectId, payload: task });
  }
}

interface SubtaskResult {
  approved: boolean;
  rounds: number;
  finalSummary: string;
  lastReview: ReviewResult;
}

async function runSubtaskWithReviewLoop(
  project: Project,
  task: Task,
  subtask: Subtask,
  globalIndex: number,
  totalSoFar: number,
  signal: AbortSignal
): Promise<SubtaskResult> {
  const feedback: string[] = [];
  let lastReview: ReviewResult = {
    approved: false,
    severity: 'blocker',
    feedback: 'no review yet',
  };
  let lastSummary = '';

  for (let round = 1; round <= MAX_SUBTASK_ROUNDS; round++) {
    if (signal.aborted) throw new Error('aborted');

    setStatus(task.id, 'in_progress');
    broadcastPhase(task.id, 'subtask_start', {
      subtaskIndex: globalIndex,
      description: subtask.description,
      round,
      maxRounds: MAX_SUBTASK_ROUNDS,
    });

    lastSummary = await runSpecialist(project, task, subtask, globalIndex, {
      feedback,
      attempt: round,
      abortSignal: signal,
    });

    if (signal.aborted) throw new Error('aborted');

    setStatus(task.id, 'review');
    lastReview = await runReviewer(project, task, { subtasks: [subtask] }, signal, {
      subtask,
      index: globalIndex,
      total: totalSoFar,
      specialistSummary: lastSummary,
    });

    broadcast({
      type: 'subtask_progress',
      taskId: task.id,
      projectId: task.projectId,
      payload: {
        subtaskIndex: globalIndex,
        description: subtask.description,
        round,
        maxRounds: MAX_SUBTASK_ROUNDS,
        approved: lastReview.approved,
        severity: lastReview.severity,
        feedback: lastReview.feedback,
        suggestedChanges: lastReview.suggestedChanges,
      },
    });
    broadcastPhase(task.id, 'subtask_review', {
      subtaskIndex: globalIndex,
      round,
      review: lastReview,
    });

    if (lastReview.approved) {
      return { approved: true, rounds: round, finalSummary: lastSummary, lastReview };
    }

    feedback.push(
      `Round ${round} reviewer (${lastReview.severity}): ${lastReview.feedback}` +
        (lastReview.suggestedChanges?.length
          ? `\nSuggested changes:\n- ${lastReview.suggestedChanges.join('\n- ')}`
          : '')
    );
  }

  return { approved: false, rounds: MAX_SUBTASK_ROUNDS, finalSummary: lastSummary, lastReview };
}

export async function runTask(taskId: string): Promise<void> {
  if (running.has(taskId)) throw new Error(`task ${taskId} is already running`);

  const task = store.getTask(taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  const project = store.getProject(task.projectId);
  if (!project) throw new Error(`project ${task.projectId} not found`);

  store.setTaskProgress(taskId, JSON.stringify([]));
  store.setTaskFailure(taskId, null);

  const controller = new AbortController();
  running.set(taskId, controller);
  const signal = controller.signal;

  const history: SubtaskHistoryEntry[] = [];

  try {
    setStatus(taskId, 'planning');
    let plan: ArchitectPlan = await runArchitect(project, task, signal);
    store.setTaskPlan(taskId, JSON.stringify(plan));
    broadcastPhase(taskId, 'plan_ready', { iteration: 0, subtasks: plan.subtasks });

    let iteration = 0;
    let lastFailure = '';

    while (iteration < MAX_REPLAN_ITERATIONS) {
      if (signal.aborted) throw new Error('aborted');

      for (let i = 0; i < plan.subtasks.length; i++) {
        if (signal.aborted) throw new Error('aborted');
        const subtask = plan.subtasks[i];
        const globalIndex = history.length;
        const result = await runSubtaskWithReviewLoop(
          project,
          task,
          subtask,
          globalIndex,
          globalIndex + 1,
          signal
        );

        history.push({
          index: globalIndex,
          description: subtask.description,
          touches: subtask.touches ?? [],
          rounds: result.rounds,
          approved: result.approved,
          lastFeedback: result.lastReview.feedback,
          finalSummary: result.finalSummary,
        });
        persistProgress(taskId, history);

        if (!result.approved) {
          lastFailure = `Subtask ${globalIndex + 1} ("${subtask.description.slice(0, 80)}") failed review after ${result.rounds} rounds: ${result.lastReview.feedback}`;
          broadcastPhase(taskId, 'exhausted', { iteration, lastFailure });
          failTask(taskId, lastFailure);
          return;
        }
      }

      iteration++;
      setStatus(taskId, 'planning');
      broadcastPhase(taskId, 'replan_start', { iteration });
      const next = await runArchitectReplan(project, task, history, signal);

      if (next.done) {
        if (next.runCommand) {
          store.setProjectRunCommand(project.id, next.runCommand);
          const updatedProject = store.getProject(project.id);
          if (updatedProject) {
            broadcast({
              type: 'project_updated',
              projectId: updatedProject.id,
              payload: updatedProject,
            });
          }
        }
        broadcastPhase(taskId, 'replan_done', {
          iteration,
          summary: next.summary,
          runCommand: next.runCommand,
        });
        setStatus(taskId, 'done');
        scoutProject(project.id, `after task "${task.title.slice(0, 40)}"`).catch((err) =>
          console.error('[orchestrator] idea scout failed:', err)
        );
        return;
      }

      if (next.subtasks.length === 0) {
        lastFailure = `Architect replan returned no subtasks but did not declare done.`;
        broadcastPhase(taskId, 'exhausted', { iteration, lastFailure });
        failTask(taskId, lastFailure);
        return;
      }

      plan = { subtasks: next.subtasks };
      store.setTaskPlan(taskId, JSON.stringify(plan));
      broadcastPhase(taskId, 'plan_ready', { iteration, subtasks: plan.subtasks });
    }

    lastFailure = `Hit max replan iterations (${MAX_REPLAN_ITERATIONS}) without completion.`;
    broadcastPhase(taskId, 'exhausted', { iteration, lastFailure });
    failTask(taskId, lastFailure);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (signal.aborted) {
      broadcastPhase(taskId, 'cancelled', { message });
      failTask(taskId, `Cancelled: ${message}`);
    } else {
      broadcastPhase(taskId, 'error', { message });
      failTask(taskId, `Error: ${message}`);
    }
  } finally {
    running.delete(taskId);
  }
}
