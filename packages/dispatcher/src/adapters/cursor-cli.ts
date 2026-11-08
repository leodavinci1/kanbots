import {
  detectRateLimit as detectRateLimitFromText,
  extractTextEvents,
  type StreamEvent,
} from '../stream-parser.js';
import type {
  AgentCliAdapter,
  BuildArgsInput,
  ComposePromptInput,
} from './types.js';

/**
 * Cursor Agent CLI adapter. Spawns `cursor-agent` and parses its
 * line-delimited stream-json output.
 *
 * Auth: cursor-agent finds its own credentials. The CLI's own
 * `cursor-agent login` flow drives OAuth; `CURSOR_API_KEY` in the ambient
 * environment is the alternate path. The app does not store or inject
 * cursor credentials.
 *
 * `--force` is the permissive flag and is on by default — parity with
 * claude's `--permission-mode bypassPermissions` and codex's
 * `--dangerously-bypass-approvals-and-sandbox`. The dispatcher already
 * isolates each run in a worktree, so this is the same trust envelope.
 *
 * Stream envelope (typed and stable; cursor uses a tagged `type` union):
 *   { "type": "system",     "session_id": "...", "model": "..." }
 *   { "type": "assistant",  "message": { "role": "...", "content": [{ "type": "text", "text": "..." }] } }
 *   { "type": "thinking",   "text": "..." }                        // ignored
 *   { "type": "tool_call",  "subtype": "started" | "completed", "call_id": "...", "tool_call": { ... } }
 *   { "type": "result",     "is_error": false, "duration_ms": 1234 }
 *
 * Tool calls are tagged variants (`shellToolCall`, `readToolCall`, etc.) —
 * we surface the friendly name (`shell`, `read`, ...) so renderer logic
 * that special-cases Edit/Write/MultiEdit can pick them up. The `started`
 * subtype emits a `tool_use`; the `completed` subtype emits the matching
 * `tool_result` with whatever the tool produced.
 */

interface CursorSystemEvent {
  type: 'system';
  session_id?: string;
  model?: string;
}

interface CursorContentItem {
  type: 'text';
  text: string;
}

interface CursorMessage {
  role: string;
  content?: CursorContentItem[];
}

interface CursorAssistantEvent {
  type: 'assistant';
  message?: CursorMessage;
  session_id?: string;
}

interface CursorThinkingEvent {
  type: 'thinking';
  text?: string;
}

interface CursorToolCallPayload {
  // Cursor's tool union is tagged by an internal name like `shellToolCall`.
  // The wrapper object has a single key — we surface its short name. The
  // payload underneath is forwarded as the tool input verbatim.
  [variant: string]: { args?: unknown; result?: unknown } | unknown;
}

interface CursorToolCallEvent {
  type: 'tool_call';
  subtype?: 'started' | 'completed' | string;
  call_id?: string;
  tool_call?: CursorToolCallPayload;
}

interface CursorUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

interface CursorResultEvent {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  duration_ms?: number;
  result?: unknown;
  usage?: CursorUsage;
}

type CursorEvent =
  | CursorSystemEvent
  | CursorAssistantEvent
  | CursorThinkingEvent
  | CursorToolCallEvent
  | CursorResultEvent
  | { type: string };

const SYSTEM_PROMPT_DELIMITER = '\n\n---\n\n';

const TOOL_CALL_VARIANT_TO_NAME: Record<string, string> = {
  shellToolCall: 'Bash',
  lsToolCall: 'LS',
  globToolCall: 'Glob',
  grepToolCall: 'Grep',
  semSearchToolCall: 'SemSearch',
  writeToolCall: 'Write',
  readToolCall: 'Read',
  editToolCall: 'Edit',
  deleteToolCall: 'Delete',
  updateTodosToolCall: 'Todo',
  mcpToolCall: 'MCP',
};

function shortNameFor(variant: string): string {
  return TOOL_CALL_VARIANT_TO_NAME[variant] ?? variant;
}

