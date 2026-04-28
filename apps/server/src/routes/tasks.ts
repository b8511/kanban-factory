import { Router } from 'express';
import { store } from '../db.js';
import { broadcast } from '../ws.js';
import { runTask, resumeTask, cancelTask, isRunning, requestGracefulStop } from '../orchestrator.js';
import type { ArchitectPlan, ReviewerRigor, Subtask } from '../types.js';

export const tasksRouter = Router();

function normalizeRigor(v: unknown): ReviewerRigor | null | 'invalid' {
  if (v === null) return null;
  if (v === 'lenient' || v === 'normal' || v === 'strict') return v;
  return 'invalid';
}

tasksRouter.get('/', (req, res) => {
  const projectId = req.query.project;
  if (typeof projectId !== 'string') {
    return res.status(400).json({ error: 'project query param required' });
  }
  const includeArchived = req.query.includeArchived === '1';
  res.json(store.listTasks(projectId, includeArchived));
});

tasksRouter.get('/archived-count', (req, res) => {
  const projectId = req.query.project;
  if (typeof projectId !== 'string') {
    return res.status(400).json({ error: 'project query param required' });
  }
  res.json({ count: store.countArchivedTasks(projectId) });
});

tasksRouter.post('/:id/archive', (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (isRunning(task.id)) {
    return res.status(409).json({ error: 'cannot archive a running task' });
  }
  store.setTaskStatus(task.id, 'archived');
  const updated = store.getTask(task.id);
  broadcast({ type: 'task_updated', taskId: task.id, projectId: task.projectId, payload: updated });
  res.json({ archived: true });
});

tasksRouter.post('/:id/unarchive', (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (task.status !== 'archived') return res.status(400).json({ error: 'task is not archived' });
  store.setTaskStatus(task.id, 'backlog');
  const updated = store.getTask(task.id);
  broadcast({ type: 'task_updated', taskId: task.id, projectId: task.projectId, payload: updated });
  res.json({ unarchived: true });
});

tasksRouter.post('/', (req, res) => {
  const { projectId, title, description } = req.body ?? {};
  if (typeof projectId !== 'string' || !projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }
  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  const project = store.getProject(projectId);
  if (!project) return res.status(400).json({ error: 'unknown projectId' });
  const task = store.createTask(
    projectId,
    title.trim(),
    typeof description === 'string' ? description : null
  );
  broadcast({ type: 'task_updated', taskId: task.id, projectId, payload: task });
  res.status(201).json(task);
});

tasksRouter.post('/:id/start', (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (task.status !== 'backlog' && task.status !== 'needs_attention' && task.status !== 'done') {
    return res.status(400).json({ error: `task is already ${task.status}` });
  }
  if (isRunning(task.id)) {
    return res.status(409).json({ error: 'task is already running' });
  }
  runTask(task.id).catch((err) => {
    console.error(`[orchestrator] task ${task.id} crashed:`, err);
    store.setTaskStatus(task.id, 'needs_attention');
    broadcast({
      type: 'error',
      taskId: task.id,
      payload: { message: (err as Error).message ?? String(err) },
    });
  });
  res.status(202).json({ started: true });
});

tasksRouter.post('/:id/cancel', (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  const ok = cancelTask(task.id);
  if (!ok) return res.status(409).json({ error: 'task is not running' });
  res.json({ cancelled: true });
});

tasksRouter.get('/:id/cost', (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  res.json(store.getTaskCost(task.id));
});

tasksRouter.get('/:id/detail', (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  const project = store.getProject(task.projectId);
  const plan: ArchitectPlan | null = task.planJson ? safeParse(task.planJson, null) : null;
  const history = task.progressJson ? safeParse(task.progressJson, []) : [];
  const reviews = store.listSubtaskReviews(task.id);
  const events = store.listTaskEvents(task.id);
  const checkpoints = store.listCheckpoints(task.id);
  const cost = store.getTaskCost(task.id);
  const costByRole = store.getTaskCostByRole(task.id);
  res.json({
    task,
    project: project
      ? { id: project.id, name: project.name, path: project.path, reviewerRigor: project.reviewerRigor }
      : null,
    plan,
    history,
    reviews,
    events,
    checkpoints,
    cost,
    costByRole,
    effectiveRigor: (task.reviewerRigor ?? project?.reviewerRigor ?? 'normal') as ReviewerRigor,
  });
});

