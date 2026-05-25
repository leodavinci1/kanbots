import { z } from 'zod';
import type { AgentRunProvider } from '@kanbots/dispatcher';
import type {
  AgentEvent,
  AgentRun,
  Card,
  ChatConversation,
  ChatSession,
  Message,
  ProviderId,
} from '@kanbots/local-store';
import type { ChatPayload, ChatPostMessageResult, ChatSessionPayload } from '../bridge.js';
import { chatSessionToPayload } from '../bridge.js';
import { alreadyActive, notFound, parseArgs } from './errors.js';
import type { HandlerDeps } from './types.js';

const KNOWN_PROVIDERS: ReadonlySet<AgentRunProvider> = new Set([
  'claude-code',
  'codex-cli',
  'gemini-cli',
  'amp-cli',
  'cursor-cli',
  'copilot-cli',
  'opencode-cli',
  'droid-cli',
  'ccr-cli',
  'qwen-cli',
  'acp',
]);

function resolveChatProvider(
  deps: HandlerDeps,
  explicit: AgentRunProvider | undefined,
  resumeFrom: AgentRun | null,
): AgentRunProvider {
  if (resumeFrom !== null) {
    const persisted = resumeFrom.provider;
    if (persisted && KNOWN_PROVIDERS.has(persisted as AgentRunProvider)) {
      return persisted as AgentRunProvider;
    }
    return 'claude-code';
  }
  if (explicit) return explicit;
  try {
    const def = deps.store.providerSettings.get().defaultProvider;
    if (def && KNOWN_PROVIDERS.has(def as AgentRunProvider)) {
      return def as AgentRunProvider;
    }
  } catch {
    // settings row may be missing on first run — fall through
  }
  return 'claude-code';
}

/**
 * Resolve the chat session a posted message should target. Strategy:
 *   1. If the caller passed a sessionId, validate it belongs to the
 *      conversation and use it.
 *   2. Otherwise reuse the most-recently-active session.
 *   3. If the conversation has no session yet (migration backfills one,
 *      but a fresh conversation may not), auto-create one using the
 *      caller's provider/model or the workspace default.
 * Returns the resolved session — never throws when the conversation
 * exists.
 */
function resolveSessionForPost(
  deps: HandlerDeps,
  conversationId: number,
  explicitSessionId: number | undefined,
  provider: AgentRunProvider,
  model: string | undefined,
): ChatSession {
  if (explicitSessionId !== undefined) {
    const explicit = deps.store.chatSessions.findById(explicitSessionId);
    if (!explicit) {
      throw notFound(`chat session ${explicitSessionId} not found`);
    }
    if (explicit.conversationId !== conversationId) {
      throw notFound(
        `chat session ${explicitSessionId} does not belong to conversation ${conversationId}`,
      );
    }
    return explicit;
  }
  const existing = deps.store.chatSessions.findMostRecentForConversation(conversationId);
  if (existing) return existing;
  return deps.store.chatSessions.create({
    conversationId,
    agentProvider: provider as ProviderId,
    ...(model !== undefined ? { agentModel: model } : {}),
  });
}

const createSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
  })
  .strict();

const getSchema = z
  .object({
    conversationId: z.number().int().positive(),
  })
  .strict();

const renameSchema = z
  .object({
    conversationId: z.number().int().positive(),
    title: z.string().min(1).max(200),
  })
  .strict();

const deleteSchema = z
  .object({
    conversationId: z.number().int().positive(),
  })
  .strict();

const PROVIDER_ENUM = z.enum([
  'claude-code',
  'codex-cli',
  'gemini-cli',
  'amp-cli',
  'cursor-cli',
  'copilot-cli',
  'opencode-cli',
  'droid-cli',
  'ccr-cli',
  'qwen-cli',
  'acp',
]);

const postMessageSchema = z
  .object({
    conversationId: z.number().int().positive(),
    body: z.string().min(1).max(65_536),
    dispatch: z.boolean().optional(),
    model: z.string().min(1).max(120).optional(),
    provider: PROVIDER_ENUM.optional(),
    appendSystemPrompt: z.string().max(20_000).optional(),
    sessionId: z.number().int().positive().optional(),
  })
  .strict();

const stopRunSchema = z.object({ runId: z.number().int().positive() }).strict();

const sessionsListSchema = z.object({ conversationId: z.number().int().positive() }).strict();

const sessionsCreateSchema = z
  .object({
    conversationId: z.number().int().positive(),
    agentProvider: PROVIDER_ENUM,
    agentModel: z.string().min(1).max(120).optional(),
    title: z.string().min(1).max(200).optional(),
  })
  .strict();

