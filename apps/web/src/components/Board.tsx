import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useUi } from '../store';
import { COLUMNS, type Task } from '../types';
import { Column } from './Column';
import { IdeasColumn } from './IdeasColumn';
import { NewTaskModal } from './NewTaskModal';

interface Props {
  projectId: string;
}

export function Board({ projectId }: Props) {
  const setView = useUi((s) => s.setView);
  const [showNewTask, setShowNewTask] = useState(false);

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

  const hasDoneTask = tasks.some((t) => t.status === 'done');

  if (isLoading) {
    return <div className="p-4 text-sm text-neutral-500">Loading...</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-end gap-2 border-b border-neutral-800/60 bg-neutral-950/30 px-5 py-2">
        <button
          className="btn btn-ghost shadow-lg shadow-indigo-500/10"
          onClick={() => setView({ mode: 'operate', projectId })}
          disabled={!hasDoneTask}
          title={hasDoneTask ? 'Open the Operate page' : 'Finish a task first'}
        >
          🚀 Operate
        </button>
        <button
          className="btn btn-primary shadow-lg shadow-indigo-500/20"
          onClick={() => setShowNewTask(true)}
        >
          + New Task
        </button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[260px_repeat(5,minmax(240px,1fr))] gap-3 overflow-x-auto px-5 py-4">
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

      {showNewTask && (
        <NewTaskModal projectId={projectId} onClose={() => setShowNewTask(false)} />
      )}
    </div>
  );
}
