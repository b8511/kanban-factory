import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type { Task } from '../types';

interface Props {
  projectId: string;
}

export function ArchivedSection({ projectId }: Props) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const archivedQ = useQuery<Task[]>({
    queryKey: ['archivedTasks', projectId],
    queryFn: () => api.listArchivedTasks(projectId),
    refetchInterval: open ? 3000 : false,
  });
  const archived = archivedQ.data ?? [];

  const unarchiveMut = useMutation({
    mutationFn: (id: string) => api.unarchiveTask(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks', projectId] });
      qc.invalidateQueries({ queryKey: ['archivedTasks', projectId] });
    },
  });

  if (archived.length === 0 && !open) return null;

  return (
    <div className="mt-1 rounded-md border border-neutral-900 bg-neutral-950/40">
      <button
        className="flex w-full items-center justify-between px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-neutral-500 transition hover:text-neutral-300"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-1.5">
          <span>{open ? '▾' : '▸'}</span>
          <span>Archived</span>
          <span className="rounded-full bg-neutral-900 px-1.5 py-0.5 text-[9px] text-neutral-500">
            {archived.length}
          </span>
        </span>
      </button>
      {open && (
        <ul className="divide-y divide-neutral-900 border-t border-neutral-900">
          {archived.length === 0 ? (
            <li className="px-3 py-2 text-[11px] text-neutral-600">No archived tasks.</li>
          ) : (
            archived.map((t) => (
              <li key={t.id} className="group flex items-start gap-2 px-2.5 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] text-neutral-300">{t.title}</div>
                  <div className="text-[10px] text-neutral-600">
                    {new Date(t.updatedAt).toLocaleDateString()}
                  </div>
                </div>
                <button
                  className="opacity-0 transition group-hover:opacity-100 rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
                  onClick={() => unarchiveMut.mutate(t.id)}
                  disabled={unarchiveMut.isPending}
                  title="Restore to backlog"
                >
                  ↩ Restore
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
