import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { api } from '../api';
import { useUi } from '../store';
import type {
  ReviewSeverity,
  ReviewerRigor,
  SubtaskHistoryEntry,
  SubtaskReviewRow,
  TaskDetail,
  TaskEventRow,
  TaskStatus,
} from '../types';

type Tab = 'plan' | 'subtasks' | 'timeline' | 'costs' | 'raw';

const TABS: { key: Tab; label: string }[] = [
  { key: 'plan', label: 'Plan' },
  { key: 'subtasks', label: 'Subtasks' },
  { key: 'timeline', label: 'Timeline' },
  { key: 'costs', label: 'Costs' },
  { key: 'raw', label: 'Raw events' },
];

const STATUS_CHIP: Record<TaskStatus, { bg: string; text: string; label: string }> = {
  backlog: { bg: 'bg-neutral-800', text: 'text-neutral-400', label: 'Backlog' },
  planning: { bg: 'bg-blue-950/60', text: 'text-blue-300', label: 'Planning' },
  in_progress: { bg: 'bg-indigo-950/60', text: 'text-indigo-300', label: 'In Progress' },
  review: { bg: 'bg-amber-950/60', text: 'text-amber-300', label: 'Review' },
  done: { bg: 'bg-emerald-950/60', text: 'text-emerald-300', label: 'Done' },
  needs_attention: { bg: 'bg-rose-950/60', text: 'text-rose-300', label: 'Needs attention' },
  archived: { bg: 'bg-neutral-900', text: 'text-neutral-500', label: 'Archived' },
};

const SEVERITY_STYLES: Record<ReviewSeverity, string> = {
  blocker: 'text-rose-400',
  major: 'text-amber-400',
  minor: 'text-yellow-300',
  none: 'text-emerald-400',
};

const RIGOR_STYLES: Record<ReviewerRigor, string> = {
  lenient: 'bg-emerald-950/60 text-emerald-300 ring-1 ring-emerald-800/60',
  normal: 'bg-neutral-800 text-neutral-300 ring-1 ring-neutral-700',
  strict: 'bg-rose-950/60 text-rose-300 ring-1 ring-rose-800/60',
};

export function TaskDetailPage({ taskId }: { taskId: string }) {
  const [tab, setTab] = useState<Tab>('subtasks');
  const qc = useQueryClient();
  const detailQ = useQuery({
    queryKey: ['taskDetail', taskId],
    queryFn: () => api.getTaskDetail(taskId),
    refetchOnWindowFocus: false,
  });

  // Re-invalidate on window focus so the timeline stays fresh
  useEffect(() => {
    const h = () => {
      if (!document.hidden) qc.invalidateQueries({ queryKey: ['taskDetail', taskId] });
    };
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
  }, [qc, taskId]);

  if (detailQ.isLoading || !detailQ.data) {
    return (
      <div className="flex h-full items-center justify-center text-neutral-500">
        {detailQ.isError ? `Failed to load: ${(detailQ.error as Error).message}` : 'Loading…'}
      </div>
    );
  }

  const detail = detailQ.data;
  const { task } = detail;
  const chip = STATUS_CHIP[task.status] ?? STATUS_CHIP.backlog;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      {task.escalation && <EscalationBanner detail={detail} onResolved={() => detailQ.refetch()} />}

      <div className="flex flex-col gap-3 border-b border-neutral-800/80 bg-neutral-950/60 px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
              <span className={clsx('chip', chip.bg, chip.text)}>{chip.label}</span>
              <span className={clsx('chip', RIGOR_STYLES[detail.effectiveRigor])}>
                rigor: {detail.effectiveRigor}
              </span>
              <span className="font-mono">{task.id}</span>
              {detail.project && <span className="font-mono text-neutral-600">· {detail.project.name}</span>}
            </div>
            <h1 className="text-lg font-semibold text-neutral-50">{task.title}</h1>
            {task.description && (
              <div className="mt-2 max-h-64 max-w-4xl overflow-y-auto whitespace-pre-wrap rounded-lg border border-neutral-800 bg-neutral-900/60 p-3 text-sm leading-relaxed text-neutral-300">
                {task.description}
              </div>
            )}
            {task.hints.length > 0 && (
              <div className="mt-2 max-w-4xl rounded-lg border border-indigo-800/60 bg-indigo-950/40 p-3 text-xs leading-relaxed text-indigo-200">
                <div className="mb-1 font-medium text-indigo-300">Hints to the planner</div>
                <ol className="list-decimal space-y-0.5 pl-4">
                  {task.hints.map((h, i) => (
                    <li key={i}>{h}</li>
                  ))}
                </ol>
              </div>
            )}
          </div>
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3 text-xs text-neutral-400">
            <div className="font-mono text-neutral-500">
              ${detail.cost.costUsd.toFixed(4)}
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-neutral-600">
              {detail.cost.inputTokens + detail.cost.outputTokens} tokens
            </div>
          </div>
        </div>
      </div>

      <LiveActivity taskId={task.id} status={task.status} projectId={task.projectId} />

      <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-neutral-800 bg-neutral-950/90 px-4 backdrop-blur">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={clsx(
              'px-3 py-2 text-xs font-medium transition',
              tab === t.key
                ? 'border-b-2 border-indigo-500 text-neutral-100'
                : 'text-neutral-500 hover:text-neutral-300'
            )}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="px-6 py-4">
        {tab === 'plan' && <PlanTab detail={detail} />}
        {tab === 'subtasks' && <SubtasksTab detail={detail} />}
        {tab === 'timeline' && <TimelineTab detail={detail} />}
        {tab === 'costs' && <CostsTab detail={detail} />}
        {tab === 'raw' && <RawEventsTab detail={detail} />}
      </div>
    </div>
  );
}

