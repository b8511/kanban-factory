import { Router } from 'express';
import { store } from '../db.js';
import { broadcast } from '../ws.js';
import { runTask, cancelTask, isRunning } from '../orchestrator.js';

export const tasksRouter = Router();

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
