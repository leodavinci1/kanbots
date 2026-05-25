import { detectRateLimit as detectRateLimitFromText, type StreamEvent } from '../stream-parser.js';
import { appendModelArg } from './model.js';
import type { AgentCliAdapter, BuildArgsInput, ComposePromptInput } from './types.js';

/**
 * SST OpenCode CLI adapter. Spawns `opencode` and parses its
 * line-delimited JSON output.
 *
 * Auth: opencode finds its own credentials. The CLI's own login flow
 * configures providers under `~/.local/share/opencode/`. The app does not
 * store or inject opencode credentials.
 *
 * `--dangerously-skip-permissions` is the permissive flag and is on by
 * default — parity with claude's `--permission-mode bypassPermissions` and codex's
 * `--dangerously-bypass-approvals-and-sandbox`. The dispatcher already
 * isolates each run in a worktree, so this is the same trust envelope.
 *
 * Stream envelope (defensive; opencode's run-mode JSON shape is still
 * evolving, so we accept several legal variants and drop the rest):
 *   { "type": "session",    "session_id": "...", "model": "..." }
 *   { "type": "assistant",  "text": "..." }                          // or { "text": { "delta": "..." } }
 *   { "type": "tool_use",   "id": "...", "name": "...", "input": {...} }
 *   { "type": "tool_result","tool_use_id": "...", "output": "...", "is_error": false }
 *   { "type": "result",     "is_error": false, "duration_ms": 1234 }
 */

interface OpencodeSessionEvent {
  type: 'session' | 'session_started' | 'init';
  session_id?: string;
  sessionId?: string;
  model?: string;
}

interface OpencodeAssistantEvent {
  type: 'assistant' | 'message' | 'text';
  text?: unknown;
}

interface OpencodeToolUseEvent {
  type: 'tool_use' | 'tool_call';
  id?: string;
  name?: string;
  tool?: string;
  input?: unknown;
  parameters?: unknown;
}

interface OpencodeToolResultEvent {
  type: 'tool_result' | 'tool_response';
  tool_use_id?: string;
  output?: unknown;
  result?: unknown;
  is_error?: boolean;
}

interface OpencodeResultEvent {
  type: 'result' | 'turn.completed' | 'done';
  is_error?: boolean;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  cost_usd?: number;
  error?: unknown;
}

interface OpencodeErrorEvent {
  type: 'error';
  error?: unknown;
}

type OpencodeEvent =
  | OpencodeSessionEvent
  | OpencodeAssistantEvent
  | OpencodeToolUseEvent
  | OpencodeToolResultEvent
  | OpencodeResultEvent
  | OpencodeErrorEvent
  | { type: string };

const SYSTEM_PROMPT_DELIMITER = '\n\n---\n\n';

export const opencodeCliAdapter: AgentCliAdapter = {
  command: 'opencode',
  promptDelivery: 'stdin',

  buildArgs(opts: BuildArgsInput): string[] {
    // `run` is the non-interactive subcommand. --format json is the
    // structured event channel; --dangerously-skip-permissions skips
    // per-tool prompts so the agent runs unattended inside its sandbox. The
    // dispatcher's worktree isolation gives the same trust envelope as
    // claude's bypass mode.
    const args: string[] = ['run', '--format', 'json', '--dangerously-skip-permissions'];
    appendModelArg(args, '--model', opts.model);
    if (opts.extraArgs && opts.extraArgs.length > 0) {
      args.push(...opts.extraArgs);
    }
    return args;
  },

  composePrompt(input: ComposePromptInput): string {
    if (!input.systemPrompt || input.systemPrompt.length === 0) {
      return input.prompt;
    }
    return `${input.systemPrompt}${SYSTEM_PROMPT_DELIMITER}${input.prompt}`;
  },

  parseLine(line: string): StreamEvent[] {
    const trimmed = line.trim();
    if (trimmed.length === 0) return [];
    if (!trimmed.startsWith('{')) return [];
    let parsed: OpencodeEvent;
    try {
      parsed = JSON.parse(trimmed) as OpencodeEvent;
    } catch (err) {
      return [
        {
          kind: 'parse_error',
          raw: trimmed,
          message: err instanceof Error ? err.message : String(err),
        },
      ];
    }
    if (typeof (parsed as { type?: unknown }).type !== 'string') return [];
    return mapEvent(parsed);
  },

  detectRateLimit(text: string) {
    return detectRateLimitFromText(text);
  },
};

