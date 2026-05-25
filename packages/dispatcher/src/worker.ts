import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { acpAdapter } from './adapters/acp.js';
import { ampCliAdapter } from './adapters/amp-cli.js';
import { ccrCliAdapter } from './adapters/ccr-cli.js';
import { claudeCodeAdapter } from './adapters/claude-code.js';
import { codexCliAdapter } from './adapters/codex-cli.js';
import { copilotCliAdapter } from './adapters/copilot-cli.js';
import { cursorCliAdapter } from './adapters/cursor-cli.js';
import { droidCliAdapter } from './adapters/droid-cli.js';
import { geminiCliAdapter } from './adapters/gemini-cli.js';
import { opencodeCliAdapter } from './adapters/opencode-cli.js';
import { qwenCliAdapter } from './adapters/qwen-cli.js';
import { resolveExplicitModel } from './adapters/model.js';
import type { AgentCliAdapter } from './adapters/types.js';
import { createCliEnvironment } from './cli-env.js';
import type { SpawnFn } from './composer.js';
import { computeCostUsd } from './pricing.js';
import { makeLineSplitter, type StreamEvent } from './stream-parser.js';

export type AgentRunProvider =
  | 'claude-code'
  | 'codex-cli'
  | 'gemini-cli'
  | 'amp-cli'
  | 'cursor-cli'
  | 'copilot-cli'
  | 'opencode-cli'
  | 'droid-cli'
  | 'ccr-cli'
  | 'qwen-cli'
  | 'acp';

const ADAPTERS: Partial<Record<AgentRunProvider, AgentCliAdapter>> = {
  'claude-code': claudeCodeAdapter,
  'codex-cli': codexCliAdapter,
  'gemini-cli': geminiCliAdapter,
  'amp-cli': ampCliAdapter,
  'cursor-cli': cursorCliAdapter,
  'copilot-cli': copilotCliAdapter,
  'opencode-cli': opencodeCliAdapter,
  'droid-cli': droidCliAdapter,
  'ccr-cli': ccrCliAdapter,
  'qwen-cli': qwenCliAdapter,
  acp: acpAdapter,
};

export interface StartAgentRunOptions {
  cwd: string;
  prompt: string;
  appendSystemPrompt?: string;
  allowedTools?: string;
  resumeFromSessionId?: string;
  model?: string;
  /**
   * Which provider to route the run through. Defaults to `claude-code`, which
   * spawns the existing `claude` CLI. Other providers are not supported for
   * agent runs in v1 — they're chat-only. Setting them here throws.
   */
  provider?: AgentRunProvider;
  command?: string;
  spawn?: SpawnFn;
  /**
   * Extra args appended to the underlying `claude` invocation, after the
   * built-in flags. Used by the chat agent to wire `--mcp-config <path>`.
   */
  extraArgs?: readonly string[];
  /**
   * Extra env vars to merge onto the child process. Used to surface the
   * tool-bridge URL + token to the MCP server.
   */
  env?: Record<string, string>;
}

export class UnsupportedProviderForAgentRunError extends Error {
  constructor(provider: AgentRunProvider) {
    super(
      `Provider '${provider}' does not support agent runs in this version. ` +
        `Switch to Claude Code (subscription) for agentic work, or use this provider for chat only.`,
    );
    this.name = 'UnsupportedProviderForAgentRunError';
  }
}

export interface RunResult {
  isError: boolean;
  text: string;
  tokenUsage: { input: number; output: number } | null;
  durationMs: number | null;
  totalCostUsd: number | null;
}

export type StopEscalation = 'sigterm' | 'sigkill' | null;

export interface RunSummary {
  exitCode: number | null;
  result: RunResult | null;
  killedByStop: boolean;
  /**
   * How the run terminated when stop() was invoked:
   *   - 'sigterm' — child exited within the grace period after SIGTERM
   *   - 'sigkill' — grace period elapsed and we had to escalate to SIGKILL
   *   - null     — stop() was not called
   */
  stopEscalation: StopEscalation;
  stderr: string;
}

