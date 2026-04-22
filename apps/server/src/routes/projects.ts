import { Router } from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { store } from '../db.js';
import { broadcast } from '../ws.js';

export const projectsRouter = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PICKER_SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'pick-folder.ps1');

projectsRouter.post('/pick-folder', async (_req, res) => {
  if (process.platform !== 'win32') {
    return res.status(501).json({
      error: 'native folder picker not implemented on this platform',
      hint: 'paste the absolute path manually',
    });
  }
  if (!fs.existsSync(PICKER_SCRIPT)) {
    return res.status(500).json({ error: `picker script not found: ${PICKER_SCRIPT}` });
  }

  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', PICKER_SCRIPT],
      { windowsHide: true }
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    const code: number = await new Promise((resolve) => child.on('exit', (c) => resolve(c ?? 0)));
    if (code !== 0) {
      return res.status(500).json({ error: err.trim() || `picker exited with code ${code}` });
    }
    const picked = out.trim();
    if (!picked) return res.json({ path: null });
    res.json({ path: picked });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

projectsRouter.get('/', (_req, res) => {
  res.json(store.listProjects());
});

projectsRouter.post('/', (req, res) => {
  const { name, path: folderPath } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (typeof folderPath !== 'string' || !folderPath.trim()) {
    return res.status(400).json({ error: 'path is required' });
  }
  const abs = path.resolve(folderPath);
  if (!fs.existsSync(abs)) {
    return res.status(400).json({ error: `path does not exist: ${abs}` });
  }
  if (!fs.statSync(abs).isDirectory()) {
    return res.status(400).json({ error: `path is not a directory: ${abs}` });
  }
  const project = store.createProject(name.trim(), abs);
  broadcast({ type: 'project_updated', projectId: project.id, payload: project });
  res.status(201).json(project);
});

projectsRouter.delete('/:id', (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  store.deleteProject(req.params.id);
  broadcast({ type: 'project_updated', projectId: project.id, payload: { deleted: true } });
  res.status(204).end();
});

projectsRouter.patch('/:id/run-command', (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'not found' });
  const { runCommand } = req.body ?? {};
  if (runCommand !== null && typeof runCommand !== 'string') {
    return res.status(400).json({ error: 'runCommand must be a string or null' });
  }
  const cleaned = typeof runCommand === 'string' ? runCommand.trim() || null : null;
  store.setProjectRunCommand(project.id, cleaned);
  const updated = store.getProject(project.id);
  broadcast({ type: 'project_updated', projectId: project.id, payload: updated });
  res.json(updated);
});