const sessionsRenameSchema = z
  .object({
    id: z.number().int().positive(),
    title: z.string().min(1).max(200).nullable(),
  })
  .strict();

const sessionsDeleteSchema = z.object({ id: z.number().int().positive() }).strict();

const sessionsSetActiveSchema = z
  .object({
    conversationId: z.number().int().positive(),
    sessionId: z.number().int().positive(),
  })
  .strict();

// Issue-thread variants of the chat-session schemas. Keyed on threadId
// instead of conversationId; otherwise identical in validation. The
// chat:thread-sessions:* channels dispatch through these so the
// renderer's session dropdown can drive issue chats with the same
// affordances it uses for the standalone chat surface.
const threadSessionsListSchema = z.object({ threadId: z.number().int().positive() }).strict();

const threadSessionsCreateSchema = z
  .object({
    threadId: z.number().int().positive(),
    agentProvider: PROVIDER_ENUM,
    agentModel: z.string().min(1).max(120).optional(),
    title: z.string().min(1).max(200).optional(),
  })
  .strict();

const DEFAULT_TITLE = 'New chat';

/**
 * Derive a human-friendly chat title from the first user message. Falls back
 * to the default sentinel if the message is empty or all whitespace. Kept
 * deterministic and zero-cost (no LLM round-trip) — the user can always
 * rename via `chat:rename` if the auto-derived title is poor.
 */
function deriveChatTitle(body: string): string {
  const firstLine = body.split('\n').find((line) => line.trim().length > 0) ?? '';
  const cleaned = firstLine.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return DEFAULT_TITLE;
  if (cleaned.length <= 60) return cleaned;
  return `${cleaned.slice(0, 57)}…`;
}

const SYSTEM_PROMPT_DEFAULT = `KANBOTS_CHAT_CONTEXT — this conversation is a general-purpose chat with the kanbots agent. It is NOT scoped to any single issue.

You can use the kanban tools provided by the kanbots MCP server (createIssue, updateIssue, moveIssueStatus, archiveIssue, splitIssue, dispatchAgent, stopAgentRun, listIssues, getIssue, listAgentRuns, resolvePendingDecision) to act on the user's board, and the standard workspace tools (Bash, Read, Edit, Glob, Grep, Write) to inspect and edit code.

When the user asks about "the board", "open issues", "recent runs", or similar, prefer the kanban tools over reading the database directly.`;

function makeChatPayload(deps: HandlerDeps, conversation: ChatConversation): ChatPayload {
  const messages: Message[] = deps.store.messages.list(conversation.threadId);
  const events: AgentEvent[] = deps.store.events.listByThread(conversation.threadId);
  const cards: Card[] = deps.store.cards.listByThread(conversation.threadId);
  const activeRun = deps.store.agentRuns.findActiveForThread(conversation.threadId);
  const latestRun = activeRun ?? deps.store.agentRuns.findLatestForThread(conversation.threadId);
  const sessions = deps.store.chatSessions
    .listByConversation(conversation.id)
    .map(chatSessionToPayload);
  return {
    conversation,
    messages,
    events,
    cards,
    activeRun,
    latestRun,
    sessions,
  };
}

export async function list(deps: HandlerDeps): Promise<ChatConversation[]> {
  return deps.store.chatConversations.list();
}

export async function create(deps: HandlerDeps, args: { title?: string }): Promise<ChatPayload> {
  const parsed = parseArgs(createSchema, args ?? {});
  const conversation = deps.store.chatConversations.create({
    title: parsed.title ?? DEFAULT_TITLE,
  });
  // Bootstrap a default session so the renderer always has at least one
  // entry to display — saves the renderer from having to handle the
  // "empty list" edge case on first paint.
  const defaultProvider = resolveChatProvider(deps, undefined, null);
  deps.store.chatSessions.create({
    conversationId: conversation.id,
    agentProvider: defaultProvider as ProviderId,
  });
  return makeChatPayload(deps, conversation);
}

export async function get(
  deps: HandlerDeps,
  args: { conversationId: number },
): Promise<ChatPayload> {
  const parsed = parseArgs(getSchema, args);
  const conversation = deps.store.chatConversations.findById(parsed.conversationId);
  if (!conversation) {
    throw new Error(`chat conversation ${parsed.conversationId} not found`);
  }
  return makeChatPayload(deps, conversation);
}

