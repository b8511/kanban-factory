import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { api } from '../api';
import type { Idea } from '../types';

interface Props {
  projectId: string;
}

export function IdeasColumn({ projectId }: Props) {
  const qc = useQueryClient();

  // No polling: WS handler invalidates these queries on every `ideas_updated`
  // broadcast (scout start, finish, error, idea created/approved/rejected).
  const ideasQ = useQuery<Idea[]>({
    queryKey: ['ideas', projectId],
    queryFn: () => api.listIdeas(projectId),
  });
  const statusQ = useQuery({
    queryKey: ['scoutStatus', projectId],
    queryFn: () => api.getScoutStatus(projectId),
  });
  const ideas = ideasQ.data ?? [];
  // Show busy state instantly on click — don't wait for the 5s status poll or
  // the WS round-trip to register the new scouting flag.
  const scoutMut = useMutation({
    mutationFn: () => api.scoutIdeas(projectId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scoutStatus', projectId] }),
  });
  const scouting = (statusQ.data?.scouting ?? false) || scoutMut.isPending;
  const approveMut = useMutation({
    mutationFn: (id: string) => api.approveIdea(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ideas', projectId] });
      qc.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
  });
  const rejectMut = useMutation({
    mutationFn: (id: string) => api.rejectIdea(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ideas', projectId] }),
  });

  return (
    <div className="flex min-w-[240px] flex-col overflow-hidden rounded-xl border border-violet-900/50 bg-gradient-to-b from-violet-950/15 to-transparent backdrop-blur-sm">
      <div className="h-[3px] bg-gradient-to-r from-violet-400 to-violet-600/40" />
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-violet-300">
          <span>💡</span> Ideas
          <span className="ml-1 rounded-full bg-violet-950/60 px-2 py-0.5 text-[10px] text-violet-300">
            {ideas.length}
          </span>
        </span>
        <button
          className="btn border border-violet-700/80 bg-transparent text-violet-200 hover:bg-violet-900/40"
          onClick={() => scoutMut.mutate()}
          disabled={scouting || scoutMut.isPending}
          title="Ask the scout for fresh ideas"
        >
          {scouting ? '🔎 Scouting…' : 'Generate'}
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {scouting && (
          <div className="flex items-center gap-2 rounded-md border border-violet-800/60 bg-violet-950/40 px-3 py-2 text-[11px] text-violet-200">
            <span className="flex gap-0.5">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-400 [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-400 [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-violet-400" />
            </span>
            <span>Scouting your project for fresh ideas… (~30–60s)</span>
          </div>
        )}
        {!scouting && ideas.length === 0 && (
          <div className="mx-1 rounded-md border border-dashed border-violet-900/50 px-2 py-6 text-center text-[11px] text-neutral-600">
            No ideas yet.
            <div className="mt-1 text-[10px] text-neutral-700">
              The scout runs after every task, or click Generate.
            </div>
          </div>
        )}
        {ideas.map((idea) => (
          <IdeaCard
            key={idea.id}
            idea={idea}
            onApprove={() => approveMut.mutate(idea.id)}
            onReject={() => rejectMut.mutate(idea.id)}
            approving={approveMut.isPending && approveMut.variables === idea.id}
            rejecting={rejectMut.isPending && rejectMut.variables === idea.id}
          />
        ))}
      </div>
    </div>
  );
}

function IdeaCard({
  idea,
  onApprove,
  onReject,
  approving,
  rejecting,
}: {
  idea: Idea;
  onApprove: () => void;
  onReject: () => void;
  approving: boolean;
  rejecting: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // Heuristic: any time text would clearly clamp, show the toggle. Cheap to
  // always show — clicking when already short is a no-op visually.
  const longish =
    (idea.description?.length ?? 0) > 140 || (idea.rationale?.length ?? 0) > 100;

  return (
    <div className="rounded-lg border border-violet-900/40 bg-neutral-900/80 p-2.5 shadow-sm transition hover:border-violet-800">
      <div className="text-sm font-medium text-neutral-50">{idea.title}</div>
      <div
        className={clsx(
          'mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-neutral-400',
          !expanded && 'line-clamp-3'
        )}
      >
        {idea.description}
      </div>
      {idea.rationale && (
        <div
          className={clsx(
            'mt-1.5 whitespace-pre-wrap break-words border-l-2 border-violet-800/60 pl-2 text-[11px] italic text-neutral-500',
            !expanded && 'line-clamp-2'
          )}
        >
          {idea.rationale}
        </div>
      )}
      {longish && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 text-[11px] font-medium text-violet-400 hover:text-violet-300"
        >
          {expanded ? '▴ Show less' : '▾ Show more'}
        </button>
      )}
      <div className="mt-2 flex gap-1.5">
        <button
          className="btn btn-success flex-1"
          onClick={onApprove}
          disabled={approving}
          title="Approve — creates a Backlog task"
        >
          {approving ? 'Approving…' : '✓ Approve'}
        </button>
        <button
          className="btn btn-ghost flex-1"
          onClick={onReject}
          disabled={rejecting}
          title="Reject — the scout won't suggest this again"
        >
          {rejecting ? '…' : '✗ Reject'}
        </button>
      </div>
    </div>
  );
}