function PlanTab({ detail }: { detail: TaskDetail }) {
  const plan = detail.plan;
  if (!plan || plan.subtasks.length === 0) {
    return <div className="text-sm text-neutral-500">No plan yet.</div>;
  }
  return (
    <div className="space-y-2">
      <div className="text-xs text-neutral-500">
        Current rolling plan ({plan.subtasks.length} subtask{plan.subtasks.length === 1 ? '' : 's'})
      </div>
      <ol className="space-y-2">
        {plan.subtasks.map((s, i) => (
          <li
            key={i}
            className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3"
          >
            <div className="text-sm text-neutral-100">
              <span className="mr-2 font-mono text-neutral-500">{i + 1}.</span>
              {s.description}
            </div>
            {s.touches && s.touches.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {s.touches.map((t) => (
                  <span
                    key={t}
                    className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
      {detail.checkpoints.length > 1 && (
        <div className="mt-6">
          <div className="mb-2 text-xs text-neutral-500">
            Plan history ({detail.checkpoints.length} checkpoint{detail.checkpoints.length === 1 ? '' : 's'})
          </div>
          <div className="space-y-1">
            {detail.checkpoints.map((c) => (
              <details
                key={c.id}
                className="rounded border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-xs"
              >
                <summary className="cursor-pointer text-neutral-400 hover:text-neutral-200">
                  iteration {c.iteration} · hash {c.planHash.slice(0, 8)} ·{' '}
                  {c.plan.subtasks.length} subtask{c.plan.subtasks.length === 1 ? '' : 's'} ·{' '}
                  {new Date(c.createdAt).toLocaleTimeString()}
                </summary>
                <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-neutral-500">
                  {c.plan.subtasks.map((s, i) => (
                    <li key={i}>{s.description}</li>
                  ))}
                </ol>
              </details>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SubtasksTab({ detail }: { detail: TaskDetail }) {
  const reviewsByIndex = useMemo(() => {
    const map = new Map<number, SubtaskReviewRow[]>();
    for (const r of detail.reviews) {
      const arr = map.get(r.subtaskIndex) ?? [];
      arr.push(r);
      map.set(r.subtaskIndex, arr);
    }
    return map;
  }, [detail.reviews]);

  if (detail.history.length === 0) {
    return <div className="text-sm text-neutral-500">No subtasks executed yet.</div>;
  }

  return (
    <div className="space-y-3">
      {detail.history.map((entry) => {
        const rounds = reviewsByIndex.get(entry.index) ?? [];
        return <SubtaskCard key={entry.index} entry={entry} rounds={rounds} />;
      })}
    </div>
  );
}

function SubtaskCard({
  entry,
  rounds,
}: {
  entry: SubtaskHistoryEntry;
  rounds: SubtaskReviewRow[];
}) {
  const [open, setOpen] = useState(!entry.approved);
  return (
    <div
      className={clsx(
        'rounded-lg border p-3',
        entry.approved
          ? 'border-emerald-900/40 bg-emerald-950/20'
          : 'border-rose-900/40 bg-rose-950/20'
      )}
    >
      <button
        className="flex w-full items-center justify-between gap-2 text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-mono text-neutral-500">#{entry.index + 1}</span>
            <span
              className={clsx(
                'font-medium',
                entry.approved ? 'text-emerald-300' : 'text-rose-300'
              )}
            >
              {entry.approved ? '✓ approved' : '✗ rejected'}
            </span>
            <span className="text-neutral-500">
              · {entry.rounds} round{entry.rounds === 1 ? '' : 's'}
            </span>
          </div>
          <div className="mt-1 truncate text-sm text-neutral-100">{entry.description}</div>
        </div>
        <span className="text-xs text-neutral-500">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {entry.touches.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {entry.touches.map((t) => (
                <span
                  key={t}
                  className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400"
                >
                  {t}
                </span>
              ))}
            </div>
          )}

          {entry.finalSummary && (
            <div className="rounded border border-neutral-800 bg-neutral-900/60 p-2 text-xs leading-relaxed text-neutral-300">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">
                Specialist final summary
              </div>
              <div className="whitespace-pre-wrap">{entry.finalSummary}</div>
            </div>
          )}

          {rounds.length > 0 ? (
            <div className="space-y-2">
              <div className="text-[10px] uppercase tracking-wider text-neutral-500">
                Review rounds
              </div>
              {rounds.map((r) => (
                <div
                  key={r.id}
                  className="rounded border border-neutral-800 bg-neutral-900/40 p-2 text-xs"
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] text-neutral-500">
                    <span>round {r.round}</span>
                    <span
                      className={clsx(
                        'font-medium',
                        r.approved ? 'text-emerald-400' : SEVERITY_STYLES[r.severity] ?? 'text-neutral-300'
                      )}
                    >
                      {r.approved ? '✓ approved' : `${r.severity}`}
                    </span>
                    {r.rigor && (
                      <span className={clsx('chip', RIGOR_STYLES[r.rigor])}>{r.rigor}</span>
                    )}
                    <span className="font-mono text-neutral-600">
                      {new Date(r.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="whitespace-pre-wrap text-neutral-300">{r.feedback}</div>
                  {r.suggestedChanges && r.suggestedChanges.length > 0 && (
                    <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[11px] text-neutral-400">
                      {r.suggestedChanges.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  )}
                  {r.specialistSummary && r.specialistSummary !== entry.finalSummary && (
                    <details className="mt-1.5">
                      <summary className="cursor-pointer text-[10px] text-neutral-500">
                        specialist summary (round {r.round})
                      </summary>
                      <div className="mt-1 whitespace-pre-wrap rounded bg-black/30 p-2 font-mono text-[10px] text-neutral-400">
                        {r.specialistSummary}
                      </div>
                    </details>
                  )}
                </div>
              ))}
            </div>
          ) : (
            // Legacy fallback
            entry.lastFeedback && (
              <div className="rounded border border-neutral-800 bg-neutral-900/40 p-2 text-xs">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">
                  Last reviewer feedback
                </div>
                <div className="whitespace-pre-wrap text-neutral-300">{entry.lastFeedback}</div>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

function TimelineTab({ detail }: { detail: TaskDetail }) {
  if (detail.events.length === 0) {
    return <div className="text-sm text-neutral-500">No events yet.</div>;
  }
  const events = [...detail.events].reverse();
  return (
    <div className="space-y-1">
      {events.map((ev) => (
        <TimelineRow key={ev.id} ev={ev} />
      ))}
    </div>
  );
}

function TimelineRow({ ev }: { ev: TaskEventRow }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const payload = ev.payload as Record<string, unknown> | null;
  const title = ev.phase.replace(/_/g, ' ');
  const detail = summarizeTimelinePayload(ev.phase, payload);
  const isLongError = ev.phase === 'error' || ev.phase === 'cancelled';

  const TRUNCATE_AT = 140;
  const isLongSummary = detail.length > TRUNCATE_AT;
  const hasPayload = !!payload && Object.keys(payload).length > 0;
  const isExpandable = isLongSummary || hasPayload;
  const summary = isLongSummary ? `${detail.slice(0, TRUNCATE_AT)}…` : detail;

  const copyText = () => {
    const body = payload ? `${detail}\n\n${safeStringify(payload)}` : detail;
    navigator.clipboard
      .writeText(body)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  const toggle = () => isExpandable && setOpen((o) => !o);

  return (
    <div className="rounded border border-neutral-800/60 bg-neutral-900/30 text-xs transition hover:border-neutral-700">
      <div className="flex items-start gap-3 px-3 py-1.5">
        <div className="w-20 shrink-0 font-mono text-[10px] text-neutral-600">
          {new Date(ev.createdAt).toLocaleTimeString()}
        </div>
        <div className="w-28 shrink-0">
          <span className={clsx('chip', phaseChipClass(ev.phase))}>{title}</span>
        </div>
        <button
          type="button"
          onClick={toggle}
          className={clsx(
            'min-w-0 flex-1 text-left whitespace-pre-wrap break-words text-neutral-400',
            isExpandable ? 'cursor-pointer hover:text-neutral-200' : 'cursor-default',
            isLongError && 'font-mono text-[11px] text-neutral-300'
          )}
          aria-expanded={open}
        >
          {open ? detail : summary}
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={copyText}
            title="Copy"
            className="rounded px-1.5 py-0.5 text-[10px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          >
            {copied ? '✓' : '⧉'}
          </button>
          {isExpandable && (
            <button
              type="button"
              onClick={toggle}
              aria-label={open ? 'Collapse' : 'Expand'}
              className="rounded px-1.5 py-0.5 text-[10px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            >
              {open ? '▾' : '▸'}
            </button>
          )}
        </div>
      </div>
      {open && payload && (
        <JsonView value={payload} />
      )}
    </div>
  );
}

function JsonView({ value }: { value: unknown }) {
  const text = safeStringify(value);
  return (
    <pre className="mx-3 mb-2 max-h-96 overflow-auto rounded bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-neutral-300">
      <code dangerouslySetInnerHTML={{ __html: highlightJson(text) }} />
    </pre>
  );
}

function highlightJson(src: string): string {
  const escaped = src
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Order matters: match strings (with optional trailing colon for keys) first,
  // then numbers, booleans, null.
  return escaped.replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b(true|false|null)\b/g,
    (_m, str, colon, num, kw) => {
      if (str) {
        if (colon) {
          return `<span class="text-violet-300">${str}</span><span class="text-neutral-500">${colon}</span>`;
        }
        return `<span class="text-emerald-300">${str}</span>`;
      }
      if (num) return `<span class="text-amber-300">${num}</span>`;
      if (kw) {
        const cls = kw === 'null' ? 'text-neutral-500' : 'text-sky-300';
        return `<span class="${cls}">${kw}</span>`;
      }
      return _m;
    }
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

const ROLE_STYLES: Record<string, string> = {
  architect: 'bg-blue-950/60 text-blue-300 ring-1 ring-blue-800/60',
  specialist: 'bg-indigo-950/60 text-indigo-300 ring-1 ring-indigo-800/60',
  reviewer: 'bg-amber-950/60 text-amber-300 ring-1 ring-amber-800/60',
  operator: 'bg-emerald-950/60 text-emerald-300 ring-1 ring-emerald-800/60',
};

function relativeTime(iso: string, nowMs: number): string {
  const dt = nowMs - new Date(iso).getTime();
  if (dt < 1500) return 'just now';
  const s = Math.floor(dt / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s ago`;
}

function LiveActivity({
  taskId,
  status,
  projectId,
}: {
  taskId: string;
  status: TaskStatus;
  projectId: string;
}) {
  const lastTool = useUi((s) => s.lastTool[taskId]);
  const progress = useUi((s) => s.subtaskProgress[taskId]);
  const qc = useQueryClient();
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<null | 'cancel' | 'done'>(null);

  const isLive =
    status === 'planning' || status === 'in_progress' || status === 'review';

  useEffect(() => {
    if (!isLive) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isLive]);

  if (!isLive) return null;

  const stale = lastTool ? now - new Date(lastTool.at).getTime() > 90_000 : true;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['taskDetail', taskId] });
    qc.invalidateQueries({ queryKey: ['tasks', projectId] });
  };

  const onCancel = async () => {
    if (busy) return;
    setBusy('cancel');
    try {
      await api.cancelTask(taskId);
      refresh();
    } finally {
      setBusy(null);
    }
  };

  const [gracefulStopRequested, setGracefulStopRequested] = useState(false);
  const onMarkDone = async () => {
    if (busy) return;
    if (
      !confirm(
        "Let the current subtask finish (specialist + reviewer), then mark the task as done. No more replans. Continue?"
      )
    )
      return;
    setBusy('done');
    try {
      await api.resolveEscalation(taskId, { action: 'approve_anyway' });
      setGracefulStopRequested(true);
      refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-neutral-800/80 bg-neutral-900/40 px-6 py-2 text-xs">
      <span className="flex items-center gap-1.5 text-neutral-300">
        <span
          className={clsx(
            'inline-block h-2 w-2 rounded-full',
            stale ? 'bg-neutral-600' : 'animate-pulse bg-emerald-400'
          )}
        />
        {stale ? 'Idle / waiting' : 'Live'}
      </span>
      {lastTool && (
        <>
          <span className={clsx('chip', ROLE_STYLES[lastTool.role] ?? ROLE_STYLES.specialist)}>
            {lastTool.role}
          </span>
          <span className="font-mono text-neutral-300">{lastTool.name}</span>
          {lastTool.target && (
            <span className="min-w-0 flex-1 truncate font-mono text-neutral-500" title={lastTool.target}>
              {lastTool.target}
            </span>
          )}
          <span className="shrink-0 text-neutral-600">{relativeTime(lastTool.at, now)}</span>
        </>
      )}
      {!lastTool && progress && (
        <span className="min-w-0 flex-1 text-neutral-500">
          subtask #{progress.subtaskIndex + 1} · round {progress.round}/{progress.maxRounds}
        </span>
      )}
      {!lastTool && !progress && (
        <span className="min-w-0 flex-1 text-neutral-600">Waiting for first tool call…</span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {gracefulStopRequested ? (
          <span className="rounded border border-emerald-800/60 bg-emerald-950/40 px-2 py-0.5 text-[11px] text-emerald-300">
            Stopping after current round…
          </span>
        ) : (
          <button
            type="button"
            onClick={onMarkDone}
            disabled={busy !== null}
            className="rounded border border-emerald-800/60 bg-emerald-950/40 px-2 py-0.5 text-[11px] text-emerald-300 hover:bg-emerald-900/60 disabled:opacity-40"
            title="Let the current subtask finish (specialist + reviewer), then mark done"
          >
            {busy === 'done' ? '…' : 'Stop, it’s good'}
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          disabled={busy !== null}
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
          title="Hard cancel — kill the in-flight agent immediately"
        >
          {busy === 'cancel' ? '…' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}

function phaseChipClass(phase: string): string {
  if (phase.startsWith('escalation')) return 'bg-rose-950/60 text-rose-300 ring-1 ring-rose-800/60';
  if (phase === 'replan_done' || phase === 'plan_ready' || phase === 'plan_provided')
    return 'bg-blue-950/60 text-blue-300 ring-1 ring-blue-800/60';
  if (phase === 'subtask_start') return 'bg-indigo-950/60 text-indigo-300 ring-1 ring-indigo-800/60';
  if (phase === 'subtask_review') return 'bg-amber-950/60 text-amber-300 ring-1 ring-amber-800/60';
  if (phase === 'error' || phase === 'cancelled') return 'bg-rose-950/60 text-rose-300 ring-1 ring-rose-800/60';
  return 'bg-neutral-800 text-neutral-300';
}

function summarizeTimelinePayload(phase: string, p: Record<string, unknown> | null): string {
  if (!p) return '';
  if (phase === 'plan_ready' || phase === 'plan_provided') {
    const subtasks = p.subtasks as { description?: string }[] | undefined;
    const n = subtasks?.length ?? 0;
    const hash = typeof p.planHash === 'string' ? ` · hash ${p.planHash.slice(0, 8)}` : '';
    const iter = typeof p.iteration === 'number' ? ` · iter ${p.iteration}` : '';
    return `${n} subtask${n === 1 ? '' : 's'}${iter}${hash}`;
  }
  if (phase === 'subtask_start') {
    return `#${(Number(p.subtaskIndex) || 0) + 1} round ${p.round}/${p.maxRounds}${p.rigor ? ` · ${p.rigor}` : ''}${p.description ? ` · ${(p.description as string).slice(0, 80)}` : ''}`;
  }
  if (phase === 'subtask_review') {
    const review = p.review as { approved?: boolean; severity?: string; feedback?: string } | undefined;
    if (review) {
      return `#${(Number(p.subtaskIndex) || 0) + 1} round ${p.round}: ${review.approved ? '✓ approved' : `${review.severity} — ${(review.feedback ?? '').slice(0, 80)}`}`;
    }
    return '';
  }
  if (phase === 'replan_start') return `iteration ${p.iteration}`;
  if (phase === 'replan_done') {
    const cmd = typeof p.runCommand === 'string' ? ` · runCommand: ${p.runCommand}` : '';
    return `iteration ${p.iteration}${cmd}`;
  }
  if (phase === 'escalation_raised') {
    return `${p.kind ?? ''} · ${(p.reason as string ?? '').slice(0, 120)}`;
  }
  if (phase === 'error' || phase === 'cancelled') {
    return String(p.message ?? '');
  }
  try {
    return JSON.stringify(p).slice(0, 160);
  } catch {
    return '';
  }
}

function CostsTab({ detail }: { detail: TaskDetail }) {
  if (detail.costByRole.length === 0) {
    return <div className="text-sm text-neutral-500">No agent runs yet.</div>;
  }
  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
        <div className="text-xs uppercase tracking-wider text-neutral-500">Total</div>
        <div className="mt-1 font-mono text-lg text-neutral-100">
          ${detail.cost.costUsd.toFixed(4)}
        </div>
        <div className="text-xs text-neutral-500">
          {detail.cost.inputTokens.toLocaleString()} in · {detail.cost.outputTokens.toLocaleString()} out
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-4">
        {detail.costByRole.map((r) => (
          <div key={r.role} className="rounded border border-neutral-800 bg-neutral-900/40 p-3 text-xs">
            <div className="text-neutral-500">{r.role}</div>
            <div className="mt-0.5 font-mono text-sm text-neutral-200">${r.costUsd.toFixed(4)}</div>
            <div className="text-[10px] text-neutral-600">
              {r.inputTokens.toLocaleString()} in · {r.outputTokens.toLocaleString()} out
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RawEventsTab({ detail }: { detail: TaskDetail }) {
  const text = useMemo(() => JSON.stringify(detail.events, null, 2), [detail.events]);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-neutral-500">
        <span>
          {detail.events.length} event{detail.events.length === 1 ? '' : 's'}
        </span>
        <button className="btn btn-ghost" onClick={copy}>
          {copied ? '✓ Copied' : 'Copy JSON'}
        </button>
      </div>
      <pre className="max-h-[70vh] overflow-auto rounded-lg border border-neutral-800 bg-black/70 p-3 font-mono text-[10px] leading-snug text-neutral-300">
        {text}
      </pre>
    </div>
  );
}

// ---------- Escalation banner (used in Improvement 3 as well) ----------

function EscalationBanner({
  detail,
  onResolved,
}: {
  detail: TaskDetail;
  onResolved: () => void;
}) {
  const task = detail.task;
  const [mode, setMode] = useState<'idle' | 'hint' | 'edit_plan'>('idle');
  const [hint, setHint] = useState('');
  const [editablePlan, setEditablePlan] = useState<string>(
    JSON.stringify(detail.plan ?? { subtasks: [] }, null, 2)
  );
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const resolve = async (body: Parameters<typeof api.resolveEscalation>[1]) => {
    setError(null);
    setBusy(true);
    try {
      await api.resolveEscalation(task.id, body);
      qc.invalidateQueries({ queryKey: ['taskDetail', task.id] });
      qc.invalidateQueries({ queryKey: ['tasks', task.projectId] });
      setMode('idle');
      setHint('');
      onResolved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!task.escalation) return null;

  const kindCopy: Record<typeof task.escalation.kind, { label: string; hint: string }> = {
    repeated_plan: {
      label: 'Stuck — repeated plan',
      hint: 'Architect keeps emitting the same plan. Give it a hint or edit the plan.',
    },
    no_progress: {
      label: 'Stuck — no progress',
      hint: 'No new files touched and no subtasks approved. Give a hint, edit the plan, or abandon.',
    },
    repeating_blocker: {
      label: 'Stuck — repeating blocker',
      hint: 'Same reviewer complaint three rounds in a row. Give a hint or edit the plan.',
    },
    agent_refusal: {
      label: 'Claude declined this task',
      hint: 'The specialist refused this subtask on policy grounds twice in a row. Options: reframe the prompt via "Give a hint", approve manually to skip, or abandon.',
    },
    architect_refusal: {
      label: 'Planner declined this task',
      hint: 'The architect refused to plan this task on policy grounds. Reframe the task description (Give a hint) or abandon.',
    },
  };
  const copy = kindCopy[task.escalation.kind];

  return (
    <div className="border-b border-rose-900/60 bg-rose-950/40 px-6 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 text-xs uppercase tracking-wider text-rose-400">
            {copy.label} (iteration {task.escalation.iteration})
          </div>
          <div className="text-sm text-rose-100">{task.escalation.reason}</div>
          <div className="mt-1 text-xs text-rose-200/80">{copy.hint}</div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            className="btn btn-success"
            disabled={busy}
            onClick={() => resolve({ action: 'approve_anyway' })}
          >
            Approve anyway
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => setMode('hint')}>
            Give a hint
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => setMode('edit_plan')}>
            Edit plan
          </button>
          <button
            className="btn btn-danger"
            disabled={busy}
            onClick={() => resolve({ action: 'abandon' })}
          >
            Abandon
          </button>
        </div>
      </div>

      {mode === 'hint' && (
        <div className="mt-3 flex flex-col gap-2">
          <textarea
            className="min-h-[80px] rounded-md border border-neutral-700 bg-neutral-900 p-2 font-mono text-xs text-neutral-100 focus:border-indigo-500 focus:outline-none"
            placeholder="e.g. The API key is stored in the .env file as ANTHROPIC_API_KEY. You must read it before making the call."
            value={hint}
            onChange={(e) => setHint(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <button className="btn btn-ghost" disabled={busy} onClick={() => setMode('idle')}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={busy || !hint.trim()}
              onClick={() => resolve({ action: 'add_hint', hint: hint.trim() })}
            >
              Send hint & resume
            </button>
          </div>
        </div>
      )}

      {mode === 'edit_plan' && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="text-[11px] text-rose-300">
            Edit the plan JSON. Must have 1-3 subtasks with {'{ description, touches? }'}.
          </div>
          <textarea
            className="min-h-[180px] rounded-md border border-neutral-700 bg-neutral-900 p-2 font-mono text-[11px] text-neutral-100 focus:border-indigo-500 focus:outline-none"
            value={editablePlan}
            onChange={(e) => setEditablePlan(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <button className="btn btn-ghost" disabled={busy} onClick={() => setMode('idle')}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => {
                try {
                  const parsed = JSON.parse(editablePlan);
                  resolve({ action: 'edit_plan', plan: parsed });
                } catch (e) {
                  setError(`Invalid JSON: ${(e as Error).message}`);
                }
              }}
            >
              Save plan & resume
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-2 break-all rounded border border-rose-900 bg-rose-950/60 p-2 text-xs text-rose-200">
          {error}
        </div>
      )}
    </div>
  );
}
