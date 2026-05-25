import { detectRateLimit as detectRateLimitFromText, type StreamEvent } from '../stream-parser.js';
import { appendModelArg } from './model.js';
import type { AgentCliAdapter, BuildArgsInput, ComposePromptInput } from './types.js';

/**
 * Factory Droid CLI adapter. Spawns `droid exec` and parses its
 * line-delimited stream-json output.
 *
 * Auth: droid finds its own credentials. The CLI's own login flow drives
 * sign-in; settings are stored under `~/.factory/`. The app does not store
 * or inject droid credentials.
 *
 * `--skip-permissions-unsafe` is the permissive flag and is on by default
 * — parity with claude's `--permission-mode bypassPermissions` and codex's
 * `--dangerously-bypass-approvals-and-sandbox`. The dispatcher already
 * isolates each run in a worktree, so this is the same trust envelope.
 *
 * Stream envelope:
 *   { "type": "system",     "session_id": "...", "model": "..." }
 *   { "type": "message",    "role": "assistant" | "user" | "system", "text": "..." }
 *   { "type": "tool_call",  "id": "...", "tool_name": "...", "parameters": {...} }
 *   { "type": "tool_result","tool_use_id": "...", "output": "...", "is_error": false }
 *   { "type": "result",     "is_error": false, "duration_ms": 1234 }
 */

interface DroidSystemEvent {
  type: 'system';
  session_id?: string;
  model?: string;
}

interface DroidMessageEvent {
  type: 'message';
  role?: string;
  text?: string;
}

interface DroidToolCallEvent {
  type: 'tool_call';
  id?: string;
  tool_name?: string;
  parameters?: unknown;
}

interface DroidToolResultEvent {
  type: 'tool_result';
  tool_use_id?: string;
  output?: unknown;
  is_error?: boolean;
}

interface DroidResultEvent {
  type: 'result';
  is_error?: boolean;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: unknown;
}

type DroidEvent =
  | DroidSystemEvent
  | DroidMessageEvent
  | DroidToolCallEvent
  | DroidToolResultEvent
  | DroidResultEvent
  | { type: string };

const SYSTEM_PROMPT_DELIMITER = '\n\n---\n\n';

export const droidCliAdapter: AgentCliAdapter = {
  command: 'droid',
  promptDelivery: 'stdin',

  buildArgs(opts: BuildArgsInput): string[] {
    // `exec` is the non-interactive subcommand. stream-json gives us
    // structured events; --skip-permissions-unsafe is the permissive
    // autonomy level — equivalent to gemini's `--yolo` and claude's
    // bypass mode. The dispatcher's worktree isolation is the same
    // trust envelope.
    const args: string[] = ['exec', '--output-format', 'stream-json', '--skip-permissions-unsafe'];
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
    let parsed: DroidEvent;
    try {
      parsed = JSON.parse(trimmed) as DroidEvent;
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

function mapEvent(ev: DroidEvent): StreamEvent[] {
  switch (ev.type) {
    case 'system': {
      const sys = ev as DroidSystemEvent;
      if (typeof sys.session_id !== 'string') return [];
      return [
        {
          kind: 'session',
          sessionId: sys.session_id,
          model: typeof sys.model === 'string' ? sys.model : null,
        },
      ];
    }
    case 'message': {
      const m = ev as DroidMessageEvent;
      const text = m.text ?? '';
      // Drop user/system echoes — only assistant text becomes transcript.
      // Matches the codex adapter's filter on agent_message.
      if (m.role && m.role !== 'assistant') return [];
      if (text.length === 0) return [];
      return [{ kind: 'text', text }];
    }
    case 'tool_call': {
      const tc = ev as DroidToolCallEvent;
      if (typeof tc.id !== 'string' || typeof tc.tool_name !== 'string') return [];
      return [
        {
          kind: 'tool_use',
          toolUseId: tc.id,
          name: tc.tool_name,
          input: tc.parameters ?? null,
        },
      ];
    }
    case 'tool_result': {
      const tr = ev as DroidToolResultEvent;
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
      const r = ev as DroidResultEvent;
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
