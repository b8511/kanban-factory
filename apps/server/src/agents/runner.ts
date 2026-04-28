import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { store } from '../db.js';
import { broadcast } from '../ws.js';
import type { AgentRole } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, '..', '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const DEFAULT_MODEL = process.env.KF_MODEL ?? 'claude-opus-4-7';
const DEFAULT_FALLBACK_MODEL = process.env.KF_FALLBACK_MODEL ?? 'claude-sonnet-4-6';
// Thinking tokens share the output budget with emitted text. A too-high cap
// makes JSON-emitting roles (architect, reviewer, operator analysis) risk
// truncation. 8000 is a reasonable default for code-editing roles; structured
// roles override this to a smaller value at their call sites.
const DEFAULT_MAX_THINKING_TOKENS = Number(process.env.KF_MAX_THINKING_TOKENS ?? 8000);

export interface RunAgentOptions {
  taskId: string;
  role: AgentRole;
  cwd: string;
  systemPrompt: string;
  prompt: string;
  maxTurns?: number;
  abortSignal?: AbortSignal;
  /**
   * Per-call thinking token cap. Defaults to KF_MAX_THINKING_TOKENS env var.
   * Lower values help JSON-only roles (architect, operator-analysis) avoid
   * blowing the shared output-token budget on thinking and getting their
   * structured output truncated mid-emit.
   */
  maxThinkingTokens?: number;
  /**
   * When set, this run is for an operator session rather than a task.
   * The runner skips DB `agent_runs` recording and emits `operator_*` WS events
   * keyed by this session id instead of `task_updated` / `task_cost`.
   */
  operatorSessionId?: string;
  /**
   * Skip DB recording entirely (no agent_runs row, no task_cost broadcast).
   * Use for runs that don't belong to a real task — e.g. the idea scout.
   */
  skipDbRecording?: boolean;
  projectId?: string;
}

export interface RunAgentResult {
  finalText: string;
  turns: number;
  toolCount: number;
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  const key = ['file_path', 'path', 'command', 'pattern', 'url'].find((k) => typeof obj[k] === 'string');
  if (key) return String(obj[key]).slice(0, 120);
  try {
    return JSON.stringify(obj).slice(0, 120);
  } catch {
    return '';
  }
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const isOperator = !!opts.operatorSessionId;
  const skipDb = opts.skipDbRecording === true;
  const runId = isOperator
    ? `op-${opts.operatorSessionId}-${Date.now().toString(36)}`
    : skipDb
      ? `${opts.taskId}-${Date.now().toString(36)}`
      : store.startRun(opts.taskId, opts.role, '', opts.projectId ?? null);
  const transcriptPath = path.join(LOG_DIR, `${runId}.jsonl`);
  const logStream = fs.createWriteStream(transcriptPath, { flags: 'a' });

  const emit = (type: string, payload: unknown) => {
    const event = {
      type,
      taskId: opts.taskId,
      role: opts.role,
      runId,
      at: new Date().toISOString(),
      payload,
    };
    logStream.write(JSON.stringify(event) + '\n');
    if (isOperator) {
      broadcast({
        type: 'operator_status',
        projectId: opts.projectId,
        sessionId: opts.operatorSessionId,
        role: opts.role,
        payload: { agentEvent: { type, ...payload as Record<string, unknown> } },
      } as any);
    } else {
      broadcast({
        type: type as 'log' | 'tool_use' | 'run_start' | 'run_end' | 'run_error',
        taskId: opts.taskId,
        role: opts.role,
        payload: event,
      });
    }
  };

  emit('run_start', { cwd: opts.cwd, maxTurns: opts.maxTurns });

  let finalText = '';
  let turns = 0;
  let toolCount = 0;
  let ok = false;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

  const abortController = new AbortController();
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) abortController.abort();
    opts.abortSignal.addEventListener('abort', () => abortController.abort());
  }

  const MAX_RETRIES = 1;
  let attempt = 0;
  try {
    while (true) {
      if (attempt > 0) {
        // reset accumulators for retry; usage from prior attempt has zero tokens
        // anyway (error_during_execution returns num_turns:0)
        finalText = '';
        turns = 0;
        toolCount = 0;
        await new Promise((r) => setTimeout(r, 2000));
        if (abortController.signal.aborted) throw new Error('aborted');
      }
      try {
        const stream = query({
          prompt: opts.prompt,
          options: {
            cwd: opts.cwd,
            systemPrompt: opts.systemPrompt,
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            maxTurns: opts.maxTurns,
            model: DEFAULT_MODEL,
            fallbackModel: DEFAULT_FALLBACK_MODEL,
            maxThinkingTokens: opts.maxThinkingTokens ?? DEFAULT_MAX_THINKING_TOKENS,
            persistSession: false,
            settingSources: [],
            abortController,
          },
        });

        for await (const msg of stream) {
          if (msg.type === 'assistant') {
            turns++;
            const content = (msg as { message?: { content?: unknown } }).message?.content;
            if (Array.isArray(content)) {
              // Per-message: accumulate all text blocks in THIS message, then replace finalText.
              // Prevents splitting a single JSON across multiple text blocks from losing parts.
              let messageText = '';
              for (const block of content) {
                if (!block || typeof block !== 'object') continue;
                const b = block as { type?: string; text?: string; name?: string; input?: unknown };
                if (b.type === 'text') {
                  messageText += String(b.text ?? '');
                } else if (b.type === 'tool_use' && b.name) {
                  toolCount++;
                  emit('tool_use', { name: b.name, target: summarizeToolInput(b.input) });
                }
              }
              if (messageText.length > 0) finalText = messageText;
            }
          } else if (msg.type === 'result') {
            const r = msg as {
              result?: string;
              is_error?: boolean;
              subtype?: string;
              total_cost_usd?: number;
              modelUsage?: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>;
            };
            if (typeof r.result === 'string' && r.result.length > 0) {
              finalText = r.result;
            }
            if (r.modelUsage) {
              for (const m of Object.values(r.modelUsage)) {
                usage.inputTokens += m.inputTokens ?? 0;
                usage.outputTokens += m.outputTokens ?? 0;
                usage.costUsd += m.costUSD ?? 0;
              }
            } else if (typeof r.total_cost_usd === 'number') {
              usage.costUsd += r.total_cost_usd;
            }
            if (r.is_error) {
              const transient = r.subtype === 'error_during_execution';
              throw new Error(
                `SDK result reported error${transient ? ' (transient)' : ''}: ${JSON.stringify(msg).slice(0, 400)}`
              );
            }
          }
        }

        ok = true;
        emit('run_end', { finalText, turns, toolCount, usage });
        return { finalText, turns, toolCount };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isTransient = message.includes('error_during_execution');
        if (isTransient && attempt < MAX_RETRIES) {
          emit('run_retry', { attempt: attempt + 1, reason: message.slice(0, 200) });
          attempt++;
          continue;
        }
        emit('run_error', { message });
        throw err;
      }
    }
  } finally {
    logStream.end();
    if (!isOperator && !skipDb) {
      store.finishRun(runId, ok, usage);
      broadcast({
        type: 'task_cost',
        taskId: opts.taskId,
        payload: store.getTaskCost(opts.taskId),
      });
    }
  }
}
