import clsx from 'clsx';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useUi } from '../store';
import type { Project } from '../types';

interface Props {
  projects: Project[];
  onNewProject: () => void;
}

export function TabBar({ projects, onNewProject }: Props) {
  const { selectedProjectId, setSelectedProject } = useUi();
  const qc = useQueryClient();
  const deleteMut = useMutation({
    mutationFn: (id: string) => api.deleteProject(id),
    onSuccess: (_void, id) => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      if (selectedProjectId === id) setSelectedProject(null);
    },
  });

  const handleDelete = (e: React.MouseEvent, p: Project) => {
    e.stopPropagation();
    const ok = window.confirm(
      `Delete project "${p.name}"?\n\nThis removes the project, all its tasks, ideas, and session history from Kanban Factory.\nThe folder on disk (${p.path}) is NOT touched.`
    );
    if (!ok) return;
    deleteMut.mutate(p.id);
  };

  return (
    <div className="flex items-center gap-1 border-t border-neutral-900 bg-neutral-950/60 px-4 pt-1">
      {projects.map((p) => {
        const active = selectedProjectId === p.id;
        const busy = deleteMut.isPending && deleteMut.variables === p.id;
        return (
          <div
            key={p.id}
            className={clsx(
              'group relative flex items-center transition',
              busy && 'opacity-50'
            )}
          >
            <button
              onClick={() => setSelectedProject(p.id)}
              className={clsx(
                'relative py-1.5 pl-3 pr-7 text-sm transition',
                active ? 'text-neutral-50' : 'text-neutral-500 hover:text-neutral-200'
              )}
              title={p.path}
            >
              {p.name}
              <span
                className={clsx(
                  'absolute inset-x-2 -bottom-[1px] h-[2px] rounded-full transition',
                  active ? 'bg-gradient-to-r from-indigo-400 to-violet-500' : 'bg-transparent'
                )}
              />
            </button>
            <button
              onClick={(e) => handleDelete(e, p)}
              disabled={busy}
              className={clsx(
                'absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 text-[10px] leading-none transition',
                active
                  ? 'text-neutral-500 hover:bg-rose-900/40 hover:text-rose-300'
                  : 'text-neutral-700 opacity-0 hover:bg-rose-900/40 hover:text-rose-300 group-hover:opacity-100'
              )}
              title="Delete project"
            >
              ✕
            </button>
          </div>
        );
      })}
      <button
        onClick={onNewProject}
        className="ml-1 rounded px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-900 hover:text-neutral-200"
        title="New project"
      >
        +
      </button>
    </div>
  );
}
