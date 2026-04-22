import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUi } from '../store';
import type { AppRunStatus, ReviewSeverity, SubtaskProgress, WsEvent, AgentRole } from '../types';

export function useWebSocket(onLog?: (event: WsEvent) => void): void {
  const qc = useQueryClient();
  const recordToolUse = useUi((s) => s.recordToolUse);
  const recordCost = useUi((s) => s.recordCost);
  const recordSubtaskProgress = useUi((s) => s.recordSubtaskProgress);
  const setAppRun = useUi((s) => s.setAppRun);
  const appendRunLog = useUi((s) => s.appendRunLog);
  const resetRunLogs = useUi((s) => s.resetRunLogs);
  const setRunExit = useUi((s) => s.setRunExit);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;

    const resyncAll = () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
    };

    const connect = () => {
      if (closed) return;
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
      ws = new WebSocket(url);

      ws.onopen = () => {
        retry = 0;
        resyncAll();
      };

      ws.onmessage = (ev) => {
        let event: WsEvent;
        try {
          event = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (event.type === 'task_updated' && event.projectId) {
          qc.invalidateQueries({ queryKey: ['tasks', event.projectId] });
        }
        if (event.type === 'project_updated') {
          qc.invalidateQueries({ queryKey: ['projects'] });
        }
        if (event.type === 'tool_use' && event.taskId) {
          const inner = (event.payload as any)?.payload as
            | { name?: string; target?: string }
            | undefined;
          if (inner?.name) {
            recordToolUse(event.taskId, {
              name: inner.name,
              target: inner.target ?? '',
              role: (event.role as AgentRole) ?? 'specialist',
              at: event.at ?? new Date().toISOString(),
            });
          }
        }
        if (event.type === 'task_cost' && event.taskId) {
          const p = event.payload as
            | { inputTokens?: number; outputTokens?: number; costUsd?: number }
            | undefined;
          if (p) {
            recordCost(event.taskId, {
              inputTokens: p.inputTokens ?? 0,
              outputTokens: p.outputTokens ?? 0,
              costUsd: p.costUsd ?? 0,
            });
          }
        }
        if (event.type === 'subtask_progress' && event.taskId) {
          const p = event.payload as Partial<SubtaskProgress> | undefined;
          if (p && typeof p.subtaskIndex === 'number' && typeof p.round === 'number') {
            recordSubtaskProgress(event.taskId, {
              subtaskIndex: p.subtaskIndex,
              description: p.description ?? '',
              round: p.round,
              maxRounds: p.maxRounds ?? 3,
              approved: !!p.approved,
              severity: (p.severity as ReviewSeverity) ?? 'none',
              feedback: p.feedback ?? '',
            });
          }
        }
        if (event.type === 'ideas_updated' && event.projectId) {
          qc.invalidateQueries({ queryKey: ['ideas', event.projectId] });
          qc.invalidateQueries({ queryKey: ['scoutStatus', event.projectId] });
        }
        if ((event.type === 'app_run_started' || event.type === 'app_run_stopped') && event.projectId) {
          if (event.type === 'app_run_started') {
            const p = event.payload as { command?: string; pid?: number; startedAt?: string } | undefined;
            const status: AppRunStatus = {
              running: true,
              command: p?.command ?? null,
              pid: p?.pid ?? null,
              startedAt: p?.startedAt,
            };
            resetRunLogs(event.projectId);
            setAppRun(event.projectId, status);
          } else {
            const p = event.payload as { code?: number | null; signal?: string | null } | undefined;
            setAppRun(event.projectId, { running: false, command: null, pid: null });
            setRunExit(event.projectId, {
              code: p?.code ?? null,
              signal: p?.signal ?? null,
              finishedAt: event.at ?? new Date().toISOString(),
            });
          }
        }
        if (event.type === 'app_run_log' && event.projectId) {
          const p = event.payload as { stream?: 'stdout' | 'stderr'; line?: string } | undefined;
          if (p && typeof p.line === 'string') {
            appendRunLog(event.projectId, {
              stream: p.stream ?? 'stdout',
              line: p.line,
              at: event.at ?? new Date().toISOString(),
            });
          }
        }
        if (
          event.type === 'log' ||
          event.type === 'message' ||
          event.type === 'error' ||
          event.type === 'tool_use' ||
          event.type === 'run_start' ||
          event.type === 'run_end' ||
          event.type === 'run_error' ||
          event.type === 'subtask_progress' ||
          event.type === 'app_run_started' ||
          event.type === 'app_run_log' ||
          event.type === 'app_run_stopped'
        ) {
          onLog?.(event);
        }
      };

      ws.onclose = () => {
        if (closed) return;
        retry = Math.min(retry + 1, 5);
        setTimeout(connect, 500 * retry);
      };
    };

    connect();

    const visibilityHandler = () => {
      if (!document.hidden) resyncAll();
    };
    document.addEventListener('visibilitychange', visibilityHandler);

    return () => {
      closed = true;
      ws?.close();
      document.removeEventListener('visibilitychange', visibilityHandler);
    };
  }, [qc, onLog, recordToolUse, recordCost, recordSubtaskProgress, setAppRun, appendRunLog, resetRunLogs, setRunExit]);
}
