import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../api.js';
import { SessionDropdown, useActiveSessionId } from '../components/chat/SessionDropdown.js';
import {
  MODEL_OPTIONS,
  PROVIDER_LABELS,
  isAgentRunProvider,
  modelLabel,
} from '../components/forms/ModelPicker.js';
import { useFetch } from '../hooks/useFetch.js';
import { useAgentRunStream } from '../hooks/useAgentRunStream.js';
import { ageString } from '../labels.js';
import { ToolUseCard } from '../components/run/ToolUseCard.js';
import { AgentSpinner } from '../components/run/AgentSpinner.js';
import type {
  AgentEvent,
  AgentRun,
  AgentRunStatus,
  Card,
  ChatConversation,
  ChatSessionPayload,
  DecisionPayload,
  Message,
  ProviderId,
} from '../types.js';

const STATUS_LABEL: Record<AgentRunStatus, string> = {
  starting: 'STARTING',
  running: 'RUNNING',
  awaiting_input: 'AWAITING INPUT',
  complete: 'COMPLETE',
  failed: 'FAILED',
  stopped: 'STOPPED',
};

function parseInitialConversationId(): number | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash.replace(/^#/, '');
  const match = hash.match(/^\/chat\/(\d+)/);
  if (!match || !match[1]) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function setLocationHash(conversationId: number | null): void {
  if (typeof window === 'undefined') return;
  const target = conversationId === null ? '#/chat' : `#/chat/${conversationId}`;
  if (window.location.hash === target) return;
  window.history.replaceState(null, '', target);
}

export function ChatApp() {
  const [conversationId, setConversationId] = useState<number | null>(parseInitialConversationId);
  const [bootstrapping, setBootstrapping] = useState(conversationId === null);
  const [error, setError] = useState<string | null>(null);

  // When the window opens without a specific conversation in the hash, spin
  // up a fresh conversation immediately so the user lands directly on a
  // usable chat. Multi-conversation management is intentionally not in this
  // window — users open more chat windows for parallel chats.
  useEffect(() => {
    if (conversationId !== null) return;
    let cancelled = false;
    setBootstrapping(true);
    api
      .createChat()
      .then((payload) => {
        if (cancelled) return;
        setConversationId(payload.conversation.id);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setBootstrapping(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  useEffect(() => {
    setLocationHash(conversationId);
  }, [conversationId]);

  // The chat window uses native OS chrome (see createChatWindow in
  // desktop/main.ts), so we skip the custom kb-titlebar and the
  // kb-stage/kb-window shadow wrapper — the OS already draws the frame.
  return (
    <div className="kb-chat-window kb-chat-window-native">
      <div className="kb-chat-shell">
        {conversationId !== null ? (
          <ChatRoom conversationId={conversationId} />
        ) : (
          <ChatBootstrap loading={bootstrapping} error={error} />
        )}
      </div>
    </div>
  );
}

function ChatBootstrap({ loading, error }: { loading: boolean; error: string | null }) {
  return (
    <div className="kb-chat-bootstrap">
      {error ? (
        <>
          <div className="kb-chat-bootstrap-title">Couldn't start chat</div>
          <div className="kb-chat-bootstrap-error">{error}</div>
        </>
      ) : (
        <div className="kb-chat-bootstrap-title">
          {loading ? 'Starting a new conversation…' : 'Waiting…'}
        </div>
      )}
    </div>
  );
}

function ChatRoom({ conversationId }: { conversationId: number }) {
  const [conversation, setConversation] = useState<ChatConversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [historyEvents, setHistoryEvents] = useState<AgentEvent[]>([]);
  const [historyCards, setHistoryCards] = useState<Card[]>([]);
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [latestRun, setLatestRun] = useState<AgentRun | null>(null);
  const [sessions, setSessions] = useState<ChatSessionPayload[]>([]);
  const [activeSessionId, setActiveSessionId] = useActiveSessionId(
    `kanbots.chat.${conversationId}.active-session`,
    null,
  );
  const [error, setError] = useState<string | null>(null);
  // Bumped after each send so useAgentRunStream re-subscribes — the server
  // closes the subscription on terminal status, and a chat resume reuses
  // the same run id, so without this bump we'd miss the resumed run's
  // events.
  const [streamGen, setStreamGen] = useState(0);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const payload = await api.getChat(conversationId);
      setConversation(payload.conversation);
      setMessages(payload.messages);
      setHistoryEvents(payload.events);
      setHistoryCards(payload.cards);
      setActiveRun(payload.activeRun);
      setLatestRun(payload.latestRun);
      setSessions(payload.sessions);
      // First load: pin the active session to the most-recent one when no
      // localStorage value carried over. The session list is always sorted
      // last-activity-first so [0] is the right default.
      if (activeSessionId === null && payload.sessions[0]) {
        setActiveSessionId(payload.sessions[0].id);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [conversationId, activeSessionId, setActiveSessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Filter messages to the active session — multi-session chats keep one
  // transcript per session even though they share the underlying thread.
  // Legacy messages predating migration 0027 have chatSessionId=null; we
  // still show them under the default backfill session so users don't
  // lose history.
  const sessionMessages = useMemo<Message[]>(() => {
    if (activeSessionId === null) return messages;
    return messages.filter((m) => m.chatSessionId === activeSessionId || m.chatSessionId === null);
  }, [messages, activeSessionId]);

  // The events stream is per-run, but we want the session's run, not the
  // conversation's most-recent run (which might belong to a sibling
  // session). Find the active/latest run that belongs to this session.
  // Runs without a chatSessionId fall back to the conversation-wide
  // active/latest so legacy threads still render.
  const sessionActiveRun = useMemo<AgentRun | null>(() => {
    if (activeSessionId === null) return activeRun;
    if (activeRun && activeRun.chatSessionId === activeSessionId) return activeRun;
    return null;
  }, [activeRun, activeSessionId]);
  const sessionLatestRun = useMemo<AgentRun | null>(() => {
    if (activeSessionId === null) return latestRun;
    if (latestRun && latestRun.chatSessionId === activeSessionId) return latestRun;
    if (activeRun && activeRun.chatSessionId === activeSessionId) return activeRun;
    return null;
  }, [latestRun, activeRun, activeSessionId]);

  const displayRun = sessionActiveRun ?? sessionLatestRun;
  const stream = useAgentRunStream(displayRun?.id ?? null, streamGen, 'chat');

  // When the active run finishes (status flips to a terminal state) the
  // server-side row updates but our cached `activeRun` doesn't. Refetch
  // the conversation snapshot whenever the stream's status changes.
  const lastSeenStatusRef = useRef<AgentRunStatus | null>(null);
  useEffect(() => {
    if (!stream.status) return;
    if (lastSeenStatusRef.current === stream.status) return;
    lastSeenStatusRef.current = stream.status;
    if (
      stream.status === 'complete' ||
      stream.status === 'failed' ||
      stream.status === 'stopped' ||
      stream.status === 'awaiting_input'
    ) {
      void refresh();
    }
  }, [stream.status, refresh]);

  const isLive =
    sessionActiveRun !== null &&
    displayRun !== null &&
    displayRun.id === sessionActiveRun.id &&
    (stream.status === 'running' ||
      stream.status === 'starting' ||
      stream.status === 'awaiting_input');

  // Merge persisted history with the live stream, deduped by id. The live
  // stream is authoritative if both sides have an entry (it carries the
  // freshest payload for an in-flight tool call).
  const mergedEvents = useMemo(() => {
    const byId = new Map<number, AgentEvent>();
    for (const e of historyEvents) byId.set(e.id, e);
    for (const e of stream.events) byId.set(e.id, e);
    return Array.from(byId.values());
  }, [historyEvents, stream.events]);

  const mergedCards = useMemo(() => {
    const byId = new Map<number, Card>();
    for (const c of historyCards) byId.set(c.id, c);
    for (const c of stream.cards) byId.set(c.id, c);
    return Array.from(byId.values());
  }, [historyCards, stream.cards]);

  const cardsByMessageId = useMemo(() => {
    const map = new Map<number, Card[]>();
    for (const c of mergedCards) {
      const arr = map.get(c.messageId) ?? [];
      arr.push(c);
      map.set(c.messageId, arr);
    }
    return map;
  }, [mergedCards]);

  const resultByToolUseId = useMemo(() => {
    const idx = new Map<string, AgentEvent>();
    for (const e of mergedEvents) {
      if (e.type !== 'tool_result') continue;
      const id = (e.payload as { toolUseId?: unknown }).toolUseId;
      if (typeof id === 'string') idx.set(id, e);
    }
    return idx;
  }, [mergedEvents]);

  type Item =
    | { kind: 'message'; sortKey: string; id: string; message: Message; cards: Card[] }
    | { kind: 'event'; sortKey: string; id: string; event: AgentEvent };

  // Restrict displayed events to the active session's runs (plus any
  // legacy runs without a chatSessionId so backfilled history still
  // surfaces under the default session).
  const sessionRunIds = useMemo<Set<number>>(() => {
    const ids = new Set<number>();
    if (sessionActiveRun) ids.add(sessionActiveRun.id);
    if (sessionLatestRun) ids.add(sessionLatestRun.id);
    return ids;
  }, [sessionActiveRun, sessionLatestRun]);

  const items: Item[] = useMemo(() => {
    const all: Item[] = [];
    for (const m of sessionMessages) {
      all.push({
        kind: 'message',
        sortKey: m.createdAt,
        id: `m${m.id}`,
        message: m,
        cards: cardsByMessageId.get(m.id) ?? [],
      });
    }
    for (const e of mergedEvents) {
      if (e.type === 'tool_result') continue;
      // Skip empty / sentinel text events. The agent occasionally emits
      // whitespace-only chunks between tool calls, and the supervisor may
      // persist a sibling-briefing system message — neither is meaningful
      // to the user but each renders as a short empty bubble that looks
      // like a broken horizontal stripe in the transcript.
      if (e.type === 'text') {
        const text = (e.payload as { text?: string }).text ?? '';
        if (text.trim().length === 0) continue;
        if (text.trimStart().startsWith('[kanbots:sibling-briefing]')) continue;
      }
      // Scope events to the active session's runs. Events from other
      // sessions live in the same persisted blob (we fetch by thread)
      // but logically belong to their own transcript.
      if (sessionRunIds.size > 0 && !sessionRunIds.has(e.agentRunId)) continue;
      all.push({ kind: 'event', sortKey: e.createdAt, id: `e${e.id}`, event: e });
    }
    all.sort((a, b) => {
      if (a.sortKey === b.sortKey) return a.id.localeCompare(b.id);
      return a.sortKey < b.sortKey ? -1 : 1;
    });
    return all;
  }, [sessionMessages, mergedEvents, cardsByMessageId, sessionRunIds]);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef(true);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = (): void => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickyRef.current = distance <= 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (!stickyRef.current) return;
    const el = scrollerRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [items.length, isLive]);

  const status = stream.status ?? displayRun?.status ?? null;
  const statusClass = status ? `kb-chat-status s-${status}` : 'kb-chat-status';
  const runFailure = status === 'failed' ? (displayRun?.exitReason ?? null) : null;
  const roomError = error ?? stream.error ?? runFailure;

  return (
    <div className="kb-chat-room">
      <header className="kb-chat-header">
        <div className="kb-chat-header-main">
          <ChatTitleEditor
            conversation={conversation}
            onRenamed={(updated) => setConversation(updated)}
          />
          {displayRun ? (
            <span className={statusClass}>
              <span className="kb-chat-status-dot" />
              run #{displayRun.id} · {STATUS_LABEL[stream.status ?? displayRun.status]}
            </span>
          ) : (
            <span className="kb-chat-status">
              <span className="kb-chat-status-dot idle" />
              ready
            </span>
          )}
        </div>
        {sessionActiveRun &&
        (stream.status === 'running' ||
          stream.status === 'starting' ||
          stream.status === 'awaiting_input') ? (
          <button
            type="button"
            className="kb-btn ghost"
            onClick={() => {
              void api.stopChatRun(sessionActiveRun.id).then(() => refresh());
            }}
          >
            Stop
          </button>
        ) : null}
      </header>

      <div ref={scrollerRef} className="kb-chat-scroller">
        {items.length === 0 && !isLive ? (
          <div className="kb-chat-empty">
            <div className="kb-chat-empty-emoji">💬</div>
            <div className="kb-chat-empty-title">Start the conversation</div>
            <div className="kb-chat-empty-sub">
              Ask the kanbots agent anything about your board or codebase.
            </div>
          </div>
        ) : null}
        {items.map((it) =>
          it.kind === 'message' ? (
            <MessageRow
              key={it.id}
              message={it.message}
              cards={it.cards}
              onResolved={() => void refresh()}
            />
          ) : it.event.type === 'tool_use' ? (
            <div key={it.id} className="kb-chat-toolwrap">
              <span className="kb-chat-toolwrap-rail" aria-hidden />
              <div className="kb-chat-toolwrap-body">
                <ToolUseCard
                  toolUse={it.event}
                  result={resultByToolUseId.get(toolUseIdOf(it.event)) ?? null}
                  isLive={isLive}
                />
              </div>
            </div>
          ) : (
            <EventRow key={it.id} event={it.event} />
          ),
        )}
        {isLive && displayRun ? (
          <AgentSpinner
            seed={displayRun.id}
            startedAt={displayRun.startedAt}
            tokensOut={displayRun.tokenUsageOutput ?? null}
          />
        ) : null}
      </div>

      <ReplyFooter
        conversationId={conversationId}
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSessionsChange={setSessions}
        onActiveSessionChange={setActiveSessionId}
        disabled={
          sessionActiveRun !== null && (stream.status === 'running' || stream.status === 'starting')
        }
        onSent={() => {
          setStreamGen((g) => g + 1);
          void refresh();
        }}
      />
      {roomError ? <div className="kb-chat-error">{roomError}</div> : null}
    </div>
  );
}

function ChatTitleEditor({
  conversation,
  onRenamed,
}: {
  conversation: ChatConversation | null;
  onRenamed: (next: ChatConversation) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function startEdit(): void {
    if (!conversation) return;
    setDraft(conversation.title);
    setEditing(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }

  async function commit(): Promise<void> {
    if (!conversation) return;
    const trimmed = draft.trim();
    if (trimmed.length === 0 || trimmed === conversation.title) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const updated = await api.renameChat(conversation.id, trimmed);
      onRenamed(updated);
    } catch {
      // best-effort: silently ignore; the existing title stays.
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }

  if (!conversation) {
    return <h2 className="kb-chat-title">…</h2>;
  }
  if (editing) {
    return (
      <input
        ref={inputRef}
        className="kb-chat-title-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setEditing(false);
          }
        }}
        disabled={saving}
        maxLength={200}
      />
    );
  }
  return (
    <button
      type="button"
      className="kb-chat-title kb-chat-title-btn"
      title="Click to rename"
      onClick={startEdit}
    >
      {conversation.title}
      <span className="kb-chat-title-pencil" aria-hidden>
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" />
        </svg>
      </span>
    </button>
  );
}

function ReplyFooter({
  conversationId,
  sessions,
  activeSessionId,
  onSessionsChange,
  onActiveSessionChange,
  disabled,
  onSent,
}: {
  conversationId: number;
  sessions: ChatSessionPayload[];
  activeSessionId: number | null;
  onSessionsChange: (next: ChatSessionPayload[]) => void;
  onActiveSessionChange: (next: number) => void;
  disabled: boolean;
  onSent: () => void;
}) {
  const [body, setBody] = useState('');
  const [providerOverride, setProviderOverride] = useState<ProviderId | null>(null);
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const [appendSystemPrompt, setAppendSystemPrompt] = useState<string>('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: providers } = useFetch('providers', () => api.getProviders());

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? sessions[0] ?? null,
    [sessions, activeSessionId],
  );
  const enabledAgentProviders = useMemo(
    () =>
      providers?.providers.filter(
        (provider) => provider.enabled && provider.hasKey && isAgentRunProvider(provider.id),
      ) ?? [],
    [providers],
  );
  const effectiveProvider =
    providerOverride ?? activeSession?.agentProvider ?? enabledAgentProviders[0]?.id ?? null;
  const modelOptions = effectiveProvider !== null ? (MODEL_OPTIONS[effectiveProvider] ?? []) : [];
  const selectableModelOptions = modelOptions.filter((model) => model.id !== 'default');

  useEffect(() => {
    setProviderOverride(null);
    setModelOverride(null);
  }, [activeSessionId]);

  useEffect(() => {
    if (modelOverride !== null && !modelOptions.some((option) => option.id === modelOverride)) {
      setModelOverride(null);
    }
  }, [modelOptions, modelOverride]);

  async function send(): Promise<void> {
    const trimmed = body.trim();
    if (!trimmed || sending || disabled) return;
    setSending(true);
    setError(null);
    try {
      const opts: Parameters<typeof api.postChatMessage>[2] = {};
      if (providerOverride !== null) {
        opts.provider = providerOverride;
        opts.model = modelOverride ?? 'default';
      } else if (modelOverride !== null) {
        opts.model = modelOverride;
      }
      if (appendSystemPrompt.trim().length > 0) {
        opts.appendSystemPrompt = appendSystemPrompt.trim();
      }
      if (activeSessionId !== null) opts.sessionId = activeSessionId;
      const result = await api.postChatMessage(conversationId, trimmed, opts);
      setBody('');
      if (result.dispatchError) {
        setError(result.dispatchError);
      }
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="kb-chat-foot">
      <div className="kb-chat-foot-session">
        <SessionDropdown
          sessions={sessions}
          activeSessionId={activeSessionId}
          onActiveSessionChange={onActiveSessionChange}
          onSessionsChange={onSessionsChange}
          onCreateSession={(input) => {
            const args: Parameters<typeof api.createChatSession>[0] = {
              conversationId,
              agentProvider: input.provider,
            };
            if (input.model !== null) args.agentModel = input.model;
            if (input.title !== null && input.title.length > 0) {
              args.title = input.title;
            }
            return api.createChatSession(args);
          }}
          onRenameSession={(id, title) => api.renameChatSession(id, title)}
          onDeleteSession={async (id) => {
            await api.deleteChatSession(id);
          }}
        />
      </div>
      {showAdvanced ? (
        <div className="kb-chat-foot-advanced" style={{ flexWrap: 'wrap' }}>
          <label className="kb-chat-foot-field">
            <span className="kb-chat-foot-field-label">Provider override</span>
            <select
              value={providerOverride ?? ''}
              onChange={(e) => {
                const next = e.target.value as ProviderId | '';
                setProviderOverride(next === '' ? null : next);
                setModelOverride(null);
              }}
              className="kb-chat-model-picker"
            >
              <option value="">
                {activeSession
                  ? `Session agent (${PROVIDER_LABELS[activeSession.agentProvider]})`
                  : 'Session agent'}
              </option>
              {enabledAgentProviders.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {PROVIDER_LABELS[provider.id]}
                </option>
              ))}
            </select>
          </label>
          <label className="kb-chat-foot-field">
            <span className="kb-chat-foot-field-label">Model override</span>
            <select
              value={modelOverride ?? ''}
              onChange={(e) => setModelOverride(e.target.value || null)}
              disabled={effectiveProvider === null || selectableModelOptions.length === 0}
              className="kb-chat-model-picker"
            >
              <option value="">
                {providerOverride !== null
                  ? 'Provider default'
                  : activeSession?.agentModel
                    ? `Session model (${modelLabel(activeSession.agentProvider, activeSession.agentModel)})`
                    : 'Default model'}
              </option>
              {selectableModelOptions.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>
          <label className="kb-chat-foot-field kb-chat-foot-field-grow">
            <span className="kb-chat-foot-field-label">Append system prompt</span>
            <textarea
              placeholder="optional — appended after the chat-mode prompt"
              value={appendSystemPrompt}
              onChange={(e) => setAppendSystemPrompt(e.target.value)}
              rows={2}
              className="kb-chat-foot-syspr"
            />
          </label>
        </div>
      ) : null}
      <div className="kb-chat-foot-row">
        <textarea
          className="kb-chat-foot-input"
          placeholder={disabled ? 'agent is running…' : 'Ask the agent…'}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKey}
          disabled={sending}
          rows={3}
        />
        <button
          type="button"
          className="kb-btn primary kb-chat-send-btn"
          onClick={() => void send()}
          disabled={!body.trim() || sending || disabled}
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
      <div className="kb-chat-foot-bottom">
        <button
          type="button"
          className="kb-chat-foot-opts-toggle"
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
        >
          <span className={`kb-chat-foot-opts-chev${showAdvanced ? ' open' : ''}`}>›</span>
          {showAdvanced ? 'Hide options' : 'Options'}
        </button>
        <span className="kb-chat-foot-hint">⌘↵ to send</span>
      </div>
      {error ? <div className="kb-chat-foot-error">{error}</div> : null}
    </div>
  );
}

function MessageRow({
  message,
  cards,
  onResolved,
}: {
  message: Message;
  cards: Card[];
  onResolved: () => void;
}) {
  if (message.role === 'system') {
    return (
      <div className="kb-chat-sysmsg">
        — {message.body} · {ageString(message.createdAt)} ago —
        {cards.map((c) =>
          c.type === 'decision' ? (
            <DecisionInline key={c.id} card={c as Card<DecisionPayload>} onResolved={onResolved} />
          ) : null,
        )}
      </div>
    );
  }
  const isUser = message.role === 'user';
  const label = isUser ? 'you' : 'claude';
  return (
    <div className={`kb-chat-msg ${isUser ? 'kb-chat-msg-user' : 'kb-chat-msg-agent'}`}>
      <div className="kb-chat-msg-meta">
        <b className="kb-chat-msg-author">{label}</b>
        <span className="kb-chat-msg-time"> · {ageString(message.createdAt)} ago</span>
      </div>
      <div className="kb-chat-msg-body">{message.body}</div>
      {cards.map((c) =>
        c.type === 'decision' ? (
          <DecisionInline key={c.id} card={c as Card<DecisionPayload>} onResolved={onResolved} />
        ) : null,
      )}
    </div>
  );
}

function DecisionInline({
  card,
  onResolved,
}: {
  card: Card<DecisionPayload>;
  onResolved: () => void;
}) {
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isPending = card.status === 'pending';
  const isResolved = card.status === 'resolved';
  const isDismissed = card.status === 'dismissed';

  async function pick(value: string): Promise<void> {
    if (!isPending || submitting !== null) return;
    setSubmitting(value);
    setError(null);
    try {
      await api.resolveCard(card.id, value);
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(null);
    }
  }

  async function dismiss(): Promise<void> {
    if (!isPending || submitting !== null) return;
    setSubmitting('__dismiss');
    setError(null);
    try {
      await api.dismissCard(card.id);
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(null);
    }
  }

  return (
    <div
      className="kb-decision"
      role="region"
      aria-label="Agent question"
      style={{ marginTop: 10 }}
    >
      <div className="kb-decision-opts">
        {card.payload.options.map((opt, i) => (
          <button
            key={opt.value}
            type="button"
            className={`kb-decision-opt${submitting === opt.value ? ' chosen' : ''}`}
            disabled={!isPending || submitting !== null}
            onClick={() => void pick(opt.value)}
          >
            <span className="num">{i + 1}</span>
            {opt.label}
          </button>
        ))}
        {isPending ? (
          <button
            key="__dismiss"
            type="button"
            className="kb-decision-opt dismiss"
            disabled={submitting !== null}
            onClick={() => void dismiss()}
            title="Dismiss this decision and stop the run"
          >
            Dismiss
          </button>
        ) : null}
      </div>
      {isResolved ? <div className="kb-decision-resolved-note">resolved</div> : null}
      {isDismissed ? <div className="kb-decision-resolved-note">dismissed</div> : null}
      {error ? <div className="kb-decision-resolved-note">error: {error}</div> : null}
    </div>
  );
}

function EventRow({ event }: { event: AgentEvent }) {
  if (event.type === 'text') {
    const text = (event.payload as { text?: string }).text ?? '';
    return (
      <div className="kb-chat-msg kb-chat-msg-agent">
        <div className="kb-chat-msg-meta">
          <b className="kb-chat-msg-author">claude</b>
          <span className="kb-chat-msg-time"> · {ageString(event.createdAt)} ago</span>
        </div>
        <div className="kb-chat-msg-body">{text}</div>
      </div>
    );
  }
  if (event.type === 'error') {
    const p = event.payload as { message?: string };
    return (
      <div className="kb-tcall" style={{ borderColor: 'var(--failed)' }}>
        <div className="kb-tcall-head">
          <span className="name" style={{ color: 'var(--failed)' }}>
            error
          </span>
          <span className="arg">{p.message ?? 'unknown'}</span>
          <span className="dur">{ageString(event.createdAt)} ago</span>
        </div>
      </div>
    );
  }
  return null;
}

function toolUseIdOf(ev: AgentEvent): string {
  const id = (ev.payload as { toolUseId?: unknown }).toolUseId;
  return typeof id === 'string' ? id : `seq:${ev.seq}`;
}
