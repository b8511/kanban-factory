import { useState } from 'react';
import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useUi } from '../store';
import type { Project, Task, TaskStatus } from '../types';
import { TaskCard } from './TaskCard';
import { ArchivedSection } from './ArchivedSection';
import { RigorControl } from './RigorControl';

const OPERATOR_FIX_RE = /^from operator session\b/i;
function isOperatorFix(t: Task): boolean {
  return !!t.description && OPERATOR_FIX_RE.test(t.description.trim());
}

interface Props {
  status: TaskStatus;
  label: string;
  tasks: Task[];
  projectId: string;
}

const COLUMN_ACCENTS: Record<string, { bar: string; label: string; countBg: string }> = {
  backlog: {
    bar: 'from-neutral-500/60 to-neutral-600/20',
    label: 'text-neutral-400',
    countBg: 'bg-neutral-800 text-neutral-400',
  },
  planning: {
    bar: 'from-blue-400 to-blue-600/40',
    label: 'text-blue-300',
    countBg: 'bg-blue-950/60 text-blue-300',
  },
  in_progress: {
    bar: 'from-indigo-400 to-indigo-600/40',
    label: 'text-indigo-300',
    countBg: 'bg-indigo-950/60 text-indigo-300',
  },
  review: {
    bar: 'from-amber-400 to-amber-600/40',
    label: 'text-amber-300',
    countBg: 'bg-amber-950/60 text-amber-300',
  },
  done: {
    bar: 'from-emerald-400 to-emerald-600/40',
    label: 'text-emerald-300',
    countBg: 'bg-emerald-950/60 text-emerald-300',
  },
};

export function Column({ status, label, tasks, projectId }: Props) {
  const accent = COLUMN_ACCENTS[status] ?? COLUMN_ACCENTS.backlog;
  const projectsQ = useQuery({
    queryKey: ['projects'],
    queryFn: api.listProjects,
    enabled: status === 'review',
  });
  const project: Project | undefined = projectsQ.data?.find((p) => p.id === projectId);

  return (
    <div className="flex min-w-[220px] flex-col overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-950/40 backdrop-blur-sm">
      <div className={clsx('h-[3px] bg-gradient-to-r', accent.bar)} />
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span
            className={clsx(
              'text-[11px] font-semibold uppercase tracking-[0.12em]',
              accent.label
            )}
          >
            {label}
          </span>
          <span
            className={clsx(
              'rounded-full px-2 py-0.5 text-[10px] font-semibold',
              accent.countBg
            )}
          >
            {tasks.length}
          </span>
        </div>
        {status === 'review' && project && (
          <RigorControl
            scope="project"
            projectId={projectId}
            current={project.reviewerRigor}
            compact
          />
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {(() => {
          if (tasks.length === 0) {
            return (
              <div className="mx-1 rounded-md border border-dashed border-neutral-800 py-6 text-center text-[11px] text-neutral-600">
                Empty
              </div>
            );
          }
          if (status !== 'done') {
            return tasks.map((t) => <TaskCard key={t.id} task={t} />);
          }
          // Done column: separate operator-spawned fix tasks into a collapsed
          // sub-section so the project's main task stays the dominant card.
          const main = tasks.filter((t) => !isOperatorFix(t));
          const fixes = tasks.filter(isOperatorFix);
          return (
            <>
              {main.map((t) => (
                <TaskCard key={t.id} task={t} />
              ))}
              {fixes.length > 0 && <OperatorFixesSection fixes={fixes} />}
            </>
          );
        })()}
        {status === 'done' && <ArchivedSection projectId={projectId} />}
      </div>
    </div>
  );
}

function OperatorFixesSection({ fixes }: { fixes: Task[] }) {
  const [open, setOpen] = useState(false);
  const setView = useUi((s) => s.setView);
  return (
    <div className="mt-1 rounded-md border border-emerald-900/40 bg-emerald-950/20">
      <button
        className="flex w-full items-center justify-between px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-emerald-400/80 transition hover:text-emerald-300"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-1.5">
          <span>{open ? '▾' : '▸'}</span>
          <span>🔧 Fixes from Operate</span>
          <span className="rounded-full bg-emerald-950/60 px-1.5 py-0.5 text-[9px] text-emerald-300">
            {fixes.length}
          </span>
        </span>
      </button>
      {open && (
        <ul className="divide-y divide-emerald-900/30 border-t border-emerald-900/30">
          {fixes.map((t) => (
            <li key={t.id}>
              <button
                className="block w-full px-2.5 py-2 text-left transition hover:bg-emerald-950/30"
                onClick={() => setView({ mode: 'taskDetail', taskId: t.id })}
                title={t.title}
              >
                <div className="truncate text-[12px] text-neutral-200">{t.title}</div>
                <div className="text-[10px] text-neutral-500">
                  {new Date(t.updatedAt).toLocaleDateString()}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

