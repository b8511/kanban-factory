import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { COLUMNS, type Task } from '../types';
import { Column } from './Column';
import { IdeasColumn } from './IdeasColumn';

interface Props {
  projectId: string;
}

export function Board({ projectId }: Props) {
  const { data: tasks = [], isLoading } = useQuery<Task[]>({
    queryKey: ['tasks', projectId],
    queryFn: () => api.listTasks(projectId),
    refetchInterval: (query) => {
      const data = query.state.data;
      const active = data?.some((t) =>
        ['planning', 'in_progress', 'review'].includes(t.status)
      );
      return active ? 3000 : false;
    },
  });

  if (isLoading) {
    return <div className="p-4 text-sm text-neutral-500">Loading...</div>;
  }

  return (
    <div className="grid h-full grid-cols-[260px_repeat(5,minmax(240px,1fr))] gap-3 overflow-x-auto px-5 py-4">
      <IdeasColumn projectId={projectId} />
      {COLUMNS.map((col) => (
        <Column
          key={col.key}
          status={col.key}
          label={col.label}
          projectId={projectId}
          tasks={tasks.filter((t) => {
            if (col.key === 'backlog')
              return t.status === 'backlog' || t.status === 'needs_attention';
            if (col.key === 'done') return t.status === 'done';
            return t.status === col.key;
          })}
        />
      ))}
    </div>
  );
}
