import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type {
  ArchitectPlan,
  Escalation,
  Idea,
  IdeaStatus,
  OperatorAnalysis,
  OperatorMessage,
  OperatorMessageRole,
  OperatorSession,
  OperatorSessionStatus,
  Project,
  ReviewSeverity,
  ReviewerRigor,
  SubtaskHistoryEntry,
  SubtaskReviewRow,
  Task,
  TaskCheckpointRow,
  TaskEventRow,
  TaskStatus,
  AgentRole,
} from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '..', 'data.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL,
    plan_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id);

  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    role TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL,
    transcript_path TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS subtask_reviews (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    subtask_index INTEGER NOT NULL,
    round INTEGER NOT NULL,
    approved INTEGER NOT NULL,
    severity TEXT NOT NULL,
    feedback TEXT NOT NULL,
    suggested_changes_json TEXT,
    specialist_summary TEXT,
    rigor TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS subtask_reviews_task_idx ON subtask_reviews(task_id, subtask_index, round);

  CREATE TABLE IF NOT EXISTS task_events (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    project_id TEXT,
    phase TEXT NOT NULL,
    role TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events(task_id, created_at);

  CREATE TABLE IF NOT EXISTS task_checkpoints (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    iteration INTEGER NOT NULL,
    plan_hash TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    history_json TEXT NOT NULL,
    touched_files_json TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS task_checkpoints_task_idx ON task_checkpoints(task_id, iteration);

  CREATE TABLE IF NOT EXISTS operator_sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    analysis_json TEXT,
    status TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS operator_sessions_project_idx ON operator_sessions(project_id, created_at);

  CREATE TABLE IF NOT EXISTS operator_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_use_json TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES operator_sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS operator_messages_session_idx ON operator_messages(session_id, created_at);
`);

const existingRunCols = new Set(
  (db.prepare("PRAGMA table_info('agent_runs')").all() as { name: string }[]).map((r) => r.name)
);
for (const [col, ddl] of [
  ['input_tokens', 'INTEGER DEFAULT 0'],
  ['output_tokens', 'INTEGER DEFAULT 0'],
  ['cost_usd', 'REAL DEFAULT 0'],
  ['project_id', 'TEXT'],
] as const) {
  if (!existingRunCols.has(col)) {
    db.exec(`ALTER TABLE agent_runs ADD COLUMN ${col} ${ddl}`);
  }
}

const existingTaskCols = new Set(
  (db.prepare("PRAGMA table_info('tasks')").all() as { name: string }[]).map((r) => r.name)
);
for (const [col, ddl] of [
  ['progress_json', 'TEXT'],
  ['failure_reason', 'TEXT'],
  ['reviewer_rigor', 'TEXT'],
  ['escalation_json', 'TEXT'],
  ['hints_json', 'TEXT'],
  ['architect_notes', 'TEXT'],
] as const) {
  if (!existingTaskCols.has(col)) {
    db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${ddl}`);
  }
}

