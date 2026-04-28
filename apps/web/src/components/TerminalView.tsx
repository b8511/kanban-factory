import clsx from 'clsx';
import { useEffect, useRef } from 'react';

export interface TerminalLine {
  stream: 'stdout' | 'stderr';
  line: string;
  at: string;
}

interface Props {
  lines: TerminalLine[];
  className?: string;
  emptyHint?: string;
  autoScroll?: boolean;
}

export function TerminalView({ lines, className, emptyHint, autoScroll = true }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines.length, autoScroll]);

  const stderrCount = lines.filter((l) => l.stream === 'stderr').length;

  return (
    <div className={clsx('flex min-h-0 flex-col', className)}>
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-neutral-500">
        <span>Terminal</span>
        <span className="font-mono text-neutral-600">
          {lines.length} line{lines.length === 1 ? '' : 's'}
          {stderrCount > 0 && <span className="text-rose-400"> · {stderrCount} stderr</span>}
        </span>
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto rounded-md border border-neutral-800 bg-black/80 p-2 font-mono text-[10px] leading-snug"
      >
        {lines.length === 0 ? (
          <div className="text-neutral-600">{emptyHint ?? '(waiting for output…)'}</div>
        ) : (
          lines.map((l, i) => (
            <div key={i} className="flex gap-2">
              <span className="w-6 shrink-0 select-none text-right text-neutral-700">{i + 1}</span>
              <span
                className={clsx(
                  'min-w-0 flex-1 whitespace-pre-wrap break-all',
                  l.stream === 'stderr' ? 'text-rose-300' : 'text-neutral-300'
                )}
              >
                {l.line}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
