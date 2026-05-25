import { detectRateLimit as detectRateLimitFromText, type StreamEvent } from '../stream-parser.js';
import { appendModelArg } from './model.js';
import type { AgentCliAdapter, BuildArgsInput, ComposePromptInput } from './types.js';

// Schema mirrored from the canonical Rust definitions in
// codex-rs/exec/src/exec_events.rs (ThreadEvent / ThreadItem). Kept as TS
// types here to avoid a build-time dep on a generated bundle. Update if
// codex changes its `exec --json` envelope.

interface ThreadStartedEvent {
  type: 'thread.started';
  thread_id: string;
}

interface TurnStartedEvent {
  type: 'turn.started';
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

interface TurnCompletedEvent {
  type: 'turn.completed';
  usage?: CodexUsage;
}

interface CodexErrorPayload {
  message: string;
}

interface TurnFailedEvent {
  type: 'turn.failed';
  error: CodexErrorPayload;
}

interface CodexThreadErrorEvent {
  type: 'error';
  message: string;
}

interface CommandExecutionDetails {
  type: 'command_execution';
  command: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status: 'in_progress' | 'completed' | 'failed' | 'declined';
}

interface FileChangeDetails {
  type: 'file_change';
  changes: Array<{ path: string; kind: 'add' | 'delete' | 'update' }>;
  status: 'in_progress' | 'completed' | 'failed';
}

interface AgentMessageDetails {
  type: 'agent_message';
  text: string;
}

interface ReasoningDetails {
  type: 'reasoning';
  text: string;
}

interface McpToolCallDetails {
  type: 'mcp_tool_call';
  server: string;
  tool: string;
  arguments?: unknown;
  result?: { content: unknown[]; structured_content?: unknown } | null;
  error?: { message: string } | null;
  status: 'in_progress' | 'completed' | 'failed';
}

interface WebSearchDetails {
  type: 'web_search';
  query: string;
  action?: unknown;
}

interface ItemErrorDetails {
  type: 'error';
  message: string;
}

type ItemDetails =
  | AgentMessageDetails
  | ReasoningDetails
  | CommandExecutionDetails
  | FileChangeDetails
  | McpToolCallDetails
  | WebSearchDetails
  | ItemErrorDetails
  | { type: string };

interface ThreadItem {
  id: string;
  // codex flattens the `details` enum onto the item object via `#[serde(flatten)]`,
  // so the type discriminator and payload fields sit alongside `id`.
  type: string;
  [k: string]: unknown;
}

interface ItemEnvelope {
  type: 'item.started' | 'item.updated' | 'item.completed';
  item: ThreadItem;
}

type CodexEvent =
  | ThreadStartedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | CodexThreadErrorEvent
  | ItemEnvelope;

const SYSTEM_PROMPT_DELIMITER = '\n\n---\n\n';

const LEGACY_CODEX_MODEL_ALIASES: Readonly<Record<string, string>> = {
  'gpt-5': 'gpt-5.5',
  'gpt-5-mini': 'gpt-5.4-mini',
};

export function normalizeCodexModel(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === 'default') return undefined;
  return LEGACY_CODEX_MODEL_ALIASES[trimmed] ?? trimmed;
}

