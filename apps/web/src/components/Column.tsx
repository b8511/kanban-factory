import clsx from 'clsx';
import type { Task, TaskStatus } from '../types';
import { TaskCard } from './TaskCard';
import { ArchivedSection } from './ArchivedSection';

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
  return (
    <div className="flex min-w-[220px] flex-col overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-950/40 backdrop-blur-sm">
      <div className={clsx('h-[3px] bg-gradient-to-r', accent.bar)} />
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className={clsx('text-[11px] font-semibold uppercase tracking-[0.12em]', accent.label)}>
          {label}
        </span>
        <span className={clsx('rounded-full px-2 py-0.5 text-[10px] font-semibold', accent.countBg)}>
          {tasks.length}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {tasks.length === 0 ? (
          <div className="mx-1 rounded-md border border-dashed border-neutral-800 py-6 text-center text-[11px] text-neutral-600">
            Empty
          </div>
        ) : (
          tasks.map((t) => <TaskCard key={t.id} task={t} />)
        )}
        {status === 'done' && <ArchivedSection projectId={projectId} />}
      </div>
    </div>
  );
}
