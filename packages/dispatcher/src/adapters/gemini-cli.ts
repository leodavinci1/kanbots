import { detectRateLimit as detectRateLimitFromText, type StreamEvent } from '../stream-parser.js';
import { appendModelArg } from './model.js';
import type { AgentCliAdapter, BuildArgsInput, ComposePromptInput } from './types.js';

/**
 * Google Gemini CLI adapter. Spawns `gemini` and parses its line-delimited
 * JSON stream.
 *
 * Auth: gemini finds its own credentials (`~/.gemini/oauth_creds.json` from
 * `gemini /login`, or `GEMINI_API_KEY` in the environment). The app does not
 * store or inject gemini credentials.
 *
 * The CLI accepts the prompt over stdin so we can feed long prompts without
 * worrying about argv length. `--yolo` skips permission prompts at the CLI
 * level — equivalent to claude's `--permission-mode bypassPermissions` and
 * codex's `--dangerously-bypass-approvals-and-sandbox`. The dispatcher
 * already isolates each agent in a worktree, so this is safe.
 *
 * Stream shape (verified against the brief's description; ambiguous fields
 * are mapped defensively):
 *   { "type": "thought",     "text": "..." }                          // ignored
 *   { "type": "tool_use",    "name": "...", "input": {...}, "id": "..." }
 *   { "type": "tool_result", "tool_use_id": "...", "output": "...", "is_error": false }
 *   { "type": "message",     "text": "..." }
 *   { "type": "result",      "exit_code": 0, "duration_ms": 1234, "cost_usd": 0.012 }
 */

interface GeminiThoughtEvent {
  type: 'thought';
  text?: string;
}

interface GeminiToolUseEvent {
  type: 'tool_use';
  id?: string;
  name?: string;
  input?: unknown;
}

interface GeminiToolResultEvent {
  type: 'tool_result';
  tool_use_id?: string;
  output?: unknown;
  is_error?: boolean;
}

interface GeminiMessageEvent {
  type: 'message';
  text?: string;
}

interface GeminiResultEvent {
  type: 'result';
  exit_code?: number;
  duration_ms?: number;
  cost_usd?: number;
  error?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface GeminiSessionEvent {
  type: 'session' | 'session_started' | 'init';
  session_id?: string;
  sessionId?: string;
  model?: string;
}

type GeminiEvent =
  | GeminiThoughtEvent
  | GeminiToolUseEvent
  | GeminiToolResultEvent
  | GeminiMessageEvent
  | GeminiResultEvent
  | GeminiSessionEvent
  | { type: string };

const SYSTEM_PROMPT_DELIMITER = '\n\n---\n\n';

export const geminiCliAdapter: AgentCliAdapter = {
  command: 'gemini',
  promptDelivery: 'stdin',

  buildArgs(opts: BuildArgsInput): string[] {
    // `--yolo` is the default permissive flag (see catalogue defaults).
    // Per parity with claude/codex, kanbots already isolates each run in a
    // worktree, so the user is opting into the same "trust the agent inside
    // its sandbox" model the other adapters use.
    const args: string[] = ['--yolo', '--output-format', 'json-stream'];
    appendModelArg(args, '--model', opts.model);
    if (opts.extraArgs && opts.extraArgs.length > 0) {
      args.push(...opts.extraArgs);
    }
    // appendSystemPrompt and allowedTools are folded in by composePrompt
    // because the CLI doesn't expose dedicated flags for either today.
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
    if (!trimmed.startsWith('{')) {
      // CLIs often print status banners or progress notes outside the JSON
      // stream. Drop them silently rather than spamming parse_error events.
      return [];
    }
    let parsed: GeminiEvent;
    try {
      parsed = JSON.parse(trimmed) as GeminiEvent;
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

function mapEvent(ev: GeminiEvent): StreamEvent[] {
  switch (ev.type) {
    case 'session':
    case 'session_started':
    case 'init': {
      const session = ev as GeminiSessionEvent;
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
      // Match claude/codex parity: planning/reasoning is dropped from the
      // transcript. The supervisor surfaces tool calls and messages only.
      return [];
    case 'message': {
      const text = (ev as GeminiMessageEvent).text ?? '';
      if (text.length === 0) return [];
      return [{ kind: 'text', text }];
    }
    case 'tool_use': {
      const tu = ev as GeminiToolUseEvent;
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
      const tr = ev as GeminiToolResultEvent;
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
      const r = ev as GeminiResultEvent;
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
        totalCostUsd: typeof r.cost_usd === 'number' ? r.cost_usd : null,
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