function tokenUsageFrom(
  usage: CursorUsage | undefined,
): { input: number; output: number; cachedInput?: number } | null {
  if (!usage) return null;
  if (typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') {
    return null;
  }
  const out: { input: number; output: number; cachedInput?: number } = {
    input: usage.inputTokens,
    // Reasoning tokens are billed as output on most vendors; fold them in so
    // Auto estimates aren't silently under-counted.
    output:
      usage.outputTokens +
      (typeof usage.reasoningTokens === 'number' ? usage.reasoningTokens : 0),
  };
  if (typeof usage.cacheReadTokens === 'number' && usage.cacheReadTokens > 0) {
    out.cachedInput = usage.cacheReadTokens;
  }
  return out;
}

export const cursorCliAdapter: AgentCliAdapter = {
  command: 'cursor-agent',
  promptDelivery: 'stdin',

  buildArgs(opts: BuildArgsInput): string[] {
    // -p switches the CLI into non-interactive print mode. --force makes
    // every command auto-approve (the cursor permissive default); `auto`
    // is the model alias that lets cursor pick the best model for the
    // task. The dispatcher's worktree isolation gives the same trust
    // envelope as claude's bypass mode.
    const args: string[] = ['-p', '--output-format=stream-json', '--force'];
    args.push('--model', opts.model && opts.model.length > 0 ? opts.model : 'auto');
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
    let parsed: CursorEvent;
    try {
      parsed = JSON.parse(trimmed) as CursorEvent;
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

function mapEvent(ev: CursorEvent): StreamEvent[] {
  switch (ev.type) {
    case 'system': {
      const sys = ev as CursorSystemEvent;
      if (typeof sys.session_id !== 'string' || sys.session_id.length === 0) return [];
      return [
        {
          kind: 'session',
          sessionId: sys.session_id,
          model: typeof sys.model === 'string' ? sys.model : null,
        },
      ];
    }
    case 'assistant': {
      const msg = (ev as CursorAssistantEvent).message;
      const content = msg?.content;
      if (!Array.isArray(content)) return [];
      const out: StreamEvent[] = [];
      for (const item of content) {
        if (item.type === 'text' && typeof item.text === 'string' && item.text.length > 0) {
          // Parity with claude/codex: turn ```kanbots-decision``` fences into
          // decision events so the UI shows option buttons instead of raw JSON.
          out.push(...extractTextEvents(item.text));
        }
      }
      return out;
    }
    case 'thinking':
      // Parity with claude/codex/gemini: planning chunks are dropped from
      // the transcript. The supervisor surfaces tool calls and messages.
      return [];
    case 'tool_call':
      return mapToolCall(ev as CursorToolCallEvent);
    case 'result': {
      const r = ev as CursorResultEvent;
      const isError = r.is_error === true;
      const out: StreamEvent[] = [];
      if (isError && typeof r.result !== 'undefined') {
        const errText = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
        const rl = detectRateLimitFromText(errText);
        if (rl) out.push(rl);
      }
      out.push({
        kind: 'result',
        isError,
        text:
          isError && typeof r.result !== 'undefined'
            ? typeof r.result === 'string'
              ? r.result
              : JSON.stringify(r.result)
            : '',
        // cursor-agent stream-json includes usage{inputTokens,outputTokens,…}.
        // Worker fills totalCostUsd from the pricing table (Auto → estimate).
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

function mapToolCall(ev: CursorToolCallEvent): StreamEvent[] {
  const callId = typeof ev.call_id === 'string' ? ev.call_id : null;
  const tc = ev.tool_call;
  if (callId === null || !tc || typeof tc !== 'object') return [];

  // The tool_call object is a tagged union with a single variant key. Pull
  // out the first key and use it as the discriminator. (If a future
  // cursor build adds multiple keys, we still take the first deterministically.)
  const variantKey = Object.keys(tc)[0];
  if (variantKey === undefined) return [];
  const inner = (tc as Record<string, { args?: unknown; result?: unknown } | unknown>)[
    variantKey
  ] as { args?: unknown; result?: unknown } | undefined;
  const toolName = shortNameFor(variantKey);
  const subtype = ev.subtype;

  if (subtype === 'started') {
    return [
      {
        kind: 'tool_use',
        toolUseId: callId,
        name: toolName,
        input: inner?.args ?? null,
      },
    ];
  }
  if (subtype === 'completed') {
    return [
      {
        kind: 'tool_result',
        toolUseId: callId,
        isError: false,
        content: inner?.result ?? null,
      },
    ];
  }
  return [];
}
