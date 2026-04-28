import { Router } from 'express';
import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { store } from '../db.js';
import { broadcast } from '../ws.js';
import { runOperatorAnalysis, runOperatorChat } from '../agents/operator.js';
import { runTask } from '../orchestrator.js';
import type { OperatorSession } from '../types.js';

export const operatorRouter = Router();

interface RunningOperatorApp {
  sessionId: string;
  projectId: string;
  command: string;
  pid: number;
  startedAt: string;
  child: ChildProcess;
  lines: { stream: 'stdout' | 'stderr'; line: string; at: string }[];
  lastExit: { code: number | null; signal: string | null; finishedAt: string } | null;
}

const runningOperators = new Map<string, RunningOperatorApp>();
const sessionTerminals = new Map<string, RunningOperatorApp['lines']>();
const sessionLastExit = new Map<string, RunningOperatorApp['lastExit']>();

function terminalTail(sessionId: string, n = 40): string {
  const lines = sessionTerminals.get(sessionId) ?? [];
  return lines
    .slice(-n)
    .map((l) => `[${l.stream}] ${l.line}`)
    .join('\n');
}

operatorRouter.post('/projects/:id/operator/start', async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });

  const session = store.createOperatorSession(project.id, null);
  store.updateOperatorSession(session.id, { status: 'analyzing' });
  broadcast({
    type: 'operator_status',
    projectId: project.id,
    sessionId: session.id,
    payload: { status: 'analyzing' },
  } as any);

  // Kick off analysis asynchronously so we can return the sessionId immediately
  (async () => {
    try {
      const analysis = await runOperatorAnalysis(project, session.id);
      store.updateOperatorSession(session.id, { analysis, status: 'idle' });
      broadcast({
        type: 'operator_analysis',
        projectId: project.id,
        sessionId: session.id,
        payload: { analysis, status: 'idle' },
      } as any);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.updateOperatorSession(session.id, { status: 'failed' });
      broadcast({
        type: 'operator_status',
        projectId: project.id,
        sessionId: session.id,
        payload: { status: 'failed', message },
      } as any);
    }
  })();

  res.status(202).json({ sessionId: session.id, analysis: null });
});

operatorRouter.get('/projects/:id/operator/session', (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });
  const session = store.latestOperatorSession(project.id);
  if (!session) return res.json(null);
  const messages = store.listOperatorMessages(session.id);
  const running = runningOperators.get(session.id);
  res.json({
    session: hydrateRunning(session, running),
    messages,
    terminal: sessionTerminals.get(session.id) ?? [],
    lastExit: sessionLastExit.get(session.id) ?? null,
    running: !!running,
    command: running?.command ?? null,
    pid: running?.pid ?? null,
  });
});

function hydrateRunning(session: OperatorSession, running?: RunningOperatorApp): OperatorSession {
  if (!running) return session;
  return { ...session, status: 'running' };
}

operatorRouter.post('/operator/:sessionId/message', async (req, res) => {
  const sessionId = req.params.sessionId;
  const session = store.getOperatorSession(sessionId);
  if (!session) return res.status(404).json({ error: 'session not found' });
  const project = store.getProject(session.projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });

  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (!content) return res.status(400).json({ error: 'content is required' });

  const userMsg = store.appendOperatorMessage({ sessionId, role: 'user', content });
  broadcast({
    type: 'operator_message',
    projectId: project.id,
    sessionId,
    payload: userMsg,
  } as any);

  res.status(202).json({ ok: true });

  try {
    const history = store.listOperatorMessages(sessionId);
    const text = await runOperatorChat(
      project,
      sessionId,
      content,
      history.slice(0, -1),
      session.analysis,
      terminalTail(sessionId)
    );
    const reply = store.appendOperatorMessage({ sessionId, role: 'operator', content: text });
    broadcast({
      type: 'operator_message',
      projectId: project.id,
      sessionId,
      payload: reply,
    } as any);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const sys = store.appendOperatorMessage({
      sessionId,
      role: 'system',
      content: `Error: ${message}`,
    });
    broadcast({
      type: 'operator_message',
      projectId: project.id,
      sessionId,
      payload: sys,
    } as any);
  }
});

