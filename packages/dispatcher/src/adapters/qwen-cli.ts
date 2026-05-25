import { detectRateLimit as detectRateLimitFromText, type StreamEvent } from '../stream-parser.js';
import { appendModelArg } from './model.js';
import type { AgentCliAdapter, BuildArgsInput, ComposePromptInput } from './types.js';

/**
 * Qwen Code CLI adapter. Spawns `qwen-code` and parses its line-delimited
 * stream-json output.
 *
 * Auth: qwen-code finds its own credentials. The CLI's own login flow
 * writes under `~/.qwen/`. The app does not store or inject qwen
 * credentials.
 *
 * `--yolo` is the permissive flag and is on by default — parity with
 * gemini's `--yolo`, claude's bypass mode, and codex's bypass-approvals.
 * The dispatcher already isolates each run in a worktree, so this is the
 * same trust envelope.
 *
 * Qwen's interactive mode speaks ACP via `--acp`; for non-interactive
 * agent runs we use the stream-json envelope, which mirrors gemini's
 * shape closely (both projects descend from the same upstream).
 *
 * Stream envelope:
 *   { "type": "session",     "session_id": "...", "model": "..." }
 *   { "type": "message",     "text": "..." }
 *   { "type": "thought",     "text": "..." }                          // ignored
 *   { "type": "tool_use",    "id": "...", "name": "...", "input": {...} }
 *   { "type": "tool_result", "tool_use_id": "...", "output": "...", "is_error": false }
 *   { "type": "result",      "exit_code": 0, "duration_ms": 1234 }
 */

interface QwenSessionEvent {
  type: 'session' | 'session_started' | 'init';
  session_id?: string;
  sessionId?: string;
  model?: string;
}

interface QwenMessageEvent {
  type: 'message';
  text?: string;
}

interface QwenThoughtEvent {
  type: 'thought';
}

interface QwenToolUseEvent {
  type: 'tool_use';
  id?: string;
  name?: string;
  input?: unknown;
}

interface QwenToolResultEvent {
  type: 'tool_result';
  tool_use_id?: string;
  output?: unknown;
  is_error?: boolean;
}

interface QwenResultEvent {
  type: 'result';
  exit_code?: number;
  duration_ms?: number;
  error?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

type QwenEvent =
  | QwenSessionEvent
  | QwenMessageEvent
  | QwenThoughtEvent
  | QwenToolUseEvent
  | QwenToolResultEvent
  | QwenResultEvent
  | { type: string };

const SYSTEM_PROMPT_DELIMITER = '\n\n---\n\n';

export const qwenCliAdapter: AgentCliAdapter = {
  command: 'qwen-code',
  promptDelivery: 'stdin',

  buildArgs(opts: BuildArgsInput): string[] {
    // `--yolo` skips per-tool permission prompts — the qwen analogue of
    // claude's bypass mode. The dispatcher's worktree isolation gives
    // the same trust envelope.
    const args: string[] = ['--yolo', '--output-format', 'json-stream'];
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
    let parsed: QwenEvent;
    try {
      parsed = JSON.parse(trimmed) as QwenEvent;
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

function mapEvent(ev: QwenEvent): StreamEvent[] {
  switch (ev.type) {
    case 'session':
    case 'session_started':
    case 'init': {
      const session = ev as QwenSessionEvent;
      const sessionId = session.session_id ?? session.sessionId;
      if (typeof sessionId !== 'string') return [];
      return [
        {
          kind: 'session',
          sessionId,
          model: typeof session.model === 'string' ? session.model : null,
        },
      ];
    }
    case 'thought':
      return [];
    case 'message': {
      const text = (ev as QwenMessageEvent).text ?? '';
      if (text.length === 0) return [];
      return [{ kind: 'text', text }];
    }
    case 'tool_use': {
      const tu = ev as QwenToolUseEvent;
      if (typeof tu.id !== 'string' || typeof tu.name !== 'string') return [];
      return [
        {
          kind: 'tool_use',
          toolUseId: tu.id,
          name: tu.name,
          input: tu.input ?? null,
        },
      ];
    }
    case 'tool_result': {
      const tr = ev as QwenToolResultEvent;
      if (typeof tr.tool_use_id !== 'string') return [];
      return [
        {
          kind: 'tool_result',
          toolUseId: tr.tool_use_id,
          isError: tr.is_error === true,
          content: tr.output ?? null,
        },
      ];
    }
    case 'result': {
      const r = ev as QwenResultEvent;
      const isError = typeof r.exit_code === 'number' && r.exit_code !== 0;
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
        totalCostUsd: null,
      });
      return out;
    }
    default:
      return [];
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
