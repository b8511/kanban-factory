import { Router } from 'express';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { store } from '../db.js';
import { broadcast } from '../ws.js';
import type { Project } from '../types.js';

export const runRouter = Router();

interface RunningApp {
  projectId: string;
  pid: number;
  command: string;
  startedAt: string;
  child: ChildProcess;
}

const runningApps = new Map<string, RunningApp>();

function detectRunCommand(project: Project): string | null {
  if (project.runCommand && project.runCommand.trim()) return project.runCommand;

  const pkgPath = path.join(project.path, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const scripts = pkg.scripts ?? {};
      if (typeof scripts.dev === 'string') return 'npm run dev';
      if (typeof scripts.start === 'string') return 'npm start';
      if (typeof scripts.serve === 'string') return 'npm run serve';
    } catch {}
  }

  for (const candidate of ['main.py', 'app.py', 'server.py']) {
    if (fs.existsSync(path.join(project.path, candidate))) return `python ${candidate}`;
  }

  return null;
}

function statusFor(projectId: string): { running: boolean; command: string | null; pid: number | null; startedAt?: string } {
  const app = runningApps.get(projectId);
  if (!app) {
    const project = store.getProject(projectId);
    return { running: false, command: project?.runCommand ?? null, pid: null };
  }
  return { running: true, command: app.command, pid: app.pid, startedAt: app.startedAt };
}

runRouter.post('/projects/:id/open-folder', (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });
  if (!fs.existsSync(project.path)) {
    return res.status(400).json({ error: `path does not exist: ${project.path}` });
  }

  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '""', project.path], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [project.path], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [project.path], { detached: true, stdio: 'ignore' }).unref();
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

runRouter.post('/projects/:id/run', (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });
  if (runningApps.has(project.id)) {
    return res.status(409).json({ error: 'already running', status: statusFor(project.id) });
  }

  const command = detectRunCommand(project);
  if (!command) {
    return res.status(422).json({
      error: 'no run command detected',
      hint: 'add a "dev" or "start" script to package.json, or set runCommand on the project.',
    });
  }

  let child: ChildProcess;
  try {
    if (process.platform === 'win32') {
      child = spawn('cmd.exe', ['/c', command], {
        cwd: project.path,
        env: process.env,
        windowsHide: true,
      });
    } else {
      child = spawn('sh', ['-c', command], { cwd: project.path, env: process.env });
    }
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }

  if (!child.pid) {
    return res.status(500).json({ error: 'failed to spawn process (no pid)' });
  }

  const startedAt = new Date().toISOString();
  const entry: RunningApp = {
    projectId: project.id,
    pid: child.pid,
    command,
    startedAt,
    child,
  };
  runningApps.set(project.id, entry);

  if (project.runCommand !== command) {
    store.setProjectRunCommand(project.id, command);
  }

  broadcast({
    type: 'app_run_started',
    projectId: project.id,
    payload: { command, pid: child.pid, startedAt },
  });

  const emitLine = (stream: 'stdout' | 'stderr', line: string) => {
    broadcast({
      type: 'app_run_log',
      projectId: project.id,
      payload: { stream, line: line.slice(0, 2000) },
    });
  };

  if (child.stdout) readline.createInterface({ input: child.stdout }).on('line', (l) => emitLine('stdout', l));
  if (child.stderr) readline.createInterface({ input: child.stderr }).on('line', (l) => emitLine('stderr', l));

  child.on('exit', (code, signal) => {
    runningApps.delete(project.id);
    broadcast({
      type: 'app_run_stopped',
      projectId: project.id,
      payload: { code, signal: signal ?? null },
    });
  });

  child.on('error', (err) => {
    broadcast({
      type: 'app_run_log',
      projectId: project.id,
      payload: { stream: 'stderr', line: `[spawn error] ${err.message}` },
    });
  });

  return res.status(202).json({ started: true, status: statusFor(project.id) });
});

runRouter.post('/projects/:id/stop-run', (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });
  const app = runningApps.get(project.id);
  if (!app) return res.status(409).json({ error: 'not running' });

  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      app.child.kill('SIGTERM');
      setTimeout(() => {
        if (runningApps.has(project.id)) app.child.kill('SIGKILL');
      }, 2000).unref();
    }
    return res.json({ stopping: true });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

runRouter.get('/projects/:id/run-status', (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });
  res.json(statusFor(project.id));
});
