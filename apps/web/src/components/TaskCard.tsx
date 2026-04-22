import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { api } from '../api';
import { useUi } from '../store';
import type { ReviewSeverity, Task, TaskStatus } from '../types';

interface Props {
  task: Task;
}

const RING_BY_STATUS: Record<TaskStatus, string> = {
  backlog: 'border-neutral-800',
  planning: 'border-blue-500/60 text-blue-500/30 ring-pulse',
  in_progress: 'border-indigo-500/60 text-indigo-500/30 ring-pulse',
  review: 'border-amber-500/60 text-amber-500/30 ring-pulse',
  done: 'border-emerald-700/40',
  needs_attention: 'border-rose-500/60',
  archived: 'border-neutral-800',
};

const STATUS_CHIP: Record<TaskStatus, { bg: string; text: string; label: string }> = {
  backlog: { bg: 'bg-neutral-800', text: 'text-neutral-400', label: 'Backlog' },
  planning: { bg: 'bg-blue-950/60', text: 'text-blue-300', label: 'Planning' },
  in_progress: { bg: 'bg-indigo-950/60', text: 'text-indigo-300', label: 'In Progress' },
  review: { bg: 'bg-amber-950/60', text: 'text-amber-300', label: 'Review' },
  done: { bg: 'bg-emerald-950/60', text: 'text-emerald-300', label: 'Done' },
  needs_attention: { bg: 'bg-rose-950/60', text: 'text-rose-300', label: 'Needs attention' },
  archived: { bg: 'bg-neutral-900', text: 'text-neutral-500', label: 'Archived' },
};

const ACTIVE_STATUSES = new Set<TaskStatus>(['planning', 'in_progress', 'review']);

const SEVERITY_STYLES: Record<ReviewSeverity, string> = {
  blocker: 'text-rose-400',
  major: 'text-amber-400',
  minor: 'text-yellow-300',
  none: 'text-emerald-400',
};

