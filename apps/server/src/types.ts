export type TaskStatus =
  | 'backlog'
  | 'planning'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'needs_attention'
  | 'archived';

export const TASK_COLUMNS: TaskStatus[] = [
  'backlog',
  'planning',
  'in_progress',
  'review',
  'done',
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

export interface Subtask {
  description: string;
  touches?: string[];
}

export interface ArchitectPlan {
  subtasks: Subtask[];
}

export type ReviewSeverity = 'blocker' | 'major' | 'minor' | 'none';

export interface ReviewResult {
  approved: boolean;
  severity: ReviewSeverity;
  feedback: string;
  suggestedChanges?: string[];
}

export type IdeaStatus = 'pending' | 'approved' | 'rejected' | 'converted';

export interface Idea {
  id: string;
  projectId: string;
  title: string;
  description: string;
  rationale: string;
  status: IdeaStatus;
  createdAt: string;
  updatedAt: string;
  convertedTaskId: string | null;
}

export interface SubtaskHistoryEntry {
  index: number;
  description: string;
  touches: string[];
  rounds: number;
  approved: boolean;
  lastFeedback: string;
  finalSummary: string;
}

export type AgentEventType =
  | 'status'
  | 'log'
  | 'tool_use'
  | 'message'
  | 'error'
  | 'task_updated'
  | 'project_updated'
  | 'task_cost'
  | 'run_start'
  | 'run_end'
  | 'run_error'
  | 'subtask_progress'
  | 'app_run_started'
  | 'app_run_log'
  | 'app_run_stopped'
  | 'ideas_updated';

export interface AgentEvent {
  type: AgentEventType;
  taskId?: string;
  projectId?: string;
  role?: AgentRole;
  payload: unknown;
  at: string;
}
