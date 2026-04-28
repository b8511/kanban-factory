import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { api } from '../api';
import { useUi } from '../store';
import type { ReviewSeverity, Task, TaskStatus } from '../types';
import { RigorControl } from './RigorControl';

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
  const { setView, lastTool, cost, subtaskProgress } = useUi();
  const activeTool = lastTool[task.id];
  const taskCost = cost[task.id];
  const progress = subtaskProgress[task.id];

  const startMut = useMutation({
    mutationFn: () => api.startTask(task.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks', task.projectId] }),
  });
  const cancelMut = useMutation({
    mutationFn: () => api.cancelTask(task.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks', task.projectId] }),
  });
  const openFolderMut = useMutation({ mutationFn: () => api.openFolder(task.projectId) });
  const archiveMut = useMutation({
    mutationFn: () => api.archiveTask(task.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks', task.projectId] }),
  });

  const isDone = task.status === 'done';
  const canStart = task.status === 'backlog' || task.status === 'needs_attention';
  const canCancel = ACTIVE_STATUSES.has(task.status);
  const isActive = canCancel;
  const chip = STATUS_CHIP[task.status] ?? STATUS_CHIP.backlog;
  const totalRounds = computeTotalRounds(task);

  return (
    <div
      className={clsx(
        'group card-surface cursor-pointer p-2.5',
        RING_BY_STATUS[task.status]
      )}
      onClick={() => setView({ mode: 'taskDetail', taskId: task.id })}
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

      {task.status === 'needs_attention' && task.escalation && (
        <div className="mt-2 rounded-md border border-amber-700/70 bg-amber-950/40 p-2 text-[11px] leading-relaxed text-amber-100 ring-1 ring-amber-700/40">
          <div className="mb-1 flex items-center justify-between">
            <span className="font-medium uppercase tracking-wider text-amber-300">
              ⚠ Stuck — {task.escalation.kind.replace(/_/g, ' ')}
            </span>
            <span className="text-[10px] text-amber-400">iter {task.escalation.iteration}</span>
          </div>
          <div className="whitespace-pre-wrap break-words">{task.escalation.reason}</div>
          <div className="mt-1 text-[10px] text-amber-400/80">
            Click card → resolve options
          </div>
        </div>
      )}
      {task.status === 'needs_attention' && !task.escalation && task.failureReason && (
        <div className="mt-2 rounded-md border border-rose-800/60 bg-rose-950/40 p-2 text-[11px] leading-relaxed text-rose-200">
          <div className="mb-1 font-medium text-rose-300">Why it failed</div>
          <div className="whitespace-pre-wrap break-words">{task.failureReason}</div>
        </div>
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={clsx('chip', chip.bg, chip.text)}>{chip.label}</span>
          {taskCost && taskCost.costUsd > 0 && (
            <span className="font-mono text-[10px] text-neutral-500">
              ${taskCost.costUsd.toFixed(3)} · {formatTokens(taskCost.inputTokens + taskCost.outputTokens)}
            </span>
          )}
          {task.status !== 'done' && task.status !== 'archived' && (
            <RigorControl
              scope="task"
              taskId={task.id}
              projectId={task.projectId}
              current={task.reviewerRigor}
              compact
            />
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
          {isDone && (
            <button
              className="btn btn-ghost"
              onClick={(e) => {
                e.stopPropagation();
                openFolderMut.mutate();
              }}
              disabled={openFolderMut.isPending}
              title="Open project folder"
            >
              📁
            </button>
          )}
        </div>
      </div>
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
