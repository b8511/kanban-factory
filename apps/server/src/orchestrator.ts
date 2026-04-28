import crypto from 'node:crypto';
import { store } from './db.js';
import { broadcast } from './ws.js';
import {
  runArchitect,
  runArchitectReplan,
  type PreviousPlanSummary,
} from './agents/architect.js';
import { runSpecialist } from './agents/specialist.js';
import { runReviewer } from './agents/reviewer.js';
import { ArchitectRefusalError, detectRefusal } from './agents/refusal.js';
import { scoutProject } from './routes/ideas.js';
import type {
  AgentRole,
  ArchitectPlan,
  Escalation,
  Project,
  ReviewResult,
  ReviewerRigor,
  Subtask,
  SubtaskHistoryEntry,
  Task,
  TaskStatus,
} from './types.js';

const MAX_SUBTASK_ROUNDS = 3;
const MAX_REPLAN_ITERATIONS = 6;
const running = new Map<string, AbortController>();
const gracefulStops = new Set<string>();

export function cancelTask(taskId: string): boolean {
  const controller = running.get(taskId);
  if (!controller) return false;
  controller.abort();
  gracefulStops.delete(taskId);
  return true;
}

export function isRunning(taskId: string): boolean {
  return running.has(taskId);
}

/**
 * Mark a running task for graceful stop: let the in-flight subtask round
 * (specialist → reviewer) complete, then mark the task done — no more retries
 * and no replan. If the task is between subtasks (architect mid-replan), the
 * stop applies at the next subtask boundary. Returns false if not running.
 */
export function requestGracefulStop(taskId: string): boolean {
  if (!running.has(taskId)) return false;
  gracefulStops.add(taskId);
  return true;
}

export function isGracefulStop(taskId: string): boolean {
  return gracefulStops.has(taskId);
}

function hashPlan(plan: ArchitectPlan): string {
  const normalized = plan.subtasks
    .map((s) => s.description.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,;:]+\s*$/g, '').trim())
    .join('||');
  return crypto.createHash('sha1').update(normalized).digest('hex');
}

function collectTouches(history: SubtaskHistoryEntry[]): string[] {
  const set = new Set<string>();
  for (const h of history) for (const t of h.touches) set.add(t);
  return [...set];
}

function sameBlocker(reviews: ReviewResult[]): boolean {
  if (reviews.length < 3) return false;
  const last3 = reviews.slice(-3);
  const sig = (r: ReviewResult) => `${r.severity}|${(r.feedback ?? '').slice(0, 80).toLowerCase().trim()}`;
  const s0 = sig(last3[0]);
  return last3.every((r) => !r.approved && sig(r) === s0);
}

function resolveEffectiveRigor(task: Task, project: Project): ReviewerRigor {
  return task.reviewerRigor ?? project.reviewerRigor ?? 'normal';
}

