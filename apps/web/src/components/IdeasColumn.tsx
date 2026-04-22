import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type { Idea } from '../types';

interface Props {
  projectId: string;
}

export function IdeasColumn({ projectId }: Props) {
  const qc = useQueryClient();

  const ideasQ = useQuery<Idea[]>({
    queryKey: ['ideas', projectId],
    queryFn: () => api.listIdeas(projectId),
    refetchInterval: 10_000,
  });
  const statusQ = useQuery({
    queryKey: ['scoutStatus', projectId],
    queryFn: () => api.getScoutStatus(projectId),
    refetchInterval: 5_000,
  });
  const ideas = ideasQ.data ?? [];
  const scouting = statusQ.data?.scouting ?? false;

  const scoutMut = useMutation({
    mutationFn: () => api.scoutIdeas(projectId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scoutStatus', projectId] }),
  });
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
        {scouting && ideas.length === 0 && (
          <div className="animate-pulse rounded-md border border-violet-800/60 bg-violet-950/30 px-3 py-2 text-[11px] text-violet-300">
            🔎 Scouting your project for fresh ideas…
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
          <div
            key={idea.id}
            className="rounded-lg border border-violet-900/40 bg-neutral-900/80 p-2.5 shadow-sm transition hover:border-violet-800"
          >
            <div className="text-sm font-medium text-neutral-50">{idea.title}</div>
            <div className="mt-1 line-clamp-3 text-xs leading-relaxed text-neutral-400">
              {idea.description}
            </div>
            {idea.rationale && (
              <div className="mt-1.5 line-clamp-2 border-l-2 border-violet-800/60 pl-2 text-[11px] italic text-neutral-500">
                {idea.rationale}
              </div>
            )}
            <div className="mt-2 flex gap-1.5">
              <button
                className="btn btn-success flex-1"
                onClick={() => approveMut.mutate(idea.id)}
                disabled={approveMut.isPending}
                title="Approve — creates a Backlog task"
              >
                {approveMut.isPending && approveMut.variables === idea.id
                  ? 'Approving…'
                  : '✓ Approve'}
              </button>
              <button
                className="btn btn-ghost flex-1"
                onClick={() => rejectMut.mutate(idea.id)}
                disabled={rejectMut.isPending}
                title="Reject — the scout won't suggest this again"
              >
                ✗ Reject
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
