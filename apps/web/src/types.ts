export type TaskStatus =
  | 'backlog'
  | 'planning'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'needs_attention'
  | 'archived';

export const COLUMNS: { key: TaskStatus; label: string }[] = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'planning', label: 'Planning' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'review', label: 'Review' },
  { key: 'done', label: 'Done' },
];

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  runCommand: string | null;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  planJson: string | null;
  progressJson: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AgentRole = 'architect' | 'specialist' | 'reviewer';

export type ReviewSeverity = 'blocker' | 'major' | 'minor' | 'none';

export interface SubtaskProgress {
  subtaskIndex: number;
  description: string;
  round: number;
  maxRounds: number;
  approved: boolean;
  severity: ReviewSeverity;
  feedback: string;
  totalSubtasksDone?: number;
}

export type IdeaStatus = 'pending' | 'approved' | 'rejected' | 'converted';

export interface Idea {
  id: string;
  projectId: string;
  title: string;
  description: string;
  rationale: string;
  status: IdeaStatus;
  convertedTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppRunStatus {
  running: boolean;
  command: string | null;
  pid: number | null;
  startedAt?: string;
}

export interface WsEvent {
  type: string;
  taskId?: string;
  projectId?: string;
  role?: AgentRole;
  payload?: unknown;
  at?: string;
}