export function TaskCard({ task }: Props) {
  const qc = useQueryClient();
  const {
    setSelectedTask,
    lastTool,
    cost,
    subtaskProgress,
    appRuns,
    setAppRun,
    appRunLogs,
    appRunUrls,
    appRunExits,
    setSelectedProject,
  } = useUi();
  const activeTool = lastTool[task.id];
  const taskCost = cost[task.id];
  const progress = subtaskProgress[task.id];
  const appRun = appRuns[task.projectId];
  const runLogs = appRunLogs[task.projectId] ?? [];
  const runUrls = appRunUrls[task.projectId] ?? [];
  const lastExit = appRunExits[task.projectId];
  const stderrCount = runLogs.filter((l) => l.stream === 'stderr').length;
  const crashed = lastExit && lastExit.code !== null && lastExit.code !== 0;
  const [cmdEditor, setCmdEditor] = useState<string | null>(null);

  const startMut = useMutation({
    mutationFn: () => api.startTask(task.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks', task.projectId] }),
  });
  const cancelMut = useMutation({
    mutationFn: () => api.cancelTask(task.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks', task.projectId] }),
  });
  const openFolderMut = useMutation({ mutationFn: () => api.openFolder(task.projectId) });
  const runMut = useMutation({
    mutationFn: () => api.runProject(task.projectId),
    onSuccess: (data) => setAppRun(task.projectId, data.status),
  });
  const stopMut = useMutation({ mutationFn: () => api.stopProject(task.projectId) });
  const archiveMut = useMutation({
    mutationFn: () => api.archiveTask(task.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks', task.projectId] }),
  });
  const setCmdMut = useMutation({
    mutationFn: (cmd: string) => api.setRunCommand(task.projectId, cmd),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['runStatus', task.projectId] });
      runMut.reset();
      setCmdEditor(null);
    },
  });
  const addRunCommandMut = useMutation({
    mutationFn: async () => {
      const description = [
        'This project has no detectable run command. Add one so the app can be launched with a single command.',
        '',
        'Acceptance:',
        '- Either a `package.json` exists at the project root with a `dev` or `start` script that boots the app, OR',
        '- A top-level `main.py` / `app.py` / `server.py` exists and runs the app.',
        '',
        'After adding the entry, verify it works (run the command and confirm it starts without crashing).',
        '',
        `Built from earlier task: "${task.title}".`,
      ].join('\n');
      const newTask = await api.createTask(
        task.projectId,
        'Add a run command for this project',
        description
      );
      await api.startTask(newTask.id);
      return newTask;
    },
    onSuccess: (newTask) => {
      qc.invalidateQueries({ queryKey: ['tasks', task.projectId] });
      setSelectedProject(task.projectId);
      setSelectedTask(newTask.id);
      runMut.reset();
    },
  });
  const makeWebAppMut = useMutation({
    mutationFn: async () => {
      const description = [
        'This project runs, but it is a script — it finishes and exits with no endpoint to hit.',
        'Turn it into a web app so the user can interact with it in a browser.',
        '',
        'Acceptance:',
        '- The run command boots a long-running HTTP server (Flask/FastAPI/Express/etc. — match the existing stack).',
        '- The server binds to localhost on a free port and prints the URL to stdout on boot (e.g. `Running on http://localhost:8000`).',
        '- At least one meaningful route exists that exposes what the existing script did. If the script had output (self-test, predictions, a value, etc.), expose it as JSON at `/` or as a simple HTML page.',
        '- Update the project run command to whatever now boots the server.',
        '- Verify by running the new command yourself and confirming it stays running and serves a request (hit it with curl).',
        '',
        `Current run command: ${appRun?.command ?? '(unknown)'}`,
        `Built from earlier task: "${task.title}".`,
      ].join('\n');
      const newTask = await api.createTask(
        task.projectId,
        'Make this a web app (expose an endpoint)',
        description
      );
      await api.startTask(newTask.id);
      return newTask;
    },
    onSuccess: (newTask) => {
      qc.invalidateQueries({ queryKey: ['tasks', task.projectId] });
      setSelectedProject(task.projectId);
      setSelectedTask(newTask.id);
    },
  });
  const sendToFactoryMut = useMutation({
    mutationFn: () => {
      const stderrLines = runLogs.filter((l) => l.stream === 'stderr').slice(-30);
      const tailStdout = runLogs.filter((l) => l.stream === 'stdout').slice(-10);
      const exitNote = lastExit
        ? `Exit code: ${lastExit.code ?? '(none)'}${lastExit.signal ? `, signal: ${lastExit.signal}` : ''}`
        : 'Process still running when reported.';
      const description = [
        `Run command: ${appRun?.command ?? 'unknown'}`,
        exitNote,
        '',
        '--- stderr (last 30 lines) ---',
        stderrLines.length ? stderrLines.map((l) => l.line).join('\n') : '(no stderr captured)',
        '',
        '--- stdout tail (last 10 lines) ---',
        tailStdout.length ? tailStdout.map((l) => l.line).join('\n') : '(no stdout captured)',
        '',
        `Original task that built this app: "${task.title}"`,
      ].join('\n');
      const titleHint = stderrLines[0]?.line.slice(0, 60) || `Crash on run (exit ${lastExit?.code ?? '?'})`;
      return api.createTask(task.projectId, `Fix: ${titleHint}`, description);
    },
    onSuccess: (newTask) => {
      qc.invalidateQueries({ queryKey: ['tasks', task.projectId] });
      setSelectedProject(task.projectId);
      setSelectedTask(newTask.id);
    },
  });
  const isDone = task.status === 'done';
  const canSendToFactory = isDone && (crashed || stderrCount > 0);
  const looksLikeOneShot =
    isDone &&
    lastExit !== null &&
    lastExit !== undefined &&
    !appRun?.running &&
    !crashed &&
    runUrls.length === 0;

  const { data: runStatus } = useQuery({
    queryKey: ['runStatus', task.projectId],
    queryFn: () => api.getRunStatus(task.projectId),
    enabled: isDone && appRun === undefined,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (runStatus && appRun === undefined) setAppRun(task.projectId, runStatus);
  }, [runStatus, appRun, task.projectId, setAppRun]);

  const canStart = task.status === 'backlog' || task.status === 'needs_attention';
  const canCancel = ACTIVE_STATUSES.has(task.status);
  const isActive = canCancel;

  const totalRounds = computeTotalRounds(task);
  const running = appRun?.running ?? false;
  const chip = STATUS_CHIP[task.status] ?? STATUS_CHIP.backlog;

  return (
    <div
      className={clsx(
        'group card-surface cursor-pointer p-2.5',
        RING_BY_STATUS[task.status]
      )}
      onClick={() => setSelectedTask(task.id)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-neutral-50">{task.title}</div>
          {task.description && (
            <div className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-neutral-500">
              {task.description}
            </div>
          )}
        </div>
        {(task.status === 'done' || task.status === 'needs_attention') && (
          <button
            className="opacity-0 transition group-hover:opacity-100 -mr-1 -mt-0.5 rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-50"
            onClick={(e) => {
              e.stopPropagation();
              archiveMut.mutate();
            }}
            disabled={archiveMut.isPending}
            title="Archive this task"
          >
            {archiveMut.isPending ? '…' : '📦'}
          </button>
        )}
      </div>

      {isActive && activeTool && (
        <div className="mt-2 flex items-center gap-1.5 truncate font-mono text-[11px] text-neutral-400">
          <span className="rounded bg-indigo-900/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-indigo-300">
            {activeTool.role}
          </span>
          <span className="truncate">
            {activeTool.name}
            {activeTool.target && <span className="text-neutral-600"> {activeTool.target}</span>}
          </span>
        </div>
      )}

      {isActive && progress && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[11px]">
          <span className="text-neutral-500">
            #{progress.subtaskIndex + 1} · round {progress.round}/{progress.maxRounds}
          </span>
          <span className={clsx('font-medium', SEVERITY_STYLES[progress.severity] ?? 'text-neutral-400')}>
            {progress.approved ? '✓ approved' : `reviewer (${progress.severity})`}
          </span>
          {progress.feedback && (
            <span className="w-full truncate text-neutral-500">“{progress.feedback.slice(0, 100)}”</span>
          )}
        </div>
      )}

      {isDone && totalRounds > 0 && (
        <div className="mt-1.5 text-[11px] text-emerald-400">
          ✓ {totalRounds} subtask{totalRounds === 1 ? '' : 's'} approved
        </div>
      )}

      {task.status === 'needs_attention' && task.failureReason && (
        <div className="mt-2 rounded-md border border-rose-800/60 bg-rose-950/40 p-2 text-[11px] leading-relaxed text-rose-200">
          <div className="mb-1 font-medium text-rose-300">Why it failed</div>
          <div className="whitespace-pre-wrap break-words">{task.failureReason}</div>
        </div>
      )}

      {(taskCost && taskCost.costUsd > 0) || canStart || canCancel ? (
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <span className={clsx('chip', chip.bg, chip.text)}>{chip.label}</span>
            {taskCost && taskCost.costUsd > 0 && (
              <span className="font-mono text-[10px] text-neutral-500">
                ${taskCost.costUsd.toFixed(3)} · {formatTokens(taskCost.inputTokens + taskCost.outputTokens)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {canStart && (
              <button
                className="btn btn-primary"
                onClick={(e) => {
                  e.stopPropagation();
                  startMut.mutate();
                }}
                disabled={startMut.isPending}
              >
                {startMut.isPending
                  ? 'Starting…'
                  : task.status === 'needs_attention'
                    ? 'Retry'
                    : '▶ Start'}
              </button>
            )}
            {canCancel && (
              <button
                className="btn btn-danger"
                onClick={(e) => {
                  e.stopPropagation();
                  cancelMut.mutate();
                }}
                disabled={cancelMut.isPending}
              >
                {cancelMut.isPending ? 'Cancelling…' : 'Cancel'}
              </button>
            )}
          </div>
        </div>
      ) : null}

      {isDone && (
        <div className="divider mt-2.5 pt-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <button
              className="btn btn-ghost"
              onClick={(e) => {
                e.stopPropagation();
                openFolderMut.mutate();
              }}
              disabled={openFolderMut.isPending}
              title="Open project folder"
            >
              📁 Open
            </button>
            {running ? (
              <button
                className="btn btn-danger"
                onClick={(e) => {
                  e.stopPropagation();
                  stopMut.mutate();
                }}
                disabled={stopMut.isPending}
              >
                {stopMut.isPending ? 'Stopping…' : '⏹ Stop'}
              </button>
            ) : (
              <button
                className="btn btn-success"
                onClick={(e) => {
                  e.stopPropagation();
                  runMut.mutate();
                }}
                disabled={runMut.isPending}
                title={appRun?.command ?? 'Auto-detect run command'}
              >
                {runMut.isPending ? '▶ Starting…' : '▶ Run'}
              </button>
            )}
          </div>
          {running && appRun?.command && (
            <div className="flex min-w-0 items-center gap-1.5 rounded-full bg-emerald-950/40 px-2 py-0.5 text-[10px] text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]" />
              <span className="truncate font-mono">{appRun.command}</span>
            </div>
          )}
        </div>
      )}

      {isDone &&
        runMut.isError &&
        (() => {
          const msg = (runMut.error as Error).message;
          const noCmd = /no run command detected/i.test(msg);
          if (noCmd) {
            return (
              <div className="mt-2 rounded-lg border border-amber-700/50 bg-amber-950/30 p-2.5 text-xs text-amber-200">
                <div className="mb-2 font-medium">
                  No run command for this project — every project needs one.
                </div>
                <button
                  className="btn btn-violet mb-2 w-full"
                  onClick={(e) => {
                    e.stopPropagation();
                    addRunCommandMut.mutate();
                  }}
                  disabled={addRunCommandMut.isPending}
                >
                  {addRunCommandMut.isPending
                    ? '🔧 Dispatching…'
                    : addRunCommandMut.isSuccess
                      ? '✓ New task started'
                      : '🔧 Have the factory add it'}
                </button>
                {addRunCommandMut.isError && (
                  <div className="mb-1 break-all text-[10px] text-rose-400">
                    {(addRunCommandMut.error as Error).message}
                  </div>
                )}
                {cmdEditor === null ? (
                  <button
                    className="text-[11px] text-amber-300/80 underline hover:text-amber-200"
                    onClick={(e) => {
                      e.stopPropagation();
                      setCmdEditor(appRun?.command ?? '');
                    }}
                  >
                    …or set it manually
                  </button>
                ) : (
                  <div className="flex gap-1">
                    <input
                      className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-[11px] text-neutral-100 focus:border-indigo-500 focus:outline-none"
                      value={cmdEditor}
                      placeholder="e.g. npm run dev"
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setCmdEditor(e.target.value)}
                      autoFocus
                    />
                    <button
                      className="btn btn-success"
                      disabled={!cmdEditor.trim() || setCmdMut.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        setCmdMut.mutate(cmdEditor.trim());
                      }}
                    >
                      Save
                    </button>
                    <button
                      className="btn btn-ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        setCmdEditor(null);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            );
          }
          return (
            <div className="mt-2 break-all rounded-md border border-rose-900/50 bg-rose-950/30 p-2 text-[11px] text-rose-300">
              Run failed: {msg}
            </div>
          );
        })()}
      {isDone && stopMut.isError && (
        <div className="mt-2 break-all rounded-md border border-rose-900/50 bg-rose-950/30 p-2 text-[11px] text-rose-300">
          Stop failed: {(stopMut.error as Error).message}
        </div>
      )}

      {isDone && runUrls.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {runUrls.map((u) => (
            <a
              key={u}
              href={u}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 rounded-full bg-sky-950/60 px-2 py-0.5 text-[11px] font-medium text-sky-300 ring-1 ring-sky-800/60 hover:bg-sky-900/60 hover:text-sky-200"
            >
              <span>↗</span>
              <span className="font-mono">{u}</span>
            </a>
          ))}
        </div>
      )}

      {isDone && lastExit && !appRun?.running && (() => {
        const stdoutCount = runLogs.length - stderrCount;
        const startedAt = appRun?.startedAt ? new Date(appRun.startedAt) : null;
        const finishedAt = new Date(lastExit.finishedAt);
        const duration = startedAt ? (finishedAt.getTime() - startedAt.getTime()) / 1000 : null;
        const durationStr =
          duration === null
            ? null
            : duration < 1
              ? `${Math.round(duration * 1000)}ms`
              : duration < 60
                ? `${duration.toFixed(1)}s`
                : `${Math.floor(duration / 60)}m ${Math.round(duration % 60)}s`;

        const headline = crashed
          ? `✗ Crashed · exit ${lastExit.code}`
          : lastExit.signal
            ? `■ Terminated (signal ${lastExit.signal})`
            : lastExit.code === 0 && runLogs.length === 0
              ? '■ Finished cleanly · no output'
              : lastExit.code === 0 && duration !== null && duration < 2
                ? '■ Finished cleanly · likely a one-shot script (not a long-running server)'
                : '■ Finished cleanly';

        return (
          <div
            className={clsx(
              'mt-2 rounded-md px-2.5 py-2 text-[11px]',
              crashed
                ? 'border border-rose-700/60 bg-rose-950/40 text-rose-200'
                : 'border border-neutral-800 bg-neutral-900/60 text-neutral-300'
            )}
          >
            <div className={clsx('font-medium', crashed ? 'text-rose-200' : 'text-neutral-200')}>
              {headline}
            </div>
            <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[10px] text-neutral-500">
              <span className="text-neutral-600">Command</span>
              <span className="break-all font-mono text-neutral-400">{appRun?.command ?? '(unknown)'}</span>
              {startedAt && (
                <>
                  <span className="text-neutral-600">Started</span>
                  <span className="font-mono text-neutral-400">{startedAt.toLocaleTimeString()}</span>
                </>
              )}
              <span className="text-neutral-600">Ended</span>
              <span className="font-mono text-neutral-400">
                {finishedAt.toLocaleTimeString()}
                {durationStr && <span className="text-neutral-600"> · {durationStr}</span>}
              </span>
              <span className="text-neutral-600">Output</span>
              <span className="font-mono text-neutral-400">
                {stdoutCount} stdout
                {stderrCount > 0 && (
                  <span className="text-rose-400"> · {stderrCount} stderr</span>
                )}
              </span>
            </div>
          </div>
        );
      })()}

      {canSendToFactory && (
        <div className="mt-2">
          <button
            className="btn btn-violet w-full"
            onClick={(e) => {
              e.stopPropagation();
              sendToFactoryMut.mutate();
            }}
            disabled={sendToFactoryMut.isPending}
            title="Create a new task with the captured error log"
          >
            {sendToFactoryMut.isPending
              ? '🔧 Sending…'
              : sendToFactoryMut.isSuccess
                ? '✓ New task created'
                : '🔧 Send to factory (with error)'}
          </button>
          {sendToFactoryMut.isError && (
            <div className="mt-1 break-all text-[11px] text-rose-400">
              {(sendToFactoryMut.error as Error).message}
            </div>
          )}
        </div>
      )}

      {looksLikeOneShot && !canSendToFactory && (
        <div className="mt-2">
          <button
            className="btn btn-violet w-full"
            onClick={(e) => {
              e.stopPropagation();
              makeWebAppMut.mutate();
            }}
            disabled={makeWebAppMut.isPending}
            title="Dispatch a task to wrap this in a long-running HTTP server so Run gives you a link"
          >
            {makeWebAppMut.isPending
              ? '🌐 Dispatching…'
              : makeWebAppMut.isSuccess
                ? '✓ New task started'
                : '🌐 Make this a web app (expose an endpoint)'}
          </button>
          {makeWebAppMut.isError && (
            <div className="mt-1 break-all text-[11px] text-rose-400">
              {(makeWebAppMut.error as Error).message}
            </div>
          )}
        </div>
      )}

      {isDone && (running || runLogs.length > 0) && (
        <div className="mt-2">
          <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-neutral-500">
            <span>Logs</span>
            <span className="font-mono text-neutral-600">
              {runLogs.length} line{runLogs.length === 1 ? '' : 's'}
              {stderrCount > 0 && <span className="text-rose-400"> · {stderrCount} stderr</span>}
            </span>
          </div>
          <div className="max-h-64 overflow-y-auto rounded-md border border-neutral-800 bg-black/70 p-2 font-mono text-[10px] leading-snug">
            {runLogs.length === 0 ? (
              <div className="text-neutral-600">(no output yet — waiting for first line…)</div>
            ) : (
              runLogs.map((l, i) => (
                <div key={i} className="flex gap-2">
                  <span className="w-6 shrink-0 select-none text-right text-neutral-700">
                    {i + 1}
                  </span>
                  <span
                    className={clsx(
                      'min-w-0 flex-1 whitespace-pre-wrap break-all',
                      l.stream === 'stderr' ? 'text-rose-300' : 'text-neutral-300'
                    )}
                  >
                    {l.line}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function computeTotalRounds(task: Task): number {
  if (!task.progressJson) return 0;
  try {
    const arr = JSON.parse(task.progressJson);
    if (Array.isArray(arr)) return arr.length;
  } catch {}
  return 0;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