function emitPhase(
  taskId: string,
  projectId: string,
  phase: string,
  detail: unknown,
  role?: AgentRole
): void {
  store.insertTaskEvent({ taskId, projectId, phase, role: role ?? null, payload: detail });
  broadcast({
    type: 'message',
    taskId,
    projectId,
    role,
    payload: { phase, detail },
  });
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

function persistProgress(taskId: string, history: SubtaskHistoryEntry[]): void {
  store.setTaskProgress(taskId, JSON.stringify(history));
  const task = store.getTask(taskId);
  if (task) {
    broadcast({ type: 'task_updated', taskId, projectId: task.projectId, payload: task });
  }
}

function maybeEscalate(
  task: Task,
  input: { reason: string; kind: Escalation['kind']; iteration: number }
): void {
  const escalation: Escalation = {
    reason: input.reason,
    kind: input.kind,
    raisedAt: new Date().toISOString(),
    iteration: input.iteration,
  };
  store.setTaskEscalation(task.id, escalation);
  store.setTaskFailure(task.id, `Stuck: ${input.reason}`);
  emitPhase(task.id, task.projectId, 'escalation_raised', escalation);
  broadcast({
    type: 'escalation_raised',
    taskId: task.id,
    projectId: task.projectId,
    payload: escalation,
  });
  setStatus(task.id, 'needs_attention');
}

interface SubtaskResult {
  approved: boolean;
  rounds: number;
  finalSummary: string;
  lastReview: ReviewResult;
  reviews: ReviewResult[];
  refusalStreak: number;
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
  const reviews: ReviewResult[] = [];
  let lastReview: ReviewResult = {
    approved: false,
    severity: 'blocker',
    feedback: 'no review yet',
  };
  let lastSummary = '';
  let refusalStreak = 0;

  for (let round = 1; round <= MAX_SUBTASK_ROUNDS; round++) {
    if (signal.aborted) throw new Error('aborted');

    const currentTask = store.getTask(task.id) ?? task;
    const currentProject = store.getProject(project.id) ?? project;
    const effectiveRigor = resolveEffectiveRigor(currentTask, currentProject);

    setStatus(task.id, 'in_progress');
    emitPhase(task.id, task.projectId, 'subtask_start', {
      subtaskIndex: globalIndex,
      description: subtask.description,
      round,
      maxRounds: MAX_SUBTASK_ROUNDS,
      rigor: effectiveRigor,
    });

    const specialistResult = await runSpecialist(project, task, subtask, globalIndex, {
      feedback,
      attempt: round,
      abortSignal: signal,
    });
    lastSummary = specialistResult.summary;

    if (signal.aborted) throw new Error('aborted');

    // Refusal short-circuit: if the specialist produced no tool calls AND its
    // summary looks like a policy refusal, skip the expensive reviewer call.
    const refusal = detectRefusal(lastSummary, { toolCount: specialistResult.toolCount });
    if (refusal.refused) {
      refusalStreak++;
      lastReview = {
        approved: false,
        severity: 'blocker',
        feedback: `Specialist declined to implement this subtask (matched phrase: "${refusal.matched}"). If this is a legitimate engineering task, please complete the work.`,
        suggestedChanges: ['Write the actual code requested in the subtask.'],
      };
      reviews.push(lastReview);

      store.insertSubtaskReview({
        taskId: task.id,
        subtaskIndex: globalIndex,
        round,
        approved: false,
        severity: 'blocker',
        feedback: `[refusal short-circuit] ${lastReview.feedback}`,
        suggestedChanges: lastReview.suggestedChanges,
        specialistSummary: lastSummary,
        rigor: effectiveRigor,
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
          approved: false,
          severity: 'blocker',
          feedback: lastReview.feedback,
          suggestedChanges: lastReview.suggestedChanges,
          rigor: effectiveRigor,
          refusal: true,
        },
      });
      emitPhase(task.id, task.projectId, 'subtask_review', {
        subtaskIndex: globalIndex,
        round,
        review: lastReview,
        rigor: effectiveRigor,
        refusal: true,
        matched: refusal.matched,
      });

      // Two refusals in a row → escalate immediately, don't burn another round.
      if (refusalStreak >= 2) {
        return {
          approved: false,
          rounds: round,
          finalSummary: lastSummary,
          lastReview,
          reviews,
          refusalStreak,
        };
      }

      feedback.push(
        `Round ${round}: specialist refused on policy grounds ("${refusal.matched}"). Please complete the task — this is legitimate engineering work.`
      );
      continue; // try another round; skip the reviewer call
    }

    refusalStreak = 0;

    setStatus(task.id, 'review');
    lastReview = await runReviewer(
      project,
      task,
      { subtasks: [subtask] },
      signal,
      { subtask, index: globalIndex, total: totalSoFar, specialistSummary: lastSummary },
      effectiveRigor
    );

    // Lenient convenience: approve a rejected-minor outcome
    if (
      effectiveRigor === 'lenient' &&
      !lastReview.approved &&
      lastReview.severity === 'minor'
    ) {
      lastReview = { ...lastReview, approved: true };
    }

    reviews.push(lastReview);

    store.insertSubtaskReview({
      taskId: task.id,
      subtaskIndex: globalIndex,
      round,
      approved: lastReview.approved,
      severity: lastReview.severity,
      feedback: lastReview.feedback,
      suggestedChanges: lastReview.suggestedChanges,
      specialistSummary: lastSummary,
      rigor: effectiveRigor,
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
        rigor: effectiveRigor,
      },
    });
    emitPhase(task.id, task.projectId, 'subtask_review', {
      subtaskIndex: globalIndex,
      round,
      review: lastReview,
      rigor: effectiveRigor,
    });

    if (lastReview.approved) {
      return {
        approved: true,
        rounds: round,
        finalSummary: lastSummary,
        lastReview,
        reviews,
        refusalStreak,
      };
    }

    // Graceful stop requested mid-task: the user has decided "stop here, it's good".
    // Honor the current reviewer verdict, exit the round loop, and let the outer
    // runTask loop see the graceful flag to mark the task done.
    if (isGracefulStop(task.id)) {
      return {
        approved: lastReview.approved,
        rounds: round,
        finalSummary: lastSummary,
        lastReview,
        reviews,
        refusalStreak,
      };
    }

    feedback.push(
      `Round ${round} reviewer (${lastReview.severity}): ${lastReview.feedback}` +
        (lastReview.suggestedChanges?.length
          ? `\nSuggested changes:\n- ${lastReview.suggestedChanges.join('\n- ')}`
          : '')
    );

    if (sameBlocker(reviews)) {
      return {
        approved: false,
        rounds: round,
        finalSummary: lastSummary,
        lastReview,
        reviews,
        refusalStreak,
      };
    }
  }

  return {
    approved: false,
    rounds: MAX_SUBTASK_ROUNDS,
    finalSummary: lastSummary,
    lastReview,
    reviews,
    refusalStreak,
  };
}

