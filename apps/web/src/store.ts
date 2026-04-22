import { create } from 'zustand';
import type { AgentRole, AppRunStatus, SubtaskProgress } from './types';

export interface ToolUseEvent {
  name: string;
  target: string;
  role: AgentRole;
  at: string;
}

export interface CostInfo {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AppRunLogLine {
  stream: 'stdout' | 'stderr';
  line: string;
  at: string;
}

export interface AppRunExit {
  code: number | null;
  signal: string | null;
  finishedAt: string;
}

const MAX_LOG_LINES = 80;
const URL_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s)\]"',]*)?)/gi;

interface UiState {
  selectedProjectId: string | null;
  selectedTaskId: string | null;
  lastTool: Record<string, ToolUseEvent>;
  cost: Record<string, CostInfo>;
  subtaskProgress: Record<string, SubtaskProgress>;
  appRuns: Record<string, AppRunStatus>;
  appRunLogs: Record<string, AppRunLogLine[]>;
  appRunUrls: Record<string, string[]>;
  appRunExits: Record<string, AppRunExit | null>;
  setSelectedProject: (id: string | null) => void;
  setSelectedTask: (id: string | null) => void;
  recordToolUse: (taskId: string, event: ToolUseEvent) => void;
  recordCost: (taskId: string, info: CostInfo) => void;
  recordSubtaskProgress: (taskId: string, progress: SubtaskProgress) => void;
  setAppRun: (projectId: string, status: AppRunStatus) => void;
  appendRunLog: (projectId: string, line: AppRunLogLine) => void;
  resetRunLogs: (projectId: string) => void;
  setRunExit: (projectId: string, exit: AppRunExit | null) => void;
}

export const useUi = create<UiState>((set) => ({
  selectedProjectId: null,
  selectedTaskId: null,
  lastTool: {},
  cost: {},
  subtaskProgress: {},
  appRuns: {},
  appRunLogs: {},
  appRunUrls: {},
  appRunExits: {},
  setSelectedProject: (id) => set({ selectedProjectId: id, selectedTaskId: null }),
  setSelectedTask: (id) => set({ selectedTaskId: id }),
  recordToolUse: (taskId, event) =>
    set((state) => ({ lastTool: { ...state.lastTool, [taskId]: event } })),
  recordCost: (taskId, info) =>
    set((state) => ({ cost: { ...state.cost, [taskId]: info } })),
  recordSubtaskProgress: (taskId, progress) =>
    set((state) => ({ subtaskProgress: { ...state.subtaskProgress, [taskId]: progress } })),
  setAppRun: (projectId, status) =>
    set((state) => ({ appRuns: { ...state.appRuns, [projectId]: status } })),
  appendRunLog: (projectId, line) =>
    set((state) => {
      const existing = state.appRunLogs[projectId] ?? [];
      const next = [...existing, line];
      if (next.length > MAX_LOG_LINES) next.splice(0, next.length - MAX_LOG_LINES);

      const matches = line.line.match(URL_RE);
      let urls = state.appRunUrls;
      if (matches && matches.length > 0) {
        const existingUrls = urls[projectId] ?? [];
        const merged = [...existingUrls];
        for (const m of matches) {
          const cleaned = m.replace(/\/+$/, '');
          if (!merged.includes(cleaned)) merged.push(cleaned);
        }
        if (merged.length !== existingUrls.length) {
          urls = { ...urls, [projectId]: merged };
        }
      }

      return {
        appRunLogs: { ...state.appRunLogs, [projectId]: next },
        appRunUrls: urls,
      };
    }),
  resetRunLogs: (projectId) =>
    set((state) => ({
      appRunLogs: { ...state.appRunLogs, [projectId]: [] },
      appRunUrls: { ...state.appRunUrls, [projectId]: [] },
      appRunExits: { ...state.appRunExits, [projectId]: null },
    })),
  setRunExit: (projectId, exit) =>
    set((state) => ({ appRunExits: { ...state.appRunExits, [projectId]: exit } })),
}));