export type AgentRunEventName = 'event' | 'close' | 'error';

export interface StopOptions {
  signal?: NodeJS.Signals;
  gracefulTimeoutMs?: number;
}

export interface AgentRunHandle {
  pid: number | null;
  on(event: 'event', handler: (e: StreamEvent) => void): this;
  on(event: 'close', handler: (summary: RunSummary) => void): this;
  on(event: 'error', handler: (err: Error) => void): this;
  off(event: AgentRunEventName, handler: (...args: unknown[]) => void): this;
  stop(opts?: StopOptions | NodeJS.Signals): void;
  done: Promise<RunSummary>;
}

export const DEFAULT_GRACEFUL_TIMEOUT_MS = 10_000;
const IS_WINDOWS = process.platform === 'win32';

export function startAgentRun(opts: StartAgentRunOptions): AgentRunHandle {
  const provider = opts.provider ?? 'claude-code';
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    throw new UnsupportedProviderForAgentRunError(provider);
  }
  const command = opts.command ?? adapter.command;
  const spawnFn = opts.spawn ?? nodeSpawn;
  const model = adapter.normalizeModel
    ? adapter.normalizeModel(opts.model)
    : (resolveExplicitModel(opts.model) ?? undefined);

  const args = adapter.buildArgs({
    ...(opts.resumeFromSessionId !== undefined
      ? { resumeFromSessionId: opts.resumeFromSessionId }
      : {}),
    ...(opts.allowedTools !== undefined ? { allowedTools: opts.allowedTools } : {}),
    ...(opts.appendSystemPrompt !== undefined
      ? { appendSystemPrompt: opts.appendSystemPrompt }
      : {}),
    ...(model !== undefined ? { model } : {}),
    ...(opts.extraArgs !== undefined ? { extraArgs: opts.extraArgs } : {}),
  });

  const composedPrompt = adapter.composePrompt
    ? adapter.composePrompt({
        ...(opts.appendSystemPrompt !== undefined ? { systemPrompt: opts.appendSystemPrompt } : {}),
        prompt: opts.prompt,
      })
    : opts.prompt;

  if (adapter.promptDelivery === 'argv') {
    args.push(composedPrompt);
  }

  // On POSIX, become a process-group leader so we can signal the entire
  // tree of subprocesses claude spawns (Bash tool calls, pnpm install,
  // hung test runs, etc.) when stop() is called. On Windows the process
  // model is different — we fall back to taskkill /T /F at escalation
  // time.
  const detached = !IS_WINDOWS;
  const baseEnv = createCliEnvironment(opts.env);
  const env = adapter.prepareEnvironment ? adapter.prepareEnvironment(baseEnv) : baseEnv;
  const spawnOpts: Parameters<SpawnFn>[2] = {
    cwd: opts.cwd,
    detached,
    env,
  };
  const child = spawnFn(command, args, spawnOpts);
  const emitter = new EventEmitter();

  let result: RunResult | null = null;
  let killedByStop = false;
  let stopEscalation: StopEscalation = null;
  let stderr = '';
  let escalationTimer: NodeJS.Timeout | null = null;
  let settled = false;

  const splitter = makeLineSplitter();
  child.stdout?.on('data', (chunk: Buffer) => {
    const lines = splitter(chunk.toString('utf8'));
    for (const line of lines) {
      const parsed = adapter.parseLine(line);
      for (let ev of parsed) {
        // Some providers (codex) emit token counts but no cost on result
        // events. Compute cost from the static pricing table when we know
        // the model. Adapters that already carry cost (claude-code) are
        // unaffected because totalCostUsd is non-null.
        if (ev.kind === 'result' && ev.totalCostUsd === null && ev.tokenUsage !== null && model) {
          const usd = computeCostUsd(model, ev.tokenUsage);
          if (usd !== null) {
            ev = { ...ev, totalCostUsd: usd };
          }
        }
        if (ev.kind === 'result') {
          result = {
            isError: ev.isError,
            text: ev.text,
            tokenUsage: ev.tokenUsage,
            durationMs: ev.durationMs,
            totalCostUsd: ev.totalCostUsd,
          };
        }
        emitter.emit('event', ev);
      }
    }
  });
  let rateLimitEmitted = false;
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderr += text;
    if (!rateLimitEmitted && adapter.detectRateLimit) {
      const rl = adapter.detectRateLimit(text);
      if (rl) {
        rateLimitEmitted = true;
        emitter.emit('event', rl);
      }
    }
  });

  switch (adapter.promptDelivery) {
    case 'stdin':
      if (child.stdin) {
        child.stdin.write(composedPrompt);
        child.stdin.end();
      }
      break;
    case 'argv':
      // Prompt is already on argv; close stdin so the CLI doesn't block
      // waiting for it. (codex prints "Reading additional input from
      // stdin..." otherwise, even when a positional prompt is provided.)
      child.stdin?.end();
      break;
  }

  function clearEscalation(): void {
    if (escalationTimer !== null) {
      clearTimeout(escalationTimer);
      escalationTimer = null;
    }
  }

  // Deliver `signal` to the entire process group on POSIX, falling back to
  // signalling the direct child if the group kill fails (e.g. the child
  // already exited, or the spawn implementation didn't honor `detached`).
  function killTarget(signal: NodeJS.Signals): void {
    const pid = child.pid;
    if (IS_WINDOWS) {
      if (signal === 'SIGKILL' && typeof pid === 'number') {
        // taskkill /T /F kills the process and all descendants.
        try {
          nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F']).on('error', () => {
            // Best-effort; fall through to direct kill.
          });
        } catch {
          // ignore — fall through to direct kill below
        }
      }
      try {
        child.kill(signal);
      } catch {
        // ignore
      }
      return;
    }
    if (typeof pid === 'number') {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // pgid kill failed — fall through to direct kill
      }
    }
    try {
      child.kill(signal);
    } catch {
      // ignore — child may already be gone
    }
  }

  const done = new Promise<RunSummary>((resolve) => {
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearEscalation();
      emitter.emit('error', err);
      const summary: RunSummary = {
        exitCode: null,
        result,
        killedByStop,
        stopEscalation,
        stderr,
      };
      emitter.emit('close', summary);
      resolve(summary);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearEscalation();
      const summary: RunSummary = {
        exitCode: code ?? null,
        result,
        killedByStop,
        stopEscalation,
        stderr,
      };
      emitter.emit('close', summary);
      resolve(summary);
    });
  });

  const handle: AgentRunHandle = {
    pid: child.pid ?? null,
    on(event, handler): AgentRunHandle {
      emitter.on(event, handler as (...args: unknown[]) => void);
      return handle;
    },
    off(event, handler): AgentRunHandle {
      emitter.off(event, handler);
      return handle;
    },
    stop(arg?: StopOptions | NodeJS.Signals): void {
      if (killedByStop) return;
      killedByStop = true;
      const stopOpts: StopOptions = typeof arg === 'string' ? { signal: arg } : (arg ?? {});
      const signal = stopOpts.signal ?? 'SIGTERM';
      const gracefulTimeoutMs = stopOpts.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS;
      stopEscalation = signal === 'SIGKILL' ? 'sigkill' : 'sigterm';
      killTarget(signal);
      if (settled || signal === 'SIGKILL' || gracefulTimeoutMs <= 0) return;
      escalationTimer = setTimeout(() => {
        escalationTimer = null;
        if (settled) return;
        stopEscalation = 'sigkill';
        killTarget('SIGKILL');
      }, gracefulTimeoutMs);
      // Don't keep the event loop alive purely for the escalation timer.
      escalationTimer.unref?.();
    },
    done,
  };
  return handle;
}
