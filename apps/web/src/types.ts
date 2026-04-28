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

export type ReviewerRigor = 'lenient' | 'normal' | 'strict';

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  runCommand: string | null;
  reviewerRigor: ReviewerRigor;
}

export interface Escalation {
  reason: string;
  kind:
    | 'repeated_plan'
    | 'no_progress'
    | 'repeating_blocker'
    | 'agent_refusal'
    | 'architect_refusal';
  raisedAt: string;
  iteration: number;
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
  reviewerRigor: ReviewerRigor | null;
  escalation: Escalation | null;
  hints: string[];
  architectNotes: string | null;
}

export type AgentRole = 'architect' | 'specialist' | 'reviewer' | 'operator';

export type ReviewSeverity = 'blocker' | 'major' | 'minor' | 'none';

export interface Subtask {
  description: string;
  touches?: string[];
}

export interface ArchitectPlan {
  subtasks: Subtask[];
}

export interface SubtaskProgress {
  subtaskIndex: number;
  description: string;
  round: number;
  maxRounds: number;
  approved: boolean;
  severity: ReviewSeverity;
  feedback: string;
  suggestedChanges?: string[];
  rigor?: ReviewerRigor;
  totalSubtasksDone?: number;
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

export interface SubtaskReviewRow {
  id: string;
  taskId: string;
  subtaskIndex: number;
  round: number;
  approved: boolean;
  severity: ReviewSeverity;
  feedback: string;
  suggestedChanges: string[] | null;
  specialistSummary: string | null;
  rigor: ReviewerRigor | null;
  createdAt: string;
}

export interface TaskEventRow {
  id: string;
  taskId: string;
  projectId: string | null;
  phase: string;
  role: AgentRole | null;
  payload: unknown;
  createdAt: string;
}

export interface TaskCheckpointRow {
  id: string;
  taskId: string;
  iteration: number;
  planHash: string;
  plan: ArchitectPlan;
  history: SubtaskHistoryEntry[];
  touchedFiles: string[];
  createdAt: string;
}

export interface TaskCostByRole {
  role: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface TaskDetail {
  task: Task;
  project: { id: string; name: string; path: string; reviewerRigor: ReviewerRigor } | null;
  plan: ArchitectPlan | null;
  history: SubtaskHistoryEntry[];
  reviews: SubtaskReviewRow[];
  events: TaskEventRow[];
  checkpoints: TaskCheckpointRow[];
  cost: { inputTokens: number; outputTokens: number; costUsd: number };
  costByRole: TaskCostByRole[];
  effectiveRigor: ReviewerRigor;
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

export type OperatorSessionStatus = 'idle' | 'analyzing' | 'running' | 'stopped' | 'failed';

export interface OperatorEntrypoint {
  path: string;
  kind: string;
}

export interface OperatorAnalysis {
  summary: string;
  stack: string[];
  entrypoints: OperatorEntrypoint[];
  runCommandGuess: string | null;
  confidence: number;
}

export interface OperatorSession {
  id: string;
  projectId: string;
  createdAt: string;
  analysis: OperatorAnalysis | null;
  status: OperatorSessionStatus;
}

export type OperatorMessageRole = 'user' | 'operator' | 'system';

export interface OperatorMessage {
  id: string;
  sessionId: string;
  role: OperatorMessageRole;
  content: string;
  toolUse: unknown | null;
  createdAt: string;
}

export interface WsEvent {
  type: string;
  taskId?: string;
  projectId?: string;
  sessionId?: string;
  role?: AgentRole;
  payload?: unknown;
  at?: string;
}