export const codexCliAdapter: AgentCliAdapter = {
  command: 'codex',
  promptDelivery: 'argv',
  normalizeModel: normalizeCodexModel,

  buildArgs(opts: BuildArgsInput): string[] {
    // The supervisor passes `appendSystemPrompt` through opts; we ignore it
    // here because codex has no equivalent flag — composePrompt prepends it
    // to the user prompt instead. `allowedTools` is similarly N/A: codex's
    // tool surface is fixed and gated by sandbox/approval policy.
    const isResume =
      typeof opts.resumeFromSessionId === 'string' && opts.resumeFromSessionId.length > 0;
    const args: string[] = ['exec'];
    if (isResume) {
      args.push('resume', opts.resumeFromSessionId as string);
    }
    args.push(
      '--json',
      '--skip-git-repo-check',
      // workspace-write keeps writes confined to cwd; combined with the
      // bypass flag below, codex won't prompt for approval per command.
      // The dispatcher already runs each agent inside an isolated worktree,
      // so this is the analogue of claude's `--permission-mode bypassPermissions`.
      '--sandbox',
      'workspace-write',
      '--dangerously-bypass-approvals-and-sandbox',
    );
    appendModelArg(args, '-m', normalizeCodexModel(opts.model));
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
    if (!trimmed.startsWith('{')) {
      // codex emits plain-text status lines like
      // "Reading additional input from stdin..." and
      // "Shell cwd was reset to ...". Drop them silently rather than flooding
      // the run transcript with parse_error events.
      return [];
    }
    let parsed: CodexEvent;
    try {
      parsed = JSON.parse(trimmed) as CodexEvent;
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

function mapEvent(ev: CodexEvent): StreamEvent[] {
  switch (ev.type) {
    case 'thread.started':
      return [{ kind: 'session', sessionId: ev.thread_id, model: null }];
    case 'turn.started':
      return [];
    case 'turn.completed':
      // Token usage is emitted here but cost is computed downstream in
      // worker.ts using the pricing table — the adapter doesn't have the
      // model id in scope.
      return [
        {
          kind: 'result',
          isError: false,
          text: '',
          tokenUsage: tokenUsageFrom(ev.usage),
          durationMs: null,
          totalCostUsd: null,
        },
      ];
    case 'turn.failed': {
      const message = ev.error?.message ?? 'codex turn failed';
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
    case 'error': {
      const message = ev.message ?? 'codex stream error';
      const out: StreamEvent[] = [];
      const rl = detectRateLimitFromText(message);
      if (rl) out.push(rl);
      // Surface the error text in the transcript so the user sees it; the
      // child process exit will drive the run-level failure state.
      out.push({ kind: 'text', text: message });
      return out;
    }
    case 'item.started':
      return mapItemStarted(ev.item);
    case 'item.updated':
      // Most updates are status-only progress (e.g. command_execution
      // streaming). Skipping these matches the claude adapter, which also
      // doesn't surface partial tool-call deltas.
      return [];
    case 'item.completed':
      return mapItemCompleted(ev.item);
    default:
      return [];
  }
}

function mapItemStarted(item: ThreadItem): StreamEvent[] {
  switch (item.type) {
    case 'command_execution': {
      const cmd = (item as unknown as CommandExecutionDetails).command;
      return [
        {
          kind: 'tool_use',
          toolUseId: item.id,
          name: 'Bash',
          input: { command: cmd },
        },
      ];
    }
    case 'file_change': {
      const changes = (item as unknown as FileChangeDetails).changes ?? [];
      return [
        {
          kind: 'tool_use',
          toolUseId: item.id,
          name: 'Edit',
          input: { changes },
        },
      ];
    }
    case 'mcp_tool_call': {
      const detail = item as unknown as McpToolCallDetails;
      return [
        {
          kind: 'tool_use',
          toolUseId: item.id,
          name: `${detail.server}.${detail.tool}`,
          input: detail.arguments ?? null,
        },
      ];
    }
    case 'web_search': {
      const detail = item as unknown as WebSearchDetails;
      return [
        {
          kind: 'tool_use',
          toolUseId: item.id,
          name: 'WebSearch',
          input: { query: detail.query, action: detail.action ?? null },
        },
      ];
    }
    default:
      return [];
  }
}

function mapItemCompleted(item: ThreadItem): StreamEvent[] {
  switch (item.type) {
    case 'agent_message': {
      const text = (item as unknown as AgentMessageDetails).text ?? '';
      return extractTextWithDecisions(text);
    }
    case 'reasoning':
      // claude's `thinking` content is also dropped — keep parity.
      return [];
    case 'command_execution': {
      const detail = item as unknown as CommandExecutionDetails;
      const isError =
        detail.status === 'failed' ||
        detail.status === 'declined' ||
        (typeof detail.exit_code === 'number' && detail.exit_code !== 0);
      return [
        {
          kind: 'tool_result',
          toolUseId: item.id,
          isError,
          content: detail.aggregated_output ?? '',
        },
      ];
    }
    case 'file_change': {
      const detail = item as unknown as FileChangeDetails;
      const isError = detail.status === 'failed';
      return [
        {
          kind: 'tool_result',
          toolUseId: item.id,
          isError,
          content: { status: detail.status, changes: detail.changes ?? [] },
        },
      ];
    }
    case 'mcp_tool_call': {
      const detail = item as unknown as McpToolCallDetails;
      const isError = detail.status === 'failed' || detail.error != null;
      return [
        {
          kind: 'tool_result',
          toolUseId: item.id,
          isError,
          content: detail.error
            ? { error: detail.error.message }
            : (detail.result?.content ?? null),
        },
      ];
    }
    case 'web_search': {
      return [
        {
          kind: 'tool_result',
          toolUseId: item.id,
          isError: false,
          content: null,
        },
      ];
    }
    case 'error': {
      const message = (item as unknown as ItemErrorDetails).message ?? 'codex item error';
      return [{ kind: 'text', text: message }];
    }
    default:
      return [];
  }
}

const DECISION_BLOCK_RE = /```kanbots-decision\s*\n([\s\S]*?)\n```/g;

// Mirror of stream-parser.ts:extractTextEvents. Kept inline so the codex
// adapter doesn't depend on an internal helper that may evolve separately
// for the Anthropic stream shape.
function extractTextWithDecisions(text: string): StreamEvent[] {
  if (text.length === 0) return [];
  const out: StreamEvent[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(DECISION_BLOCK_RE)) {
    const before = text.slice(lastIndex, match.index ?? 0);
    if (before.trim().length > 0) out.push({ kind: 'text', text: before });
    const body = match[1] ?? '';
    const decision = parseDecisionBody(body);
    if (decision) out.push(decision);
    lastIndex = (match.index ?? 0) + match[0].length;
  }
  const tail = text.slice(lastIndex);
  if (tail.trim().length > 0) out.push({ kind: 'text', text: tail });
  if (out.length === 0 && text.trim().length > 0) {
    out.push({ kind: 'text', text });
  }
  return out;
}

function parseDecisionBody(body: string): StreamEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const question = typeof obj.question === 'string' ? obj.question : null;
  const rawOptions = Array.isArray(obj.options) ? obj.options : null;
  if (!question || !rawOptions) return null;
  const options: Array<{ value: string; label: string }> = [];
  for (const opt of rawOptions) {
    if (typeof opt !== 'object' || opt === null) continue;
    const o = opt as Record<string, unknown>;
    const value = typeof o.value === 'string' ? o.value : null;
    const label = typeof o.label === 'string' ? o.label : value;
    if (value && label) options.push({ value, label });
  }
  if (options.length === 0) return null;
  return { kind: 'decision', question, options };
}

function tokenUsageFrom(usage: CodexUsage | undefined): { input: number; output: number } | null {
  if (!usage) return null;
  if (typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') {
    return null;
  }
  return { input: usage.input_tokens, output: usage.output_tokens };
}
