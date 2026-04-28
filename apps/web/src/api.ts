import type {
  AppRunStatus,
  ArchitectPlan,
  Idea,
  OperatorAnalysis,
  OperatorMessage,
  OperatorSession,
  Project,
  ReviewerRigor,
  Task,
  TaskDetail,
  TaskEventRow,
} from './types';

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface Cost {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type ResolveEscalationAction = 'approve_anyway' | 'abandon' | 'edit_plan' | 'add_hint';

export const api = {
  listProjects: () => fetch('/api/projects').then(j<Project[]>),
  createProject: (name: string, path: string) =>
    fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, path }),
    }).then(j<Project>),
  deleteProject: (id: string) =>
    fetch(`/api/projects/${id}`, { method: 'DELETE' }).then(j<void>),
  setProjectRigor: (projectId: string, rigor: ReviewerRigor) =>
    fetch(`/api/projects/${projectId}/rigor`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rigor }),
    }).then(j<Project>),

  listTasks: (projectId: string) =>
    fetch(`/api/tasks?project=${encodeURIComponent(projectId)}`).then(j<Task[]>),
  listArchivedTasks: (projectId: string) =>
    fetch(`/api/tasks?project=${encodeURIComponent(projectId)}&includeArchived=1`)
      .then(j<Task[]>)
      .then((all) => all.filter((t) => t.status === 'archived')),
  createTask: (projectId: string, title: string, description: string) =>
    fetch('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, title, description }),
    }).then(j<Task>),
  startTask: (id: string) =>
    fetch(`/api/tasks/${id}/start`, { method: 'POST' }).then(j<{ started: boolean }>),
  cancelTask: (id: string) =>
    fetch(`/api/tasks/${id}/cancel`, { method: 'POST' }).then(j<{ cancelled: boolean }>),
  archiveTask: (id: string) =>
    fetch(`/api/tasks/${id}/archive`, { method: 'POST' }).then(j<{ archived: boolean }>),
  unarchiveTask: (id: string) =>
    fetch(`/api/tasks/${id}/unarchive`, { method: 'POST' }).then(j<{ unarchived: boolean }>),
  getCost: (id: string) => fetch(`/api/tasks/${id}/cost`).then(j<Cost>),
  getTaskDetail: (id: string) => fetch(`/api/tasks/${id}/detail`).then(j<TaskDetail>),
  listTaskEvents: (id: string, since?: string) => {
    const qs = since ? `?since=${encodeURIComponent(since)}` : '';
    return fetch(`/api/tasks/${id}/events${qs}`).then(j<TaskEventRow[]>);
  },
  setTaskRigor: (id: string, rigor: ReviewerRigor | null) =>
    fetch(`/api/tasks/${id}/rigor`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rigor }),
    }).then(j<Task>),
  resolveEscalation: (
    id: string,
    body: {
      action: ResolveEscalationAction;
      plan?: ArchitectPlan;
      hint?: string;
    }
  ) =>
    fetch(`/api/tasks/${id}/resolve-escalation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(j<{ ok: boolean; task?: Task; resumed?: boolean }>),

  pickFolder: () =>
    fetch('/api/projects/pick-folder', { method: 'POST' }).then(j<{ path: string | null }>),
  setRunCommand: (projectId: string, runCommand: string | null) =>
    fetch(`/api/projects/${projectId}/run-command`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runCommand }),
    }).then(j<Project>),
  openFolder: (projectId: string) =>
    fetch(`/api/projects/${projectId}/open-folder`, { method: 'POST' }).then(j<{ ok: boolean }>),
  runProject: (projectId: string) =>
    fetch(`/api/projects/${projectId}/run`, { method: 'POST' }).then(
      j<{ started: boolean; status: AppRunStatus }>
    ),
  stopProject: (projectId: string) =>
    fetch(`/api/projects/${projectId}/stop-run`, { method: 'POST' }).then(j<{ stopping: boolean }>),
  getRunStatus: (projectId: string) =>
    fetch(`/api/projects/${projectId}/run-status`).then(j<AppRunStatus>),

  listIdeas: (projectId: string) =>
    fetch(`/api/ideas?project=${encodeURIComponent(projectId)}`).then(j<Idea[]>),
  getScoutStatus: (projectId: string) =>
    fetch(`/api/ideas/status?project=${encodeURIComponent(projectId)}`).then(
      j<{ scouting: boolean }>
    ),
  scoutIdeas: (projectId: string) =>
    fetch('/api/ideas/scout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId }),
    }).then(j<{ scouting: boolean }>),
  approveIdea: (id: string) =>
    fetch(`/api/ideas/${id}/approve`, { method: 'POST' }).then(j<{ idea: Idea; task: Task }>),
  rejectIdea: (id: string) =>
    fetch(`/api/ideas/${id}/reject`, { method: 'POST' }).then(j<{ ok: boolean }>),

  startOperatorSession: (projectId: string) =>
    fetch(`/api/projects/${projectId}/operator/start`, { method: 'POST' }).then(
      j<{ sessionId: string; analysis: OperatorAnalysis | null }>
    ),
  getOperatorSession: (projectId: string) =>
    fetch(`/api/projects/${projectId}/operator/session`).then(
      j<{
        session: OperatorSession;
        messages: OperatorMessage[];
        terminal: { stream: 'stdout' | 'stderr'; line: string; at: string }[];
        lastExit: { code: number | null; signal: string | null; finishedAt: string } | null;
        running: boolean;
        command: string | null;
        pid: number | null;
      } | null>
    ),
  sendOperatorMessage: (sessionId: string, content: string) =>
    fetch(`/api/operator/${sessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    }).then(j<{ ok: boolean }>),
  runOperator: (sessionId: string, command?: string) =>
    fetch(`/api/operator/${sessionId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command ? { command } : {}),
    }).then(j<{ started: boolean }>),
  stopOperator: (sessionId: string) =>
    fetch(`/api/operator/${sessionId}/stop`, { method: 'POST' }).then(j<{ stopping: boolean }>),
  sendOperatorDiagnostic: (sessionId: string, body: { title?: string; extra?: string }) =>
    fetch(`/api/operator/${sessionId}/send-to-factory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(j<{ task: Task }>),
};