interface RunTaskOptions {
  initialPlan?: ArchitectPlan; // when provided, skip initial architect call
  extraHint?: string; // appended to task.hints for this run only (persisted via appendTaskHint caller)
}

export async function runTask(taskId: string, opts: RunTaskOptions = {}): Promise<void> {
  if (running.has(taskId)) throw new Error(`task ${taskId} is already running`);

  const task = store.getTask(taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  const project = store.getProject(task.projectId);
  if (!project) throw new Error(`project ${task.projectId} not found`);

  // Reset per-run state
  store.setTaskProgress(taskId, JSON.stringify([]));
  store.setTaskFailure(taskId, null);
  store.clearTaskEscalation(taskId);

  const controller = new AbortController();
  running.set(taskId, controller);
  const signal = controller.signal;

  const history: SubtaskHistoryEntry[] = [];
  const planHashes: string[] = [];
  const previousPlans: PreviousPlanSummary[] = [];

  try {
    setStatus(taskId, 'planning');
    let plan: ArchitectPlan;
    if (opts.initialPlan && opts.initialPlan.subtasks.length > 0) {
      plan = opts.initialPlan;
      emitPhase(taskId, task.projectId, 'plan_provided', { subtasks: plan.subtasks }, 'architect');
    } else {
      const result = await runArchitect(project, task, signal);
      plan = { subtasks: result.subtasks };
      if (typeof result.notes === 'string' && result.notes.trim().length > 0) {
        store.setArchitectNotes(taskId, result.notes.trim());
      }
    }
    store.setTaskPlan(taskId, JSON.stringify(plan));
    const firstHash = hashPlan(plan);
    planHashes.push(firstHash);
    store.insertCheckpoint({
      taskId,
      iteration: 0,
      planHash: firstHash,
      plan,
      history,
      touchedFiles: collectTouches(history),
    });
    previousPlans.push({ iteration: 0, hash: firstHash, descriptions: plan.subtasks.map((s) => s.description) });
    emitPhase(taskId, task.projectId, 'plan_ready', {
      iteration: 0,
      subtasks: plan.subtasks,
      planHash: firstHash,
    });

    let iteration = 0;
    let sameplanStreak = 0;

    while (iteration < MAX_REPLAN_ITERATIONS) {
      if (signal.aborted) throw new Error('aborted');

      const touchedBefore = collectTouches(history).length;
      const approvedBefore = history.filter((h) => h.approved).length;

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

        if (isGracefulStop(taskId)) {
          emitPhase(taskId, task.projectId, 'graceful_stop_done', {
            reason: 'User requested stop after current subtask.',
            lastReview: result.lastReview,
            approved: result.approved,
            iteration,
            subtaskIndex: globalIndex,
          });
          store.clearTaskEscalation(taskId);
          store.setTaskFailure(taskId, null);
          setStatus(taskId, 'done');
          gracefulStops.delete(taskId);
          return;
        }

        if (!result.approved) {
          const reviews = result.reviews;
          const blockerLock = sameBlocker(reviews);
          const refusalLock = result.refusalStreak >= 2;

          const reason = refusalLock
            ? `Subtask ${globalIndex + 1} was refused by the specialist on policy grounds two rounds in a row. Last note: "${result.lastReview.feedback.slice(0, 140)}"`
            : blockerLock
              ? `Subtask ${globalIndex + 1} keeps failing with the same blocker: "${result.lastReview.feedback.slice(0, 140)}"`
              : `Subtask ${globalIndex + 1} ("${subtask.description.slice(0, 80)}") failed review after ${result.rounds} rounds: ${result.lastReview.feedback}`;

          const kind: Escalation['kind'] = refusalLock
            ? 'agent_refusal'
            : blockerLock
              ? 'repeating_blocker'
              : 'no_progress';

          const fresh = store.getTask(taskId) ?? task;
          maybeEscalate(fresh, { reason, kind, iteration });
          return;
        }
      }

      iteration++;

      const touchedAfter = collectTouches(history).length;
      const approvedAfter = history.filter((h) => h.approved).length;

      if (isGracefulStop(taskId)) {
        emitPhase(taskId, task.projectId, 'graceful_stop_done', {
          reason: 'User requested stop between replans.',
          iteration,
        });
        store.clearTaskEscalation(taskId);
        store.setTaskFailure(taskId, null);
        setStatus(taskId, 'done');
        gracefulStops.delete(taskId);
        return;
      }

      setStatus(taskId, 'planning');
      emitPhase(taskId, task.projectId, 'replan_start', { iteration });

      const freshTask = store.getTask(taskId) ?? task;
      const next = await runArchitectReplan(project, freshTask, history, signal, {
        hints: freshTask.hints,
        previousPlans,
        architectNotes: freshTask.architectNotes,
      });

      if (!next.done && typeof next.notes === 'string' && next.notes.trim().length > 0) {
        store.setArchitectNotes(taskId, next.notes.trim());
      }

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
        emitPhase(taskId, task.projectId, 'replan_done', {
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
        maybeEscalate(store.getTask(taskId) ?? task, {
          reason: 'Architect replan returned no subtasks but did not declare done.',
          kind: 'no_progress',
          iteration,
        });
        return;
      }

      const nextPlan: ArchitectPlan = { subtasks: next.subtasks };
      const nextHash = hashPlan(nextPlan);

      // Dedup / no-progress detection
      const prevHash = planHashes[planHashes.length - 1];
      if (nextHash === prevHash) {
        sameplanStreak++;
      } else {
        sameplanStreak = 0;
      }

      const noNewFiles = touchedAfter === touchedBefore;
      const noNewApprovals = approvedAfter === approvedBefore;

      if (sameplanStreak >= 2) {
        maybeEscalate(store.getTask(taskId) ?? task, {
          reason: `Architect re-emitted the same plan ${sameplanStreak + 1} times without progress.`,
          kind: 'repeated_plan',
          iteration,
        });
        return;
      }

      if (noNewFiles && noNewApprovals && iteration > 1) {
        maybeEscalate(store.getTask(taskId) ?? task, {
          reason: 'An entire replan iteration produced no approved subtasks and no new touched files.',
          kind: 'no_progress',
          iteration,
        });
        return;
      }

      plan = nextPlan;
      planHashes.push(nextHash);
      store.setTaskPlan(taskId, JSON.stringify(plan));
      store.insertCheckpoint({
        taskId,
        iteration,
        planHash: nextHash,
        plan,
        history,
        touchedFiles: collectTouches(history),
      });
      previousPlans.push({
        iteration,
        hash: nextHash,
        descriptions: plan.subtasks.map((s) => s.description),
      });
      emitPhase(taskId, task.projectId, 'plan_ready', {
        iteration,
        subtasks: plan.subtasks,
        planHash: nextHash,
      });
    }

    maybeEscalate(store.getTask(taskId) ?? task, {
      reason: `Hit max replan iterations (${MAX_REPLAN_ITERATIONS}) without completion.`,
      kind: 'no_progress',
      iteration: MAX_REPLAN_ITERATIONS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (signal.aborted) {
      emitPhase(taskId, task.projectId, 'cancelled', { message });
      failTask(taskId, `Cancelled: ${message}`);
    } else if (err instanceof ArchitectRefusalError) {
      maybeEscalate(store.getTask(taskId) ?? task, {
        reason: `Architect declined to plan this task on policy grounds (matched "${err.matched}"). Reframe the task description or abandon.`,
        kind: 'architect_refusal',
        iteration: 0,
      });
    } else {
      emitPhase(taskId, task.projectId, 'error', { message });
      failTask(taskId, `Error: ${message}`);
    }
  } finally {
    running.delete(taskId);
    gracefulStops.delete(taskId);
  }
}

export async function resumeTask(
  taskId: string,
  opts: { plan?: ArchitectPlan; hint?: string } = {}
): Promise<void> {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  if (opts.hint) {
    store.appendTaskHint(taskId, opts.hint);
  }
  store.clearTaskEscalation(taskId);
  await runTask(taskId, { initialPlan: opts.plan });
}
