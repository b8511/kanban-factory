import clsx from 'clsx';
import { useUi } from '../store';
import type { WsEvent } from '../types';

interface Props {
  logs: WsEvent[];
}

export function TaskDrawer({ logs }: Props) {
  const { selectedTaskId, setSelectedTask } = useUi();
  if (!selectedTaskId) return null;

  const taskLogs = logs.filter((l) => l.taskId === selectedTaskId);

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-[440px] flex-col border-l border-neutral-800 bg-neutral-950/95 backdrop-blur-md shadow-2xl">
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-neutral-100">Agent log</div>
          <div className="font-mono text-[10px] text-neutral-600">{selectedTaskId}</div>
        </div>
        <button
          onClick={() => setSelectedTask(null)}
          className="rounded-md p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          title="Close"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-neutral-300">
        {taskLogs.length === 0 ? (
          <div className="mt-8 text-center text-neutral-600">
            No events yet. Click <span className="text-neutral-400">Start</span> on a task.
          </div>
        ) : (
          taskLogs.map((l, i) => (
            <div key={i} className="mb-1 flex gap-2 whitespace-pre-wrap">
              <span className="shrink-0 text-neutral-600">{(l.at ?? '').slice(11, 19)}</span>
              <span className={clsx('shrink-0 font-medium', roleColor(l.role))}>
                {l.role ?? '·'}
              </span>
              <span className="min-w-0 flex-1 break-words">{summarize(l)}</span>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

function roleColor(role?: string) {
  if (role === 'architect') return 'text-violet-400';
  if (role === 'specialist') return 'text-indigo-400';
  if (role === 'reviewer') return 'text-amber-400';
  return 'text-neutral-500';
}

function summarize(ev: WsEvent): string {
  if (ev.type === 'error') return `ERROR: ${JSON.stringify(ev.payload)}`;
  const p: any = ev.payload;
  if (!p) return ev.type;
  if (p.payload?.type === 'assistant') {
    const content = p.payload?.message?.content;
    if (Array.isArray(content)) {
      const text = content.find((c: any) => c?.type === 'text')?.text;
      if (text) return `assistant: ${text.slice(0, 200)}`;
      const tool = content.find((c: any) => c?.type === 'tool_use');
      if (tool) return `tool_use: ${tool.name}(${JSON.stringify(tool.input).slice(0, 120)})`;
    }
  }
  if (p.payload?.type === 'result') return `result: ${String(p.payload?.result ?? '').slice(0, 200)}`;
  if (p.type === 'run_start') return `→ run start (${(p.payload as any)?.cwd ?? ''})`;
  if (p.type === 'run_end') return `✓ run end`;
  if (p.type === 'run_error') return `✗ ${(p.payload as any)?.message}`;
  return ev.type;
}
