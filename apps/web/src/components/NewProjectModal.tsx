import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useUi } from '../store';

interface Props {
  onClose: () => void;
}

export function NewProjectModal({ onClose }: Props) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const qc = useQueryClient();
  const { setSelectedProject } = useUi();

  const mut = useMutation({
    mutationFn: () => api.createProject(name.trim(), path.trim()),
    onSuccess: (project) => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      setSelectedProject(project.id);
      onClose();
    },
  });

  const [pickError, setPickError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const pickFolder = async () => {
    setPickError(null);
    setPicking(true);
    try {
      const { path: picked } = await api.pickFolder();
      if (!picked) return;
      setPath(picked);
      if (!name.trim()) {
        const leaf = picked.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
        if (leaf) setName(leaf);
      }
    } catch (e) {
      setPickError((e as Error).message);
    } finally {
      setPicking(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[460px] rounded-xl border border-neutral-800 bg-neutral-950 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-base font-semibold text-neutral-100">New project</h2>

        <label className="mb-1.5 block text-xs font-medium text-neutral-400">Name</label>
        <input
          className="mb-3 w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My App"
          autoFocus
        />

        <label className="mb-1.5 block text-xs font-medium text-neutral-400">
          Project folder <span className="text-neutral-600">(absolute path)</span>
        </label>
        <div className="mb-3 flex gap-2">
          <input
            className="flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 font-mono text-xs text-neutral-100 placeholder-neutral-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="C:\Users\you\projects\my-app"
          />
          <button
            onClick={pickFolder}
            disabled={picking}
            className="btn btn-ghost shrink-0"
            type="button"
          >
            {picking ? 'Picking…' : '📁 Pick…'}
          </button>
        </div>

        {pickError && (
          <div className="mb-2 rounded-md border border-rose-900/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
            {pickError}
          </div>
        )}
        {mut.isError && (
          <div className="mb-2 rounded-md border border-rose-900/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
            {(mut.error as Error).message}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => mut.mutate()}
            disabled={!name.trim() || !path.trim() || mut.isPending}
          >
            {mut.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