export async function rename(
  deps: HandlerDeps,
  args: { conversationId: number; title: string },
): Promise<ChatConversation> {
  const parsed = parseArgs(renameSchema, args);
  return deps.store.chatConversations.rename(parsed.conversationId, parsed.title);
}

export async function deleteConversation(
  deps: HandlerDeps,
  args: { conversationId: number },
): Promise<{ ok: true }> {
  const parsed = parseArgs(deleteSchema, args);
  const conversation = deps.store.chatConversations.findById(parsed.conversationId);
  if (!conversation) return { ok: true };
  // If a run is active on this conversation's thread, stop it first so we
  // don't leave an orphaned claude process behind.
  const active = deps.store.agentRuns.findActiveForThread(conversation.threadId);
  if (active !== null) {
    try {
      await deps.supervisor.stop(active.id);
    } catch {
      // best-effort
    }
  }
  deps.store.chatConversations.delete(parsed.conversationId);
  return { ok: true };
}

export async function postMessage(
  deps: HandlerDeps,
  args: {
    conversationId: number;
    body: string;
    dispatch?: boolean;
    model?: string;
    provider?:
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
    appendSystemPrompt?: string;
    sessionId?: number;
  },
): Promise<ChatPostMessageResult> {
  const parsed = parseArgs(postMessageSchema, args);
  const conversation = deps.store.chatConversations.findById(parsed.conversationId);
  if (!conversation) {
    throw new Error(`chat conversation ${parsed.conversationId} not found`);
  }
  const dispatch = parsed.dispatch ?? true;

  // Provider that will actually be spawned. Resolved up front because we
  // need it both to (a) pick the right session if none was specified
  // (auto-create uses this) and (b) prep the MCP wiring before spawn.
  const initialProvider = resolveChatProvider(deps, parsed.provider, null);
  const session = resolveSessionForPost(
    deps,
    conversation.id,
    parsed.sessionId,
    initialProvider,
    parsed.model,
  );

  // Snapshot the existing message count *before* inserting so we can detect
  // whether this is the first user turn — used below to auto-title an
  // untitled chat from the first prompt. Counted across the conversation
  // (not just the session) so a brand-new fork session doesn't re-trigger
  // auto-title on every first message.
  const priorMessageCount = deps.store.messages.list(conversation.threadId).length;

  const message = deps.store.messages.create({
    threadId: conversation.threadId,
    role: 'user',
    body: parsed.body,
    chatSessionId: session.id,
  });
  deps.store.chatConversations.touch(conversation.id);
  deps.store.chatSessions.touch(session.id);

  if (priorMessageCount === 0 && conversation.title === DEFAULT_TITLE) {
    const derived = deriveChatTitle(parsed.body);
    if (derived !== DEFAULT_TITLE) {
      deps.store.chatConversations.rename(conversation.id, derived);
    }
  }
  // Auto-derive the session title from its first message when the user
  // hasn't set one manually — same logic as the conversation, scoped to
  // the session so each fork picks up its own evocative label.
  const sessionMessageCount = deps.store.messages.listBySession(session.id).length;
  if (sessionMessageCount === 1 && session.title === null) {
    const derived = deriveChatTitle(parsed.body);
    if (derived !== DEFAULT_TITLE) {
      deps.store.chatSessions.rename(session.id, derived);
    }
  }

  let dispatchError: string | null = null;
  let activeRun: AgentRun | null = null;
  let latestRun: AgentRun | null = null;
  if (dispatch) {
    // Active/latest are now scoped to the session so two parallel
    // sessions on the same conversation can run independently.
    const active = deps.store.agentRuns.findActiveForChatSession(session.id);
    const latest = active ?? deps.store.agentRuns.findLatestForChatSession(session.id);
    // If the user explicitly picked a provider that doesn't match the latest
    // run's provider, treat it as a provider switch and start a fresh run
    // instead of silently resuming the old session under the wrong CLI.
    const switchingProvider =
      active === null &&
      parsed.provider !== undefined &&
      latest !== null &&
      latest.provider !== null &&
      latest.provider !== parsed.provider;
    const willResume =
      !switchingProvider &&
      ((active !== null && active.status === 'awaiting_input') ||
        (active === null && latest !== null && latest.sessionId !== null));
    const willStart = active === null && !willResume;
    if (active !== null && !willResume) {
      throw alreadyActive(`agent run #${active.id} is already ${active.status}`, active);
    }
    const appendSystemPrompt =
      parsed.appendSystemPrompt !== undefined
        ? `${SYSTEM_PROMPT_DEFAULT}\n\n${parsed.appendSystemPrompt}`
        : SYSTEM_PROMPT_DEFAULT;
    // Resolve the provider that will actually be spawned *before* preparing
    // the MCP wiring — claude wants `--mcp-config <file>`, codex wants
    // `-c mcp_servers.<name>.*` overrides, and passing the wrong shape
    // crashes the child immediately (codex rejects `--mcp-config` as an
    // unknown flag and exits with code 2). The session's pinned provider
    // wins when the caller didn't pass one explicitly — that's the whole
    // point of letting each session pick its own agent.
    const dispatchProvider = resolveChatProvider(
      deps,
      parsed.provider ?? (session.agentProvider as AgentRunProvider),
      willResume ? latest : null,
    );
    const inheritSessionModel =
      parsed.provider === undefined || parsed.provider === session.agentProvider;
    const dispatchModel =
      parsed.model ?? (inheritSessionModel ? (session.agentModel ?? undefined) : undefined);
    let toolPrep: Awaited<ReturnType<NonNullable<typeof deps.chatTools>['prepareForRun']>> | null =
      null;
    if (deps.chatTools) {
      try {
        toolPrep = await deps.chatTools.prepareForRun({ provider: dispatchProvider });
      } catch {
        toolPrep = null;
      }
    }
    try {
      if (willResume && latest !== null) {
        await deps.supervisor.resumeChat({
          runId: latest.id,
          prompt: parsed.body,
          appendSystemPrompt,
          ...(toolPrep ? { extraArgs: toolPrep.extraArgs, env: toolPrep.env } : {}),
        });
      } else if (willStart) {
        await deps.supervisor.startChat({
          threadId: conversation.threadId,
          chatSessionId: session.id,
          prompt: parsed.body,
          ...(dispatchModel !== undefined ? { model: dispatchModel } : {}),
          provider: dispatchProvider,
          appendSystemPrompt,
          ...(toolPrep ? { extraArgs: toolPrep.extraArgs, env: toolPrep.env } : {}),
        });
      }
    } catch (err) {
      dispatchError = err instanceof Error ? err.message : String(err);
      if (toolPrep) toolPrep.cleanup();
    }
  }

  activeRun = deps.store.agentRuns.findActiveForChatSession(session.id);
  latestRun = activeRun ?? deps.store.agentRuns.findLatestForChatSession(session.id);

  const updated = deps.store.chatConversations.findById(conversation.id) ?? conversation;
  return {
    conversation: updated,
    message,
    activeRun,
    latestRun,
    ...(dispatchError !== null ? { dispatchError } : {}),
  };
}