tasksRouter.get('/:id/events', (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  const since = typeof req.query.since === 'string' ? req.query.since : undefined;
  res.json(store.listTaskEvents(task.id, since));
});

tasksRouter.patch('/:id/rigor', (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  const rigor = normalizeRigor(req.body?.rigor);
  if (rigor === 'invalid') {
    return res.status(400).json({ error: "rigor must be 'lenient' | 'normal' | 'strict' | null" });
  }
  store.setTaskRigor(task.id, rigor);
  const updated = store.getTask(task.id);
  broadcast({ type: 'task_updated', taskId: task.id, projectId: task.projectId, payload: updated });
  res.json(updated);
});

tasksRouter.post('/:id/resolve-escalation', (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  const { action, plan, hint } = req.body ?? {};

  const requiresEscalation = action === 'edit_plan' || action === 'add_hint';
  if (requiresEscalation && !task.escalation) {
    return res.status(400).json({ error: 'task has no active escalation' });
  }
  if (requiresEscalation && isRunning(task.id)) {
    return res.status(409).json({ error: 'task is already running' });
  }

  switch (action) {
    case 'approve_anyway': {
      // If the task is mid-run, request a graceful stop: let the in-flight
      // specialist + reviewer round complete, then mark done. The orchestrator
      // handles status flip + escalation/failure cleanup.
      if (isRunning(task.id)) {
        requestGracefulStop(task.id);
        broadcast({
          type: 'escalation_resolved',
          taskId: task.id,
          projectId: task.projectId,
          payload: { action: 'graceful_stop' },
        });
        return res.status(202).json({ ok: true, gracefulStop: true });
      }
      // Not running: flip immediately.
      store.clearTaskEscalation(task.id);
      store.setTaskFailure(task.id, null);
      store.setTaskStatus(task.id, 'done');
      const updated = store.getTask(task.id);
      broadcast({ type: 'escalation_resolved', taskId: task.id, projectId: task.projectId, payload: { action } });
      broadcast({ type: 'task_updated', taskId: task.id, projectId: task.projectId, payload: updated });
      return res.json({ ok: true, task: updated });
    }
    case 'abandon': {
      if (isRunning(task.id)) {
        cancelTask(task.id);
      }
      store.clearTaskEscalation(task.id);
      const updated = store.getTask(task.id);
      broadcast({ type: 'escalation_resolved', taskId: task.id, projectId: task.projectId, payload: { action } });
      broadcast({ type: 'task_updated', taskId: task.id, projectId: task.projectId, payload: updated });
      return res.json({ ok: true, task: updated });
    }
    case 'edit_plan': {
      const normalized = normalizePlan(plan);
      if (!normalized) {
        return res.status(400).json({ error: 'plan must be { subtasks: [{description, touches?}] } with 1-3 entries' });
      }
      broadcast({ type: 'escalation_resolved', taskId: task.id, projectId: task.projectId, payload: { action } });
      resumeTask(task.id, { plan: normalized }).catch((err) => {
        console.error(`[orchestrator] resume after edit_plan crashed:`, err);
      });
      return res.status(202).json({ ok: true, resumed: true });
    }
    case 'add_hint': {
      if (typeof hint !== 'string' || !hint.trim()) {
        return res.status(400).json({ error: 'hint must be a non-empty string' });
      }
      broadcast({ type: 'escalation_resolved', taskId: task.id, projectId: task.projectId, payload: { action } });
      resumeTask(task.id, { hint: hint.trim() }).catch((err) => {
        console.error(`[orchestrator] resume after add_hint crashed:`, err);
      });
      return res.status(202).json({ ok: true, resumed: true });
    }
    default:
      return res.status(400).json({ error: "action must be 'approve_anyway' | 'abandon' | 'edit_plan' | 'add_hint'" });
  }
});

function safeParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function normalizePlan(v: unknown): ArchitectPlan | null {
  if (!v || typeof v !== 'object') return null;
  const raw = (v as { subtasks?: unknown }).subtasks;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 3) return null;
  const subtasks: Subtask[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as { description?: unknown; touches?: unknown };
    if (typeof e.description !== 'string' || !e.description.trim()) return null;
    const touches =
      Array.isArray(e.touches) && e.touches.every((t) => typeof t === 'string')
        ? (e.touches as string[])
        : undefined;
    subtasks.push({ description: e.description.trim(), touches });
  }
  return { subtasks };
}