function extractText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const delta = (raw as { delta?: unknown }).delta;
    if (typeof delta === 'string') return delta;
    const text = (raw as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

function mapEvent(ev: OpencodeEvent): StreamEvent[] {
  switch (ev.type) {
    case 'session':
    case 'session_started':
    case 'init': {
      const s = ev as OpencodeSessionEvent;
      const sessionId = s.session_id ?? s.sessionId;
      if (typeof sessionId !== 'string') return [];
      return [
        {
          kind: 'session',
          sessionId,
          model: typeof s.model === 'string' ? s.model : null,
        },
      ];
    }
    case 'assistant':
    case 'message':
    case 'text': {
      const text = extractText((ev as OpencodeAssistantEvent).text);
      if (text.length === 0) return [];
      return [{ kind: 'text', text }];
    }
    case 'tool_use':
    case 'tool_call': {
      const tu = ev as OpencodeToolUseEvent;
      const id = typeof tu.id === 'string' ? tu.id : null;
      const name =
        typeof tu.name === 'string' ? tu.name : typeof tu.tool === 'string' ? tu.tool : null;
      if (id === null || name === null) return [];
      return [
        {
          kind: 'tool_use',
          toolUseId: id,
          name,
          input: tu.input ?? tu.parameters ?? null,
        },
      ];
    }
    case 'tool_result':
    case 'tool_response': {
      const tr = ev as OpencodeToolResultEvent;
      if (typeof tr.tool_use_id !== 'string') return [];
      return [
        {
          kind: 'tool_result',
          toolUseId: tr.tool_use_id,
          isError: tr.is_error === true,
          content: tr.output ?? tr.result ?? null,
        },
      ];
    }
    case 'result':
    case 'turn.completed':
    case 'done': {
      const r = ev as OpencodeResultEvent;
      const isError = r.is_error === true;
      const out: StreamEvent[] = [];
      if (isError && r.error !== undefined) {
        const errText = typeof r.error === 'string' ? r.error : JSON.stringify(r.error);
        const rl = detectRateLimitFromText(errText);
        if (rl) out.push(rl);
      }
      out.push({
        kind: 'result',
        isError,
        text:
          isError && r.error !== undefined
            ? typeof r.error === 'string'
              ? r.error
              : JSON.stringify(r.error)
            : '',
        tokenUsage: tokenUsageFrom(r.usage),
        durationMs: typeof r.duration_ms === 'number' ? r.duration_ms : null,
        totalCostUsd: typeof r.cost_usd === 'number' ? r.cost_usd : null,
      });
      return out;
    }
    case 'error': {
      const message = extractErrorMessage((ev as OpencodeErrorEvent).error);
      const out: StreamEvent[] = [];
      const rl = detectRateLimitFromText(message);
      if (rl) out.push(rl);
      out.push({
        kind: 'result',
        isError: true,
        text: message,
        tokenUsage: null,
        durationMs: null,
        totalCostUsd: null,
      });
      return out;
    }
    default:
      return [];
  }
}

function extractErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === 'object') {
      const message = (data as { message?: unknown }).message;
      if (typeof message === 'string' && message.length > 0) return message;
    }
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  try {
    return JSON.stringify(error) ?? 'unknown opencode error';
  } catch {
    return String(error);
  }
}

function tokenUsageFrom(
  usage: { input_tokens?: number; output_tokens?: number } | undefined,
): { input: number; output: number } | null {
  if (!usage) return null;
  if (typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') {
    return null;
  }
  return { input: usage.input_tokens, output: usage.output_tokens };
}
