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
const DEFAULT_MAX_THINKING_TOKENS = Number(process.env.KF_MAX_THINKING_TOKENS ?? 31999);

export interface RunAgentOptions {
  taskId: string;
  role: AgentRole;
  cwd: string;
  systemPrompt: string;
  prompt: string;
  maxTurns?: number;
  abortSignal?: AbortSignal;
}

export interface RunAgentResult {
  finalText: string;
  turns: number;
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
  const runId = store.startRun(opts.taskId, opts.role, '');
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
    broadcast({
      type: type as 'log' | 'tool_use' | 'run_start' | 'run_end' | 'run_error',
      taskId: opts.taskId,
      role: opts.role,
      payload: event,
    });
  };

  emit('run_start', { cwd: opts.cwd, maxTurns: opts.maxTurns });

  let finalText = '';
  let turns = 0;
  let ok = false;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

  const abortController = new AbortController();
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) abortController.abort();
    opts.abortSignal.addEventListener('abort', () => abortController.abort());
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
        maxThinkingTokens: DEFAULT_MAX_THINKING_TOKENS,
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
          for (const block of content) {
            if (!block || typeof block !== 'object') continue;
            const b = block as { type?: string; text?: string; name?: string; input?: unknown };
            if (b.type === 'text') {
              finalText = String(b.text ?? '');
            } else if (b.type === 'tool_use' && b.name) {
              emit('tool_use', { name: b.name, target: summarizeToolInput(b.input) });
            }
          }
        }
      } else if (msg.type === 'result') {
        const r = msg as {
          result?: string;
          is_error?: boolean;
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
          throw new Error(`SDK result reported error: ${JSON.stringify(msg).slice(0, 400)}`);
        }
      }
    }

    ok = true;
    emit('run_end', { finalText, turns, usage });
    return { finalText, turns };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit('run_error', { message });
    throw err;
  } finally {
    logStream.end();
    store.finishRun(runId, ok, usage);
    broadcast({
      type: 'task_cost',
      taskId: opts.taskId,
      payload: store.getTaskCost(opts.taskId),
    });
  }
}