const existingProjectCols = new Set(
  (db.prepare("PRAGMA table_info('projects')").all() as { name: string }[]).map((r) => r.name)
);
if (!existingProjectCols.has('run_command')) {
  db.exec(`ALTER TABLE projects ADD COLUMN run_command TEXT`);
}
if (!existingProjectCols.has('reviewer_rigor')) {
  db.exec(`ALTER TABLE projects ADD COLUMN reviewer_rigor TEXT DEFAULT 'normal'`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS ideas (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    rationale TEXT NOT NULL,
    status TEXT NOT NULL,
    converted_task_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS ideas_project_status_idx ON ideas(project_id, status);
`);

function normalizeRigor(v: unknown): ReviewerRigor {
  return v === 'lenient' || v === 'strict' ? v : 'normal';
}

function nullableRigor(v: unknown): ReviewerRigor | null {
  return v === 'lenient' || v === 'normal' || v === 'strict' ? v : null;
}

function rowToProject(row: any): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: row.created_at,
    runCommand: row.run_command ?? null,
    reviewerRigor: normalizeRigor(row.reviewer_rigor),
  };
}

function rowToIdea(row: any): Idea {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    rationale: row.rationale,
    status: row.status as IdeaStatus,
    convertedTaskId: row.converted_task_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJsonOr<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function rowToTask(row: any): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    planJson: row.plan_json,
    progressJson: row.progress_json ?? null,
    failureReason: row.failure_reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewerRigor: nullableRigor(row.reviewer_rigor),
    escalation: parseJsonOr<Escalation | null>(row.escalation_json, null),
    hints: parseJsonOr<string[]>(row.hints_json, []),
    architectNotes: row.architect_notes ?? null,
  };
}

function rowToSubtaskReview(row: any): SubtaskReviewRow {
  return {
    id: row.id,
    taskId: row.task_id,
    subtaskIndex: row.subtask_index,
    round: row.round,
    approved: !!row.approved,
    severity: row.severity as ReviewSeverity,
    feedback: row.feedback,
    suggestedChanges: parseJsonOr<string[] | null>(row.suggested_changes_json, null),
    specialistSummary: row.specialist_summary ?? null,
    rigor: nullableRigor(row.rigor),
    createdAt: row.created_at,
  };
}

function rowToTaskEvent(row: any): TaskEventRow {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id ?? null,
    phase: row.phase,
    role: (row.role ?? null) as AgentRole | null,
    payload: parseJsonOr<unknown>(row.payload_json, null),
    createdAt: row.created_at,
  };
}

function rowToCheckpoint(row: any): TaskCheckpointRow {
  return {
    id: row.id,
    taskId: row.task_id,
    iteration: row.iteration,
    planHash: row.plan_hash,
    plan: parseJsonOr<ArchitectPlan>(row.plan_json, { subtasks: [] }),
    history: parseJsonOr<SubtaskHistoryEntry[]>(row.history_json, []),
    touchedFiles: parseJsonOr<string[]>(row.touched_files_json, []),
    createdAt: row.created_at,
  };
}

function rowToOperatorSession(row: any): OperatorSession {
  return {
    id: row.id,
    projectId: row.project_id,
    createdAt: row.created_at,
    analysis: parseJsonOr<OperatorAnalysis | null>(row.analysis_json, null),
    status: row.status as OperatorSessionStatus,
  };
}

function rowToOperatorMessage(row: any): OperatorMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as OperatorMessageRole,
    content: row.content,
    toolUse: parseJsonOr<unknown>(row.tool_use_json, null),
    createdAt: row.created_at,
  };
}

const listProjectsStmt = db.prepare('SELECT * FROM projects ORDER BY created_at ASC');
const getProjectStmt = db.prepare('SELECT * FROM projects WHERE id = ?');
const insertProjectStmt = db.prepare(
  "INSERT INTO projects (id, name, path, created_at, reviewer_rigor) VALUES (?, ?, ?, ?, 'normal')"
);
const deleteProjectStmt = db.prepare('DELETE FROM projects WHERE id = ?');
const updateProjectRunCommandStmt = db.prepare(
  'UPDATE projects SET run_command = ? WHERE id = ?'
);
const updateProjectRigorStmt = db.prepare(
  'UPDATE projects SET reviewer_rigor = ? WHERE id = ?'
);

const listTasksStmt = db.prepare(
  "SELECT * FROM tasks WHERE project_id = ? AND status != 'archived' ORDER BY created_at ASC"
);
const listAllTasksStmt = db.prepare(
  'SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC'
);
const countArchivedStmt = db.prepare(
  "SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status = 'archived'"
);
const getTaskStmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
const insertTaskStmt = db.prepare(
  `INSERT INTO tasks (id, project_id, title, description, status, plan_json, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const updateTaskStatusStmt = db.prepare(
  'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?'
);
const updateTaskPlanStmt = db.prepare(
  'UPDATE tasks SET plan_json = ?, updated_at = ? WHERE id = ?'
);
const updateTaskProgressStmt = db.prepare(
  'UPDATE tasks SET progress_json = ?, updated_at = ? WHERE id = ?'
);
const updateTaskFailureStmt = db.prepare(
  'UPDATE tasks SET failure_reason = ?, updated_at = ? WHERE id = ?'
);
const updateTaskRigorStmt = db.prepare(
  'UPDATE tasks SET reviewer_rigor = ?, updated_at = ? WHERE id = ?'
);
const updateTaskEscalationStmt = db.prepare(
  'UPDATE tasks SET escalation_json = ?, updated_at = ? WHERE id = ?'
);
const updateTaskHintsStmt = db.prepare(
  'UPDATE tasks SET hints_json = ?, updated_at = ? WHERE id = ?'
);
const updateTaskArchitectNotesStmt = db.prepare(
  'UPDATE tasks SET architect_notes = ?, updated_at = ? WHERE id = ?'
);

const insertRunStmt = db.prepare(
  `INSERT INTO agent_runs (id, task_id, project_id, role, started_at, status, transcript_path)
   VALUES (?, ?, ?, ?, ?, 'running', ?)`
);
const finishRunStmt = db.prepare(
  `UPDATE agent_runs
   SET ended_at = ?, status = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?
   WHERE id = ?`
);

const listPendingIdeasStmt = db.prepare(
  "SELECT * FROM ideas WHERE project_id = ? AND status = 'pending' ORDER BY created_at DESC"
);
const listRecentIdeasStmt = db.prepare(
  "SELECT * FROM ideas WHERE project_id = ? ORDER BY created_at DESC LIMIT ?"
);
const getIdeaStmt = db.prepare('SELECT * FROM ideas WHERE id = ?');
const insertIdeaStmt = db.prepare(
  `INSERT INTO ideas (id, project_id, title, description, rationale, status, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
);
const updateIdeaStatusStmt = db.prepare(
  'UPDATE ideas SET status = ?, converted_task_id = ?, updated_at = ? WHERE id = ?'
);
const deleteIdeaStmt = db.prepare('DELETE FROM ideas WHERE id = ?');

const taskCostStmt = db.prepare(
  `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cost_usd), 0) AS cost_usd
   FROM agent_runs WHERE task_id = ?`
);
const taskCostByRoleStmt = db.prepare(
  `SELECT role,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cost_usd), 0) AS cost_usd
   FROM agent_runs WHERE task_id = ? GROUP BY role`
);

const insertSubtaskReviewStmt = db.prepare(
  `INSERT INTO subtask_reviews
   (id, task_id, subtask_index, round, approved, severity, feedback, suggested_changes_json, specialist_summary, rigor, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const listSubtaskReviewsStmt = db.prepare(
  'SELECT * FROM subtask_reviews WHERE task_id = ? ORDER BY subtask_index ASC, round ASC'
);

const insertTaskEventStmt = db.prepare(
  `INSERT INTO task_events (id, task_id, project_id, phase, role, payload_json, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const listTaskEventsStmt = db.prepare(
  'SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC, id ASC'
);
const listTaskEventsSinceStmt = db.prepare(
  'SELECT * FROM task_events WHERE task_id = ? AND created_at > ? ORDER BY created_at ASC, id ASC'
);

const insertCheckpointStmt = db.prepare(
  `INSERT INTO task_checkpoints
   (id, task_id, iteration, plan_hash, plan_json, history_json, touched_files_json, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const listCheckpointsStmt = db.prepare(
  'SELECT * FROM task_checkpoints WHERE task_id = ? ORDER BY iteration ASC, created_at ASC'
);
const latestCheckpointStmt = db.prepare(
  'SELECT * FROM task_checkpoints WHERE task_id = ? ORDER BY iteration DESC, created_at DESC LIMIT 1'
);

const insertOperatorSessionStmt = db.prepare(
  `INSERT INTO operator_sessions (id, project_id, created_at, analysis_json, status)
   VALUES (?, ?, ?, ?, ?)`
);
const getOperatorSessionStmt = db.prepare('SELECT * FROM operator_sessions WHERE id = ?');
const latestOperatorSessionStmt = db.prepare(
  'SELECT * FROM operator_sessions WHERE project_id = ? ORDER BY created_at DESC LIMIT 1'
);
const updateOperatorSessionStmt = db.prepare(
  'UPDATE operator_sessions SET analysis_json = ?, status = ? WHERE id = ?'
);
const updateOperatorSessionStatusStmt = db.prepare(
  'UPDATE operator_sessions SET status = ? WHERE id = ?'
);

const insertOperatorMessageStmt = db.prepare(
  `INSERT INTO operator_messages (id, session_id, role, content, tool_use_json, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const listOperatorMessagesStmt = db.prepare(
  'SELECT * FROM operator_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC'
);

export const store = {
  listProjects(): Project[] {
    return listProjectsStmt.all().map(rowToProject);
  },
  getProject(id: string): Project | null {
    const row = getProjectStmt.get(id);
    return row ? rowToProject(row) : null;
  },
  createProject(name: string, folderPath: string): Project {
    const id = nanoid(10);
    const createdAt = new Date().toISOString();
    insertProjectStmt.run(id, name, folderPath, createdAt);
    return { id, name, path: folderPath, createdAt, runCommand: null, reviewerRigor: 'normal' };
  },
  deleteProject(id: string): void {
    deleteProjectStmt.run(id);
  },
  setProjectRunCommand(id: string, runCommand: string | null): void {
    updateProjectRunCommandStmt.run(runCommand, id);
  },
  setProjectRigor(id: string, rigor: ReviewerRigor): void {
    updateProjectRigorStmt.run(rigor, id);
  },

  listTasks(projectId: string, includeArchived = false): Task[] {
    const stmt = includeArchived ? listAllTasksStmt : listTasksStmt;
    return stmt.all(projectId).map(rowToTask);
  },
  countArchivedTasks(projectId: string): number {
    const row = countArchivedStmt.get(projectId) as { n: number };
    return row.n ?? 0;
  },
  getTask(id: string): Task | null {
    const row = getTaskStmt.get(id);
    return row ? rowToTask(row) : null;
  },
  createTask(projectId: string, title: string, description: string | null): Task {
    const id = nanoid(10);
    const now = new Date().toISOString();
    insertTaskStmt.run(id, projectId, title, description, 'backlog', null, now, now);
    return {
      id,
      projectId,
      title,
      description,
      status: 'backlog',
      planJson: null,
      progressJson: null,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
      reviewerRigor: null,
      escalation: null,
      hints: [],
      architectNotes: null,
    };
  },
  setTaskStatus(id: string, status: TaskStatus): void {
    updateTaskStatusStmt.run(status, new Date().toISOString(), id);
  },
  setTaskPlan(id: string, planJson: string): void {
    updateTaskPlanStmt.run(planJson, new Date().toISOString(), id);
  },
  setTaskProgress(id: string, progressJson: string): void {
    updateTaskProgressStmt.run(progressJson, new Date().toISOString(), id);
  },
  setTaskFailure(id: string, reason: string | null): void {
    updateTaskFailureStmt.run(reason, new Date().toISOString(), id);
  },
  setTaskRigor(id: string, rigor: ReviewerRigor | null): void {
    updateTaskRigorStmt.run(rigor, new Date().toISOString(), id);
  },
  setTaskEscalation(id: string, escalation: Escalation | null): void {
    updateTaskEscalationStmt.run(
      escalation ? JSON.stringify(escalation) : null,
      new Date().toISOString(),
      id
    );
  },
  clearTaskEscalation(id: string): void {
    updateTaskEscalationStmt.run(null, new Date().toISOString(), id);
  },
  appendTaskHint(id: string, hint: string): string[] {
    const task = this.getTask(id);
    const hints = task ? [...task.hints, hint] : [hint];
    updateTaskHintsStmt.run(JSON.stringify(hints), new Date().toISOString(), id);
    return hints;
  },
  clearTaskHints(id: string): void {
    updateTaskHintsStmt.run(null, new Date().toISOString(), id);
  },
  setArchitectNotes(id: string, notes: string | null): void {
    updateTaskArchitectNotesStmt.run(notes, new Date().toISOString(), id);
  },

  startRun(taskId: string, role: string, transcriptPath: string, projectId?: string | null): string {
    const id = nanoid(10);
    insertRunStmt.run(id, taskId, projectId ?? null, role, new Date().toISOString(), transcriptPath);
    return id;
  },
  finishRun(
    id: string,
    ok: boolean,
    usage: { inputTokens: number; outputTokens: number; costUsd: number } = {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    }
  ): void {
    finishRunStmt.run(
      new Date().toISOString(),
      ok ? 'ok' : 'failed',
      usage.inputTokens,
      usage.outputTokens,
      usage.costUsd,
      id
    );
  },
  listPendingIdeas(projectId: string): Idea[] {
    return listPendingIdeasStmt.all(projectId).map(rowToIdea);
  },
  listRecentIdeas(projectId: string, limit = 20): Idea[] {
    return listRecentIdeasStmt.all(projectId, limit).map(rowToIdea);
  },
  getIdea(id: string): Idea | null {
    const row = getIdeaStmt.get(id);
    return row ? rowToIdea(row) : null;
  },
  createIdea(
    projectId: string,
    title: string,
    description: string,
    rationale: string
  ): Idea {
    const id = nanoid(10);
    const now = new Date().toISOString();
    insertIdeaStmt.run(id, projectId, title, description, rationale, now, now);
    return {
      id,
      projectId,
      title,
      description,
      rationale,
      status: 'pending',
      convertedTaskId: null,
      createdAt: now,
      updatedAt: now,
    };
  },
  setIdeaStatus(id: string, status: IdeaStatus, convertedTaskId: string | null = null): void {
    updateIdeaStatusStmt.run(status, convertedTaskId, new Date().toISOString(), id);
  },
  deleteIdea(id: string): void {
    deleteIdeaStmt.run(id);
  },

  getTaskCost(taskId: string): { inputTokens: number; outputTokens: number; costUsd: number } {
    const row = taskCostStmt.get(taskId) as {
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    };
    return {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      costUsd: row.cost_usd,
    };
  },
  getTaskCostByRole(
    taskId: string
  ): { role: string; inputTokens: number; outputTokens: number; costUsd: number }[] {
    const rows = taskCostByRoleStmt.all(taskId) as {
      role: string;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    }[];
    return rows.map((r) => ({
      role: r.role,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      costUsd: r.cost_usd,
    }));
  },

  insertSubtaskReview(row: {
    taskId: string;
    subtaskIndex: number;
    round: number;
    approved: boolean;
    severity: ReviewSeverity;
    feedback: string;
    suggestedChanges?: string[];
    specialistSummary?: string;
    rigor?: ReviewerRigor | null;
  }): void {
    insertSubtaskReviewStmt.run(
      nanoid(10),
      row.taskId,
      row.subtaskIndex,
      row.round,
      row.approved ? 1 : 0,
      row.severity,
      row.feedback,
      row.suggestedChanges ? JSON.stringify(row.suggestedChanges) : null,
      row.specialistSummary ?? null,
      row.rigor ?? null,
      new Date().toISOString()
    );
  },
  listSubtaskReviews(taskId: string): SubtaskReviewRow[] {
    return listSubtaskReviewsStmt.all(taskId).map(rowToSubtaskReview);
  },

  insertTaskEvent(row: {
    taskId: string;
    projectId?: string | null;
    phase: string;
    role?: AgentRole | null;
    payload: unknown;
  }): TaskEventRow {
    const id = nanoid(10);
    const createdAt = new Date().toISOString();
    insertTaskEventStmt.run(
      id,
      row.taskId,
      row.projectId ?? null,
      row.phase,
      row.role ?? null,
      JSON.stringify(row.payload ?? null),
      createdAt
    );
    return {
      id,
      taskId: row.taskId,
      projectId: row.projectId ?? null,
      phase: row.phase,
      role: row.role ?? null,
      payload: row.payload ?? null,
      createdAt,
    };
  },
  listTaskEvents(taskId: string, sinceIso?: string): TaskEventRow[] {
    const rows = sinceIso
      ? listTaskEventsSinceStmt.all(taskId, sinceIso)
      : listTaskEventsStmt.all(taskId);
    return rows.map(rowToTaskEvent);
  },

  insertCheckpoint(row: {
    taskId: string;
    iteration: number;
    planHash: string;
    plan: ArchitectPlan;
    history: SubtaskHistoryEntry[];
    touchedFiles?: string[];
  }): void {
    insertCheckpointStmt.run(
      nanoid(10),
      row.taskId,
      row.iteration,
      row.planHash,
      JSON.stringify(row.plan),
      JSON.stringify(row.history),
      row.touchedFiles ? JSON.stringify(row.touchedFiles) : null,
      new Date().toISOString()
    );
  },
  listCheckpoints(taskId: string): TaskCheckpointRow[] {
    return listCheckpointsStmt.all(taskId).map(rowToCheckpoint);
  },
  latestCheckpoint(taskId: string): TaskCheckpointRow | null {
    const row = latestCheckpointStmt.get(taskId);
    return row ? rowToCheckpoint(row) : null;
  },

  createOperatorSession(projectId: string, analysis: OperatorAnalysis | null = null): OperatorSession {
    const id = nanoid(10);
    const createdAt = new Date().toISOString();
    const status: OperatorSessionStatus = 'idle';
    insertOperatorSessionStmt.run(
      id,
      projectId,
      createdAt,
      analysis ? JSON.stringify(analysis) : null,
      status
    );
    return { id, projectId, createdAt, analysis, status };
  },
  getOperatorSession(id: string): OperatorSession | null {
    const row = getOperatorSessionStmt.get(id);
    return row ? rowToOperatorSession(row) : null;
  },
  latestOperatorSession(projectId: string): OperatorSession | null {
    const row = latestOperatorSessionStmt.get(projectId);
    return row ? rowToOperatorSession(row) : null;
  },
  updateOperatorSession(
    id: string,
    patch: { analysis?: OperatorAnalysis | null; status?: OperatorSessionStatus }
  ): void {
    const current = this.getOperatorSession(id);
    if (!current) return;
    if (patch.analysis !== undefined) {
      updateOperatorSessionStmt.run(
        patch.analysis ? JSON.stringify(patch.analysis) : null,
        patch.status ?? current.status,
        id
      );
    } else if (patch.status !== undefined) {
      updateOperatorSessionStatusStmt.run(patch.status, id);
    }
  },
  appendOperatorMessage(row: {
    sessionId: string;
    role: OperatorMessageRole;
    content: string;
    toolUse?: unknown;
  }): OperatorMessage {
    const id = nanoid(10);
    const createdAt = new Date().toISOString();
    insertOperatorMessageStmt.run(
      id,
      row.sessionId,
      row.role,
      row.content,
      row.toolUse ? JSON.stringify(row.toolUse) : null,
      createdAt
    );
    return {
      id,
      sessionId: row.sessionId,
      role: row.role,
      content: row.content,
      toolUse: row.toolUse ?? null,
      createdAt,
    };
  },
  listOperatorMessages(sessionId: string): OperatorMessage[] {
    return listOperatorMessagesStmt.all(sessionId).map(rowToOperatorMessage);
  },
};

export { db };