operatorRouter.post('/operator/:sessionId/run', (req, res) => {
  const sessionId = req.params.sessionId;
  const session = store.getOperatorSession(sessionId);
  if (!session) return res.status(404).json({ error: 'session not found' });
  const project = store.getProject(session.projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });

  if (runningOperators.has(sessionId)) {
    return res.status(409).json({ error: 'already running' });
  }

  const explicit = typeof req.body?.command === 'string' ? req.body.command.trim() : '';
  const command =
    explicit || session.analysis?.runCommandGuess || project.runCommand || '';
  if (!command) {
    return res.status(422).json({
      error: 'no run command',
      hint: 'provide one in the request body as { "command": "..." }',
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
  const lines: RunningOperatorApp['lines'] = [];
  sessionTerminals.set(sessionId, lines);
  sessionLastExit.set(sessionId, null);

  const entry: RunningOperatorApp = {
    sessionId,
    projectId: project.id,
    command,
    pid: child.pid,
    startedAt,
    child,
    lines,
    lastExit: null,
  };
  runningOperators.set(sessionId, entry);
  store.updateOperatorSession(sessionId, { status: 'running' });

  broadcast({
    type: 'operator_status',
    projectId: project.id,
    sessionId,
    payload: { status: 'running', running: true, command, pid: child.pid, startedAt },
  } as any);

  const emitLine = (stream: 'stdout' | 'stderr', line: string) => {
    const clipped = line.slice(0, 2000);
    const entry = { stream, line: clipped, at: new Date().toISOString() };
    lines.push(entry);
    if (lines.length > 200) lines.splice(0, lines.length - 200);
    broadcast({
      type: 'operator_status',
      projectId: project.id,
      sessionId,
      payload: { line: { stream, line: clipped } },
    } as any);
  };

  if (child.stdout)
    readline.createInterface({ input: child.stdout }).on('line', (l) => emitLine('stdout', l));
  if (child.stderr)
    readline.createInterface({ input: child.stderr }).on('line', (l) => emitLine('stderr', l));

  child.on('exit', (code, signal) => {
    runningOperators.delete(sessionId);
    const exit = {
      code,
      signal: signal ?? null,
      finishedAt: new Date().toISOString(),
    };
    sessionLastExit.set(sessionId, exit);
    store.updateOperatorSession(sessionId, { status: 'stopped' });
    broadcast({
      type: 'operator_status',
      projectId: project.id,
      sessionId,
      payload: { status: 'stopped', running: false, code, signal: signal ?? null },
    } as any);
  });

  child.on('error', (err) => {
    emitLine('stderr', `[spawn error] ${err.message}`);
  });

  res.status(202).json({ started: true, command });
});

operatorRouter.post('/operator/:sessionId/stop', (req, res) => {
  const sessionId = req.params.sessionId;
  const app = runningOperators.get(sessionId);
  if (!app) return res.status(409).json({ error: 'not running' });
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      app.child.kill('SIGTERM');
      setTimeout(() => {
        if (runningOperators.has(sessionId)) app.child.kill('SIGKILL');
      }, 2000).unref();
    }
    res.json({ stopping: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

operatorRouter.post('/operator/:sessionId/send-to-factory', (req, res) => {
  const sessionId = req.params.sessionId;
  const session = store.getOperatorSession(sessionId);
  if (!session) return res.status(404).json({ error: 'session not found' });
  const project = store.getProject(session.projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });

  const lines = sessionTerminals.get(sessionId) ?? [];
  const lastExit = sessionLastExit.get(sessionId);
  const stderrTail = lines.filter((l) => l.stream === 'stderr').slice(-30);
  const stdoutTail = lines.filter((l) => l.stream === 'stdout').slice(-10);
  const messages = store.listOperatorMessages(sessionId);
  const lastOpMsg = [...messages].reverse().find((m) => m.role === 'operator');

  const title =
    (typeof req.body?.title === 'string' && req.body.title.trim()) ||
    `Fix: ${pickErrorSummary(stderrTail, lastOpMsg?.content) ?? 'operator diagnostic'}`;
  const extra = typeof req.body?.extra === 'string' ? req.body.extra.trim() : '';

  const description = [
    `from operator session ${sessionId}`,
    '',
    `Run command: ${session.analysis?.runCommandGuess ?? project.runCommand ?? 'unknown'}`,
    lastExit
      ? `Exit code: ${lastExit.code ?? '(none)'}${lastExit.signal ? `, signal: ${lastExit.signal}` : ''}`
      : 'Process still running when reported.',
    '',
    '--- operator diagnostic ---',
    lastOpMsg?.content ?? '(no operator message)',
    '',
    '--- stderr (last 30 lines) ---',
    stderrTail.length ? stderrTail.map((l) => l.line).join('\n') : '(no stderr captured)',
    '',
    '--- stdout tail (last 10 lines) ---',
    stdoutTail.length ? stdoutTail.map((l) => l.line).join('\n') : '(no stdout captured)',
    extra ? `\n${extra}` : '',
  ].join('\n');

  const task = store.createTask(project.id, title, description);
  broadcast({ type: 'task_updated', taskId: task.id, projectId: project.id, payload: task });
  broadcast({
    type: 'operator_diagnostic_sent',
    projectId: project.id,
    sessionId,
    payload: { taskId: task.id, title },
  } as any);

  runTask(task.id).catch((err) => {
    console.error(`[operator] dispatched task ${task.id} crashed:`, err);
  });

  res.status(201).json({ task });
});

const NOISE_RE = /^(\s*\[?\s*(INFO|DEBUG|WARN|WARNING|TRACE)\b|\s*$|\s*(at|File|>>>|::|---|\.\.\.|\d{4}-\d{2}-\d{2}T))/i;

/**
 * Pull a short, human-meaningful error line from the tail of stderr.
 * Walks bottom-up to find the most recent line that doesn't look like
 * INFO/DEBUG noise or a stack-frame line. Falls back to the operator's
 * first sentence, then to the last stderr line as-is.
 */
function pickErrorSummary(
  stderrTail: { line: string }[],
  operatorMsg: string | undefined
): string | null {
  for (let i = stderrTail.length - 1; i >= 0; i--) {
    const line = stderrTail[i].line.trim();
    if (!line || NOISE_RE.test(line)) continue;
    return line.slice(0, 70);
  }
  if (operatorMsg) {
    const firstSentence = operatorMsg.split(/(?<=[.!?])\s/)[0]?.trim();
    if (firstSentence) return firstSentence.slice(0, 70);
  }
  const last = stderrTail[stderrTail.length - 1]?.line.trim();
  return last ? last.slice(0, 70) : null;
}
