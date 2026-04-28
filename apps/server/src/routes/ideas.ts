import { Router } from 'express';
import { store } from '../db.js';
import { broadcast } from '../ws.js';
import { runIdeaScout, type ScoutContext } from '../agents/idea-scout.js';

export const ideasRouter = Router();

const scouting = new Map<string, AbortController>();

export function isScouting(projectId: string): boolean {
  return scouting.has(projectId);
}

export async function scoutProject(projectId: string, reason: string): Promise<number> {
  if (scouting.has(projectId)) return 0;
  const project = store.getProject(projectId);
  if (!project) return 0;

  const controller = new AbortController();
  scouting.set(projectId, controller);
  broadcast({ type: 'ideas_updated', projectId, payload: { scouting: true, reason } });

  try {
    const allTasks = store.listTasks(projectId);
    const doneTasks = allTasks
      .filter((t) => t.status === 'done')
      .slice(-10)
      .map((t) => ({ title: t.title, description: t.description }));
    const recent = store.listRecentIdeas(projectId, 40);
    const pending = recent.filter((i) => i.status === 'pending');
    const rejected = recent.filter((i) => i.status === 'rejected').slice(0, 20);

    const context: ScoutContext = {
      doneTasks,
      pendingIdeas: pending.map((i) => ({ title: i.title, description: i.description })),
      rejectedIdeas: rejected.map((i) => ({ title: i.title, description: i.description })),
    };

    const suggestions = await runIdeaScout(project, `scout-${project.id}`, context, controller.signal);

    let created = 0;
    for (const s of suggestions) {
      if (!s.title || !s.description) continue;
      store.createIdea(project.id, s.title, s.description, s.rationale || '');
      created++;
    }

    broadcast({ type: 'ideas_updated', projectId, payload: { scouting: false, created, reason } });
    return created;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[scout] failed for ${projectId}:`, err);
    broadcast({ type: 'ideas_updated', projectId, payload: { scouting: false, error: message, reason } });
    return 0;
  } finally {
    scouting.delete(projectId);
  }
}

ideasRouter.get('/', (req, res) => {
  const projectId = req.query.project;
  if (typeof projectId !== 'string') {
    return res.status(400).json({ error: 'project query param required' });
  }
  res.json(store.listPendingIdeas(projectId));
});

ideasRouter.get('/status', (req, res) => {
  const projectId = req.query.project;
  if (typeof projectId !== 'string') {
    return res.status(400).json({ error: 'project query param required' });
  }
  res.json({ scouting: isScouting(projectId) });
});

ideasRouter.post('/scout', (req, res) => {
  const { projectId } = req.body ?? {};
  if (typeof projectId !== 'string' || !projectId) {
    return res.status(400).json({ error: 'projectId required' });
  }
  const project = store.getProject(projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });
  if (isScouting(projectId)) {
    return res.status(409).json({ error: 'already scouting this project' });
  }
  scoutProject(projectId, 'manual').catch((err) => console.error('[scout] failed:', err));
  res.status(202).json({ scouting: true });
});

ideasRouter.post('/:id/approve', (req, res) => {
  const idea = store.getIdea(req.params.id);
  if (!idea) return res.status(404).json({ error: 'not found' });
  if (idea.status !== 'pending') {
    return res.status(400).json({ error: `idea is ${idea.status}` });
  }
  const task = store.createTask(idea.projectId, idea.title, idea.description);
  store.setIdeaStatus(idea.id, 'converted', task.id);
  broadcast({ type: 'task_updated', taskId: task.id, projectId: task.projectId, payload: task });
  broadcast({ type: 'ideas_updated', projectId: idea.projectId, payload: { approved: idea.id, taskId: task.id } });
  res.json({ idea: store.getIdea(idea.id), task });
});

ideasRouter.post('/:id/reject', (req, res) => {
  const idea = store.getIdea(req.params.id);
  if (!idea) return res.status(404).json({ error: 'not found' });
  store.setIdeaStatus(idea.id, 'rejected');
  broadcast({ type: 'ideas_updated', projectId: idea.projectId, payload: { rejected: idea.id } });
  res.json({ ok: true });
});

ideasRouter.delete('/:id', (req, res) => {
  const idea = store.getIdea(req.params.id);
  if (!idea) return res.status(404).json({ error: 'not found' });
  store.deleteIdea(idea.id);
  broadcast({ type: 'ideas_updated', projectId: idea.projectId, payload: { deleted: idea.id } });
  res.status(204).end();
});
