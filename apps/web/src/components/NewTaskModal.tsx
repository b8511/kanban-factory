import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

interface Props {
  projectId: string;
  onClose: () => void;
}

export function NewTaskModal({ projectId, onClose }: Props) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const qc = useQueryClient();

  const mut = useMutation({
    mutationFn: () => api.createTask(projectId, title.trim(), description.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks', projectId] });
      onClose();
    },
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[460px] rounded-xl border border-neutral-800 bg-neutral-950 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-base font-semibold text-neutral-100">New task</h2>
        <label className="mb-1.5 block text-xs font-medium text-neutral-400">Title</label>
        <input
          className="mb-3 w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What should the agents build?"
          autoFocus
        />
        <label className="mb-1.5 block text-xs font-medium text-neutral-400">Description</label>
        <textarea
          className="mb-3 h-32 w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Acceptance criteria, context, gotchas…"
        />
        {mut.isError && (
          <div className="mb-2 rounded-md border border-rose-900/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
            {(mut.error as Error).message}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => mut.mutate()}
            disabled={!title.trim() || mut.isPending}
          >
            {mut.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
