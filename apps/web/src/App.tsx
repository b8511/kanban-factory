import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useUi } from './store';
import { useWebSocket } from './hooks/useWebSocket';
import { TabBar } from './components/TabBar';
import { Board } from './components/Board';
import { NewProjectModal } from './components/NewProjectModal';
import { NewTaskModal } from './components/NewTaskModal';
import { TaskDrawer } from './components/TaskDrawer';
import type { WsEvent } from './types';

export default function App() {
  const [showNewProject, setShowNewProject] = useState(false);
  const [showNewTask, setShowNewTask] = useState(false);
  const [logs, setLogs] = useState<WsEvent[]>([]);

  useWebSocket((ev) => setLogs((prev) => [...prev.slice(-499), ev]));

  const { selectedProjectId, setSelectedProject } = useUi();
  const projectsQ = useQuery({ queryKey: ['projects'], queryFn: api.listProjects });

  useEffect(() => {
    if (!selectedProjectId && projectsQ.data && projectsQ.data.length > 0) {
      setSelectedProject(projectsQ.data[0].id);
    }
  }, [projectsQ.data, selectedProjectId, setSelectedProject]);

  const selectedProject = projectsQ.data?.find((p) => p.id === selectedProjectId) ?? null;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-neutral-800/80 bg-neutral-950/70 backdrop-blur-md">
        <div className="flex items-center justify-between px-5 py-2.5">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-violet-600 text-[11px] font-bold text-white shadow-lg shadow-indigo-500/20">
                K
              </div>
              <span className="text-sm font-semibold tracking-tight text-neutral-100">
                Kanban Factory
              </span>
            </div>
            {selectedProject && (
              <>
                <span className="h-4 w-px bg-neutral-800" />
                <span className="font-mono text-xs text-neutral-500">{selectedProject.path}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              className="btn btn-primary shadow-lg shadow-indigo-500/20"
              onClick={() => setShowNewTask(true)}
              disabled={!selectedProjectId}
            >
              + New Task
            </button>
          </div>
        </div>
        <TabBar projects={projectsQ.data ?? []} onNewProject={() => setShowNewProject(true)} />
      </header>

      <main className="flex-1 overflow-hidden">
        {selectedProjectId ? (
          <Board projectId={selectedProjectId} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-neutral-500">
            <div className="text-sm">No project selected.</div>
            <button
              className="btn btn-ghost"
              onClick={() => setShowNewProject(true)}
            >
              + Create your first project
            </button>
          </div>
        )}
      </main>

      {showNewProject && <NewProjectModal onClose={() => setShowNewProject(false)} />}
      {showNewTask && selectedProjectId && (
        <NewTaskModal projectId={selectedProjectId} onClose={() => setShowNewTask(false)} />
      )}
      <TaskDrawer logs={logs} />
    </div>
  );
}
