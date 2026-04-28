import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { api } from '../api';
import { useUi } from '../store';
import { TerminalView, type TerminalLine } from './TerminalView';
import type { OperatorAnalysis, OperatorMessage } from '../types';

export function OperatePage({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const setView = useUi((s) => s.setView);
  const operator = useUi((s) => s.operator[projectId]);
  const hydrateOperator = useUi((s) => s.hydrateOperator);
  const appendOperatorMessage = useUi((s) => s.appendOperatorMessage);
  const patchOperator = useUi((s) => s.patchOperator);

  const sessionQ = useQuery({
    queryKey: ['operatorSession', projectId],
    queryFn: () => api.getOperatorSession(projectId),
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    const data = sessionQ.data;
    if (!data) return;
    hydrateOperator(projectId, {
      id: data.session.id,
      status: data.session.status,
      analysis: data.session.analysis,
      messages: data.messages,
      terminal: data.terminal,
      exit: data.lastExit,
      running: data.running,
      command: data.command,
      pid: data.pid,
    });
  }, [sessionQ.data, projectId, hydrateOperator]);

  const startMut = useMutation({
    mutationFn: () => api.startOperatorSession(projectId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['operatorSession', projectId] }),
  });

  const sessionId = operator?.id ?? null;
  const analysis = operator?.analysis ?? null;
  const messages = operator?.messages ?? [];
  const terminal = operator?.terminal ?? [];
  const running = operator?.running ?? false;
  const exit = operator?.exit ?? null;

  const [draft, setDraft] = useState('');
  const [commandOverride, setCommandOverride] = useState('');

  const sendMut = useMutation({
    mutationFn: async (content: string) => {
      if (!sessionId) throw new Error('no session');
      return api.sendOperatorMessage(sessionId, content);
    },
    onSuccess: () => setDraft(''),
  });

  const runMut = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error('no session');
      return api.runOperator(sessionId, commandOverride.trim() || undefined);
    },
  });

  const stopMut = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error('no session');
      return api.stopOperator(sessionId);
    },
  });

  const diagMut = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error('no session');
      return api.sendOperatorDiagnostic(sessionId, {});
    },
    onSuccess: (data) => {
      if (data?.task?.id) {
        setView({ mode: 'taskDetail', taskId: data.task.id });
      }
    },
  });

  const stderrCount = terminal.filter((l) => l.stream === 'stderr').length;
  const crashed = exit && exit.code !== null && exit.code !== 0;
  const canSendDiag = !running && (crashed || stderrCount > 0);

  const effectiveCommand = commandOverride.trim() || analysis?.runCommandGuess || '';

  if (sessionQ.isLoading && !operator) {
    return <div className="flex h-full items-center justify-center text-neutral-500">Loading session…</div>;
  }

  if (!operator) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-neutral-400">
        <div className="max-w-md text-center">
          No Operator session yet. Start one to have the agent inspect the project and propose how to run it.
        </div>
        <button
          className="btn btn-primary"
          onClick={() => startMut.mutate()}
          disabled={startMut.isPending}
        >
          {startMut.isPending ? 'Starting…' : '🚀 Start Operator session'}
        </button>
        {startMut.isError && (
          <div className="max-w-md break-all text-xs text-rose-400">
            {(startMut.error as Error).message}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 p-4 md:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-h-0 flex-col gap-3">
        <AnalysisPanel
          analysis={analysis}
          analyzing={operator.status === 'analyzing'}
          onRestart={() => startMut.mutate()}
          restarting={startMut.isPending}
        />

        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900/60 p-2.5">
          <input
            className="flex-1 min-w-[200px] rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-xs text-neutral-100 focus:border-indigo-500 focus:outline-none"
            value={commandOverride}
            placeholder={analysis?.runCommandGuess ?? 'e.g. npm run dev'}
            onChange={(e) => setCommandOverride(e.target.value)}
          />
          {running ? (
            <button
              className="btn btn-danger"
              onClick={() => stopMut.mutate()}
              disabled={stopMut.isPending}
            >
              {stopMut.isPending ? 'Stopping…' : '⏹ Stop'}
            </button>
          ) : (
            <button
              className="btn btn-success"
              onClick={() => runMut.mutate()}
              disabled={runMut.isPending || !effectiveCommand}
              title={effectiveCommand || 'no command to run'}
            >
              {runMut.isPending ? '▶ Starting…' : '▶ Run'}
            </button>
          )}
          <button
            className="btn btn-violet"
            onClick={() => diagMut.mutate()}
            disabled={!canSendDiag || diagMut.isPending}
            title={
              canSendDiag
                ? 'Send a diagnostic task back to the factory'
                : 'Run the app and capture output first'
            }
          >
            {diagMut.isPending
              ? '🔧 Sending…'
              : diagMut.isSuccess
                ? '✓ Sent'
                : '🔧 Send failure to factory'}
          </button>
        </div>

        {runMut.isError && (
          <div className="break-all rounded-md border border-rose-900 bg-rose-950/40 p-2 text-xs text-rose-300">
            Run failed: {(runMut.error as Error).message}
          </div>
        )}

        <TerminalView lines={terminal} className="min-h-0 flex-1" />

        {exit && !running && (
          <div
            className={clsx(
              'rounded-md border px-3 py-2 text-xs',
              crashed
                ? 'border-rose-700/60 bg-rose-950/40 text-rose-200'
                : 'border-neutral-800 bg-neutral-900/60 text-neutral-300'
            )}
          >
            {crashed
              ? `✗ Crashed · exit ${exit.code}${exit.signal ? ` · signal ${exit.signal}` : ''}`
              : `■ Finished · exit ${exit.code ?? '?'}${exit.signal ? ` · signal ${exit.signal}` : ''}`}
          </div>
        )}
      </div>

      <ChatPanel
        messages={messages}
        draft={draft}
        setDraft={setDraft}
        onSend={() => {
          if (draft.trim() && sessionId) {
            const content = draft.trim();
            // Optimistic: show the user's message immediately so the input feels responsive
            appendOperatorMessage(projectId, {
              id: `optimistic-${Date.now()}`,
              sessionId,
              role: 'user',
              content,
              toolUse: null,
              createdAt: new Date().toISOString(),
            });
            sendMut.mutate(content);
          }
        }}
        sending={sendMut.isPending}
        sendError={sendMut.error as Error | null}
        analyzing={operator.status === 'analyzing'}
      />
    </div>
  );
}

