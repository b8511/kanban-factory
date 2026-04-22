import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { Idea, IdeaStatus, Project, Task, TaskStatus } from './types.js';

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
`);

const existingRunCols = new Set(
  (db.prepare("PRAGMA table_info('agent_runs')").all() as { name: string }[]).map((r) => r.name)
);
for (const [col, ddl] of [
  ['input_tokens', 'INTEGER DEFAULT 0'],
  ['output_tokens', 'INTEGER DEFAULT 0'],
  ['cost_usd', 'REAL DEFAULT 0'],
] as const) {
  if (!existingRunCols.has(col)) {
    db.exec(`ALTER TABLE agent_runs ADD COLUMN ${col} ${ddl}`);
  }
}

const existingTaskCols = new Set(
  (db.prepare("PRAGMA table_info('tasks')").all() as { name: string }[]).map((r) => r.name)
);
if (!existingTaskCols.has('progress_json')) {
  db.exec(`ALTER TABLE tasks ADD COLUMN progress_json TEXT`);
}
if (!existingTaskCols.has('failure_reason')) {
  db.exec(`ALTER TABLE tasks ADD COLUMN failure_reason TEXT`);
}

const existingProjectCols = new Set(
  (db.prepare("PRAGMA table_info('projects')").all() as { name: string }[]).map((r) => r.name)
);
if (!existingProjectCols.has('run_command')) {
  db.exec(`ALTER TABLE projects ADD COLUMN run_command TEXT`);
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

function rowToProject(row: any): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: row.created_at,
    runCommand: row.run_command ?? null,
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
  };
}

const listProjectsStmt = db.prepare('SELECT * FROM projects ORDER BY created_at ASC');
const getProjectStmt = db.prepare('SELECT * FROM projects WHERE id = ?');
const insertProjectStmt = db.prepare(
  'INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)'
);
const deleteProjectStmt = db.prepare('DELETE FROM projects WHERE id = ?');
const updateProjectRunCommandStmt = db.prepare(
  'UPDATE projects SET run_command = ? WHERE id = ?'
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

const insertRunStmt = db.prepare(
  `INSERT INTO agent_runs (id, task_id, role, started_at, status, transcript_path)
   VALUES (?, ?, ?, ?, 'running', ?)`
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
    return { id, name, path: folderPath, createdAt, runCommand: null };
  },
  deleteProject(id: string): void {
    deleteProjectStmt.run(id);
  },
  setProjectRunCommand(id: string, runCommand: string | null): void {
    updateProjectRunCommandStmt.run(runCommand, id);
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

  startRun(taskId: string, role: string, transcriptPath: string): string {
    const id = nanoid(10);
    insertRunStmt.run(id, taskId, role, new Date().toISOString(), transcriptPath);
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
};

export { db };