export async function stopRun(deps: HandlerDeps, args: { runId: number }): Promise<AgentRun> {
  const parsed = parseArgs(stopRunSchema, args);
  return deps.supervisor.stop(parsed.runId);
}

export async function listSessions(
  deps: HandlerDeps,
  args: { conversationId: number },
): Promise<ChatSessionPayload[]> {
  const parsed = parseArgs(sessionsListSchema, args);
  const conversation = deps.store.chatConversations.findById(parsed.conversationId);
  if (!conversation) {
    throw notFound(`chat conversation ${parsed.conversationId} not found`);
  }
  return deps.store.chatSessions
    .listByConversation(parsed.conversationId)
    .map(chatSessionToPayload);
}

export async function createSession(
  deps: HandlerDeps,
  args: {
    conversationId: number;
    agentProvider: ProviderId;
    agentModel?: string;
    title?: string;
  },
): Promise<ChatSessionPayload> {
  const parsed = parseArgs(sessionsCreateSchema, args);
  const conversation = deps.store.chatConversations.findById(parsed.conversationId);
  if (!conversation) {
    throw notFound(`chat conversation ${parsed.conversationId} not found`);
  }
  const session = deps.store.chatSessions.create({
    conversationId: parsed.conversationId,
    agentProvider: parsed.agentProvider,
    ...(parsed.agentModel !== undefined ? { agentModel: parsed.agentModel } : {}),
    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
  });
  return chatSessionToPayload(session);
}

export async function renameSession(
  deps: HandlerDeps,
  args: { id: number; title: string | null },
): Promise<ChatSessionPayload> {
  const parsed = parseArgs(sessionsRenameSchema, args);
  const existing = deps.store.chatSessions.findById(parsed.id);
  if (!existing) throw notFound(`chat session ${parsed.id} not found`);
  return chatSessionToPayload(deps.store.chatSessions.rename(parsed.id, parsed.title));
}