function AnalysisPanel({
  analysis,
  analyzing,
  onRestart,
  restarting,
}: {
  analysis: OperatorAnalysis | null;
  analyzing: boolean;
  onRestart: () => void;
  restarting: boolean;
}) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs uppercase tracking-wider text-neutral-500">
          Operator analysis
        </div>
        <button
          className="btn btn-ghost text-[11px]"
          onClick={onRestart}
          disabled={restarting || analyzing}
          title="Re-run the analysis"
        >
          {restarting ? '…' : '↻ Reanalyze'}
        </button>
      </div>
      {analyzing && !analysis && (
        <div className="text-xs text-neutral-500">Inspecting project…</div>
      )}
      {!analysis && !analyzing && (
        <div className="text-xs text-neutral-500">No analysis yet.</div>
      )}
      {analysis && (
        <div className="space-y-2 text-sm">
          <div className="text-neutral-200">{analysis.summary}</div>
          {analysis.stack.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {analysis.stack.map((s) => (
                <span
                  key={s}
                  className="rounded bg-indigo-950/60 px-1.5 py-0.5 font-mono text-[10px] text-indigo-300 ring-1 ring-indigo-800/60"
                >
                  {s}
                </span>
              ))}
            </div>
          )}
          {analysis.entrypoints.length > 0 && (
            <div className="space-y-0.5 text-xs text-neutral-400">
              {analysis.entrypoints.map((e, i) => (
                <div key={i}>
                  <span className="font-mono text-neutral-300">{e.path}</span>{' '}
                  <span className="text-neutral-500">· {e.kind}</span>
                </div>
              ))}
            </div>
          )}
          {analysis.runCommandGuess && (
            <div className="rounded border border-emerald-800/60 bg-emerald-950/30 p-2 text-xs text-emerald-200">
              <div className="mb-0.5 text-[10px] uppercase tracking-wider text-emerald-400">
                Proposed run command · confidence {(analysis.confidence * 100).toFixed(0)}%
              </div>
              <code className="block font-mono text-sm text-emerald-100">
                {analysis.runCommandGuess}
              </code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChatPanel({
  messages,
  draft,
  setDraft,
  onSend,
  sending,
  sendError,
  analyzing,
}: {
  messages: OperatorMessage[];
  draft: string;
  setDraft: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  sendError: Error | null;
  analyzing: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Operator is composing a reply whenever the last message is from the user
  // (the message endpoint returns 202 before the chat completes).
  const awaitingReply = messages.length > 0 && messages[messages.length - 1].role === 'user';
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, awaitingReply]);

  return (
    <div className="flex min-h-0 flex-col rounded-lg border border-neutral-800 bg-neutral-900/60">
      <div className="border-b border-neutral-800 px-3 py-2 text-xs uppercase tracking-wider text-neutral-500">
        Operator chat
      </div>
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 space-y-2 overflow-y-auto px-3 py-2 text-xs"
      >
        {messages.length === 0 && !analyzing && (
          <div className="text-neutral-500">
            Say "run it" or ask the operator a question about the project.
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={clsx(
              'rounded-md p-2 leading-relaxed',
              m.role === 'user'
                ? 'bg-indigo-950/40 text-indigo-100 ring-1 ring-indigo-900/60'
                : m.role === 'operator'
                  ? 'bg-neutral-900/60 text-neutral-200 ring-1 ring-neutral-800'
                  : 'bg-rose-950/30 text-rose-200 ring-1 ring-rose-900/60'
            )}
          >
            <div className="mb-0.5 text-[10px] uppercase tracking-wider text-neutral-500">
              {m.role}
            </div>
            <div className="whitespace-pre-wrap break-words">{m.content}</div>
          </div>
        ))}
        {(sending || awaitingReply) && (
          <div className="flex items-center gap-2 rounded-md bg-neutral-900/60 p-2 text-neutral-500 ring-1 ring-neutral-800">
            <span className="flex gap-0.5">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-500 [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-500 [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-500" />
            </span>
            <span>operator is thinking…</span>
          </div>
        )}
      </div>
      {sendError && (
        <div className="break-all border-t border-rose-900 bg-rose-950/30 px-3 py-1.5 text-[11px] text-rose-300">
          {sendError.message}
        </div>
      )}
      <div className="border-t border-neutral-800 px-3 py-2">
        <textarea
          className="w-full resize-none rounded-md border border-neutral-700 bg-neutral-950 p-2 text-xs text-neutral-100 focus:border-indigo-500 focus:outline-none"
          rows={3}
          placeholder="Ask the operator…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-[10px] text-neutral-500">⌘/Ctrl + Enter to send</span>
          <button
            className="btn btn-primary"
            onClick={onSend}
            disabled={!draft.trim() || sending || awaitingReply}
          >
            {sending ? 'Sending…' : awaitingReply ? 'Waiting…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
