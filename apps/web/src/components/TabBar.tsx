import clsx from 'clsx';
import { useUi } from '../store';
import type { Project } from '../types';

interface Props {
  projects: Project[];
  onNewProject: () => void;
}

export function TabBar({ projects, onNewProject }: Props) {
  const { selectedProjectId, setSelectedProject } = useUi();
  return (
    <div className="flex items-center gap-1 border-t border-neutral-900 bg-neutral-950/60 px-4 pt-1">
      {projects.map((p) => {
        const active = selectedProjectId === p.id;
        return (
          <button
            key={p.id}
            onClick={() => setSelectedProject(p.id)}
            className={clsx(
              'relative px-3 py-1.5 text-sm transition',
              active
                ? 'text-neutral-50'
                : 'text-neutral-500 hover:text-neutral-200'
            )}
          >
            {p.name}
            <span
              className={clsx(
                'absolute inset-x-2 -bottom-[1px] h-[2px] rounded-full transition',
                active ? 'bg-gradient-to-r from-indigo-400 to-violet-500' : 'bg-transparent'
              )}
            />
          </button>
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