export async function deleteSession(
  deps: HandlerDeps,
  args: { id: number },
): Promise<{ ok: boolean }> {
  const parsed = parseArgs(sessionsDeleteSchema, args);
  const existing = deps.store.chatSessions.findById(parsed.id);
  if (!existing) return { ok: true };
  // Stop any in-flight run on the session before deleting so we don't
  // leave a child process attached to a row that just disappeared.
  const active = deps.store.agentRuns.findActiveForChatSession(parsed.id);
  if (active !== null) {
    try {
      await deps.supervisor.stop(active.id);
    } catch {
      // best-effort — proceed with delete regardless
    }
  }
  deps.store.chatSessions.remove(parsed.id);
  return { ok: true };
}

/**
 * No-op on the server today — the renderer persists the active session
 * id to localStorage keyed by conversation id, so this handler exists
 * mostly as a hook for telemetry and future server-side "last active
 * session" persistence. We validate the ids so callers learn early if
 * they pass a stale session reference.
 */
export async function setActiveSession(
  deps: HandlerDeps,
  args: { conversationId: number; sessionId: number },
): Promise<{ ok: boolean }> {
  const parsed = parseArgs(sessionsSetActiveSchema, args);
  const session = deps.store.chatSessions.findById(parsed.sessionId);
  if (!session || session.conversationId !== parsed.conversationId) {
    throw notFound(
      `chat session ${parsed.sessionId} not found in conversation ${parsed.conversationId}`,
    );
  }
  return { ok: true };
}

// --- Issue-thread variants ------------------------------------------------
//
// Same shape as the conversation-scoped sessions handlers but keyed on
// threads.id (the per-issue thread). The renderer's TaskDetailModal
// dropdown wires through these channels; the standalone chat surface
// continues to use the chat:sessions:* set above. Both sets share the
// same underlying ChatSessionsRepo with mutually-exclusive scope.

export async function listThreadSessions(
  deps: HandlerDeps,
  args: { threadId: number },
): Promise<ChatSessionPayload[]> {
  const parsed = parseArgs(threadSessionsListSchema, args);
  const thread = deps.store.threads.findById(parsed.threadId);
  if (!thread) throw notFound(`thread ${parsed.threadId} not found`);
  return deps.store.chatSessions.listByThread(parsed.threadId).map(chatSessionToPayload);
}

export async function createThreadSession(
  deps: HandlerDeps,
  args: {
    threadId: number;
    agentProvider: ProviderId;
    agentModel?: string;
    title?: string;
  },
): Promise<ChatSessionPayload> {
  const parsed = parseArgs(threadSessionsCreateSchema, args);
  const thread = deps.store.threads.findById(parsed.threadId);
  if (!thread) throw notFound(`thread ${parsed.threadId} not found`);
  const session = deps.store.chatSessions.create({
    threadId: parsed.threadId,
    agentProvider: parsed.agentProvider,
    ...(parsed.agentModel !== undefined ? { agentModel: parsed.agentModel } : {}),
    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
  });
  return chatSessionToPayload(session);
}

export async function renameThreadSession(
  deps: HandlerDeps,
  args: { id: number; title: string | null },
): Promise<ChatSessionPayload> {
  const parsed = parseArgs(sessionsRenameSchema, args);
  const existing = deps.store.chatSessions.findById(parsed.id);
  if (!existing) throw notFound(`chat session ${parsed.id} not found`);
  if (existing.threadId === null) {
    throw notFound(`chat session ${parsed.id} is not an issue-thread session`);
  }
  return chatSessionToPayload(deps.store.chatSessions.rename(parsed.id, parsed.title));
}

export async function deleteThreadSession(
  deps: HandlerDeps,
  args: { id: number },
): Promise<{ ok: boolean }> {
  const parsed = parseArgs(sessionsDeleteSchema, args);
  const existing = deps.store.chatSessions.findById(parsed.id);
  if (!existing) return { ok: true };
  if (existing.threadId === null) {
    throw notFound(`chat session ${parsed.id} is not an issue-thread session`);
  }
  // Stop any in-flight run on the session before deleting so we don't
  // leave a child process attached to a row that just disappeared.
  const active = deps.store.agentRuns.findActiveForChatSession(parsed.id);
  if (active !== null) {
    try {
      await deps.supervisor.stop(active.id);
    } catch {
      // best-effort — proceed with delete regardless
    }
  }
  deps.store.chatSessions.remove(parsed.id);
  return { ok: true };
}
