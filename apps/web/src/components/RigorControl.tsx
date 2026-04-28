import clsx from 'clsx';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type { ReviewerRigor } from '../types';

const OPTIONS: { key: ReviewerRigor; label: string; title: string }[] = [
  { key: 'lenient', label: 'L', title: 'Lenient — approve unless actually broken' },
  { key: 'normal', label: 'N', title: 'Normal — functional verification, no nitpicks' },
  { key: 'strict', label: 'S', title: 'Strict — run every available check' },
];

interface ProjectProps {
  scope: 'project';
  projectId: string;
  current: ReviewerRigor;
  compact?: boolean;
}

interface TaskProps {
  scope: 'task';
  taskId: string;
  projectId: string;
  current: ReviewerRigor | null;
  compact?: boolean;
}

export function RigorControl(props: ProjectProps | TaskProps) {
  const qc = useQueryClient();
  const compact = props.compact;

  const setProject = useMutation({
    mutationFn: (r: ReviewerRigor) => api.setProjectRigor((props as ProjectProps).projectId, r),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  const setTask = useMutation({
    mutationFn: (r: ReviewerRigor | null) => api.setTaskRigor((props as TaskProps).taskId, r),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks', props.projectId] });
      if (props.scope === 'task') qc.invalidateQueries({ queryKey: ['taskDetail', props.taskId] });
    },
  });

  const choose = (r: ReviewerRigor) => {
    if (props.scope === 'project') setProject.mutate(r);
    else setTask.mutate(r);
  };

  const current = props.current;
  const isActive = (k: ReviewerRigor) => current === k;

  return (
    <div
      className={clsx(
        'inline-flex items-center gap-0.5 rounded-md border border-neutral-800 bg-neutral-900/60 p-0.5',
        compact ? 'text-[10px]' : 'text-[11px]'
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          title={o.title}
          className={clsx(
            'rounded px-1.5 py-0.5 font-medium transition',
            isActive(o.key)
              ? 'bg-indigo-600 text-white'
              : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
          )}
          onClick={() => choose(o.key)}
        >
          {compact ? o.label : o.key}
        </button>
      ))}
      {props.scope === 'task' && (
        <button
          title="Inherit project default"
          className={clsx(
            'rounded px-1.5 py-0.5 font-medium transition',
            current === null
              ? 'bg-neutral-700 text-neutral-100'
              : 'text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300'
          )}
          onClick={() => setTask.mutate(null)}
        >
          auto
        </button>
      )}
    </div>
  );
}
