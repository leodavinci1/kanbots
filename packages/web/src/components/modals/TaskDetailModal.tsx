import { Logo } from '../Logo.js';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from 'react';
import { api } from '../../api.js';
import {
  SessionDropdown,
  useActiveSessionId,
} from '../chat/SessionDropdown.js';
import { useFetch } from '../../hooks/useFetch.js';
import { useFocusedRepo } from '../../hooks/useFocusedRepo.js';
import {
  useIssues,
  dispatchIssuesRefetch,
  ISSUES_CHANGED_CHANNEL,
} from '../../hooks/useIssues.js';
import { useIssueRunStream } from '../../hooks/useIssueRunStream.js';
import {
  ageString,
  areaLabels,
  colorForLogin,
  linkedIssueNumbers,
  priorityFromLabels,
  tagFromLabels,
  withStatus,
} from '../../labels.js';
import { AgentSpinner } from '../run/AgentSpinner.js';
import { PreviewPanel, type PreviewInspectSelection } from '../run/PreviewPanel.js';
import { RunSummary } from '../run/RunSummary.js';
import { ToolUseCard } from '../run/ToolUseCard.js';
import { CreatePrModal } from './CreatePrModal.js';
import type {
  AgentEvent,
  AgentRun,
  AgentRunStatus,
  AutopilotChildEntry,
  AutopilotPlanningSlot,
  AutopilotSession,
  Card,
  ChatSessionPayload,
  DecisionPayload,
  DiffFile,
  DiffPayload,
  IssueDetail as IssueDetailPayload,
  IssueRelationPayload,
  Message,
  PrCommentPayload,
  PrCommentsListResult,
  ProviderId,
  ReviewCommentPayload,
  SentrySuggestion,
  SlashCommandPayload,
  StatusKey,
} from '../../types.js';

const TAB_LABELS: Record<DetailTab, string> = {
  autopilot: 'Autopilot',
  overview: 'Overview',
  thread: 'Thread',
  diff: 'Diff',
  preview: 'Preview',
  runs: 'Runs',
};
type DetailTab = 'autopilot' | 'overview' | 'thread' | 'diff' | 'preview' | 'runs';

const STATUS_LABEL: Record<AgentRunStatus, string> = {
  starting: 'STARTING',
  running: 'RUNNING',
  awaiting_input: 'AWAITING INPUT',
  complete: 'COMPLETE',
  failed: 'FAILED',
  stopped: 'STOPPED',
};

function fmtElapsed(startIso: string, endIso?: string | null): string {
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return '—';
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const sec = Math.max(0, Math.floor((end - start) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export interface TaskDetailModalProps {
  issueNumber: number;
  onClose: () => void;
  /** Optional. When supplied, the modal calls this to navigate to a
   *  related issue (parent or sub-issue) instead of opening a second
   *  modal layer. The host (App.tsx) sets the open-detail state with
   *  the target number — the same handler the board uses. */
  onOpenDetail?: (issueNumber: number) => void;
}

export function TaskDetailModal({ issueNumber, onClose, onOpenDetail }: TaskDetailModalProps) {
  const { data, loading, error, refetch } = useFetch<IssueDetailPayload>(
    `issue:${issueNumber}`,
    () => api.issue(issueNumber),
  );
  const isAutopilot = (data?.issue?.labels ?? []).includes('type:autopilot');
  const isArchived = (data?.issue?.labels ?? []).includes('archived');
  const [tab, setTab] = useState<DetailTab>(isAutopilot ? 'autopilot' : 'overview');
  useEffect(() => {
    if (isAutopilot && tab !== 'autopilot' && tab !== 'thread') {
      // Default an autopilot card to its dedicated tab on load.
      setTab('autopilot');
    }
    // Only run on mount and when isAutopilot flips true; honour user's later picks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAutopilot]);

  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Refetch this issue's detail whenever the main process signals a change.
  // Debounced so a burst of run-status flips collapses to one fetch.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.kanbots : undefined;
    if (!bridge) return;
    const unsubscribe = bridge.subscribe(ISSUES_CHANGED_CHANNEL, () => {
      if (debounceRef.current !== null) return;
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void refetch();
      }, 80);
    });
    return () => {
      unsubscribe();
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [refetch]);

  function stopInner(e: MouseEvent<HTMLDivElement>): void {
    e.stopPropagation();
  }

  const issue = data?.issue ?? null;
  const activeRun = data?.thread?.activeRun ?? null;
  const latestRun = data?.thread?.latestRun ?? null;
  const displayRun = activeRun ?? latestRun;
  const messages = data?.thread?.messages ?? [];
  const isRunning =
    activeRun?.status === 'running' ||
    activeRun?.status === 'awaiting_input' ||
    activeRun?.status === 'starting';

  const visibleTabs: DetailTab[] = isAutopilot
    ? ['autopilot', 'overview']
    : ['overview', 'thread', 'diff', 'preview', 'runs'];

  return (
    <div className="kb-modal-scrim kb-app" onClick={onClose} role="dialog" aria-modal="true">
      <div className="kb-modal" onClick={stopInner}>
        <div className="kb-modal-head">
          <Logo size={11} withWordmark />
          <span style={{ color: 'var(--ink-4)' }}>·</span>
          <span className="num">#{issueNumber}</span>
          <h2>{issue?.title ?? (loading ? 'Loading…' : 'Issue')}</h2>
          <span className="grow" />
          {isAutopilot && !isArchived ? (
            <AutopilotStopButton issueNumber={issueNumber} onAfter={() => void refetch()} />
          ) : null}
          {!isAutopilot && activeRun && isRunning ? (
            <button
              type="button"
              className="kb-btn ghost"
              onClick={() => void api.stopAgent(activeRun.id).then(() => refetch())}
            >
              Stop
            </button>
          ) : null}
          {!isAutopilot ? (
            <button type="button" className="kb-btn ghost" disabled title="Phase 11">
              Fork run
            </button>
          ) : null}
          {!isAutopilot && displayRun ? (
            <button type="button" className="kb-btn primary" onClick={() => setTab('preview')}>
              Open preview ↗
            </button>
          ) : null}
          {isArchived ? (
            <button
              type="button"
              className="kb-btn ghost"
              onClick={() => {
                void api.unarchiveIssue(issueNumber).then(() => {
                  dispatchIssuesRefetch();
                  onClose();
                });
              }}
              title="Restore this task to the board"
            >
              Unarchive
            </button>
          ) : (
            <button
              type="button"
              className="kb-btn ghost"
              onClick={() => {
                const msg = isAutopilot
                  ? 'Archive this autopilot task? Its session will be stopped. Child tasks remain.'
                  : isRunning
                    ? 'Archive this ticket? Its running agent will be stopped.'
                    : 'Archive this ticket?';
                if (!window.confirm(msg)) return;
                void api.archiveIssue(issueNumber).then(() => {
                  dispatchIssuesRefetch();
                  onClose();
                });
              }}
            >
              Archive
            </button>
          )}
          <button
            type="button"
            className="x-btn"
            onClick={onClose}
            aria-label="Close (Esc)"
            title="Close"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </button>
        </div>

        <div className="kb-modal-body">
          <main className="kb-modal-main">
            {issue ? (
              <>
                <div className={`kb-tdm-hero${isRunning ? ' running' : ''}`}>
                  <ParentBreadcrumb
                    childNumber={issue.number}
                    {...(onOpenDetail ? { onOpenDetail } : {})}
                  />
                  <div className="kb-tdm-title-row">
                    <span className="kb-tdm-num">#{issue.number}</span>
                    <h1 className="kb-tdm-h1">{issue.title}</h1>
                  </div>
                  <div className="kb-tdm-meta-row">
                    {activeRun ? (
                      <span
                        className={`kb-status-pill kb-state-${
                          activeRun.status === 'awaiting_input'
                            ? 'awaiting'
                            : activeRun.status === 'running'
                              ? 'running'
                              : activeRun.status === 'failed'
                                ? 'failed'
                                : ''
                        }`}
                      >
                        <span className="kb-pulse" />
                        {STATUS_LABEL[activeRun.status]} · run #{activeRun.id}
                      </span>
                    ) : null}
                    {tagFromLabels(issue.labels, issue.isPullRequest) ? (
                      <span
                        className={`kb-tag kb-tag-${tagFromLabels(issue.labels, issue.isPullRequest)}`}
                      >
                        {tagFromLabels(issue.labels, issue.isPullRequest)}
                      </span>
                    ) : null}
                    {areaLabels(issue.labels).map((l) => (
                      <span key={l} className="kb-chip mono">
                        {l}
                      </span>
                    ))}
                    {priorityFromLabels(issue.labels) ? (
                      <span className="kb-chip mono">
                        priority:{priorityFromLabels(issue.labels)}
                      </span>
                    ) : null}
                    {displayRun?.branchName ? (
                      <span className="kb-chip mono">
                        <span className="k">branch</span>
                        {displayRun.branchName}
                      </span>
                    ) : null}
                    <span className="kb-chip mono">
                      <span className="k">opened</span>
                      {ageString(issue.createdAt)} ago
                    </span>
                  </div>
                </div>

                <div className="kb-tdm-tabs">
                  {visibleTabs.map((t) => (
                    <button
                      key={t}
                      type="button"
                      className={`kb-tdm-tab${tab === t ? ' active' : ''}`}
                      onClick={() => setTab(t)}
                    >
                      {TAB_LABELS[t]}
                    </button>
                  ))}
                </div>

                <div className="kb-tdm-content">
                  {tab === 'autopilot' ? (
                    <AutopilotTab issueNumber={issue.number} />
                  ) : null}
                  {tab === 'overview' ? (
                    <OverviewTab
                      issue={issue}
                      displayRun={displayRun}
                      cloudRunId={issue.cloudLatestRunId ?? issue.activeRun?.cloudRunId ?? null}
                      {...(onOpenDetail ? { onOpenDetail } : {})}
                    />
                  ) : null}
                  {tab === 'thread' && !isAutopilot ? (
                    <ThreadTab
                      activeRun={activeRun}
                      displayRun={displayRun}
                      cloudRunId={issue.cloudLatestRunId ?? issue.activeRun?.cloudRunId ?? null}
                      messages={messages}
                      issueNumber={issueNumber}
                      issueLabels={issue.labels}
                      issueStatus={issue.status}
                      onActionDone={() => void refetch()}
                    />
                  ) : null}
                  {tab === 'diff' && !isAutopilot ? <DiffTabModal activeRun={displayRun} /> : null}
                  {tab === 'preview' && !isAutopilot ? <PreviewTabModal activeRun={displayRun} /> : null}
                  {tab === 'runs' && !isAutopilot ? <RunsTab issueNumber={issue.number} /> : null}
                </div>
              </>
            ) : error ? (
              <div className="kb-tdm-content" style={{ color: 'var(--failed)' }}>
                {error.message}
              </div>
            ) : (
              <div className="kb-tdm-content">Loading…</div>
            )}
          </main>

          <aside className="kb-modal-aside">
            {issue ? (
              <Aside
                issue={issue}
                activeRun={activeRun}
                latestRun={latestRun}
              />
            ) : null}
          </aside>
        </div>

        <div className="kb-modal-foot">
          <span className="hint">Reply to agent</span>
          <ReplyFooter
            issueNumber={issueNumber}
            threadId={data?.thread?.id ?? null}
            activeRun={activeRun}
            onSent={() => void refetch()}
          />
        </div>
      </div>
    </div>
  );
}

function ReplyFooter({
  issueNumber,
  threadId,
  activeRun,
  onSent,
}: {
  issueNumber: number;
  /** Issue's persisted thread id. NULL before the first reply is sent
   *  (no thread row exists yet) — in that case we hide the session
   *  dropdown and the first send lands without a chat-session tag,
   *  matching the pre-multi-session behaviour. */
  threadId: number | null;
  activeRun: AgentRun | null;
  onSent: () => void;
}) {
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingComments, setPendingComments] = useState<ReviewCommentPayload[]>([]);
  const [allCommands, setAllCommands] = useState<SlashCommandPayload[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [sessions, setSessions] = useState<ChatSessionPayload[]>([]);
  // Persist the active session per-issue so re-opening the modal lands
  // the composer back on the same session the user last picked. Scoped
  // on `issueNumber` (cheap and human-readable) rather than threadId
  // because the latter is only populated after the first reply.
  const [activeSessionId, setActiveSessionId] = useActiveSessionId(
    `kanbots.issue.${issueNumber}.active-session`,
    null,
  );

  // Load the thread's sessions whenever the thread id appears or the
  // active run id flips (a new run might mean a new session was
  // bootstrapped by the post-message path). Also auto-bootstrap a
  // single default session the first time we land on a thread that has
  // never had one — saves the user from having to click "+ New" before
  // their first reply.
  const threadIdRef = useRef<number | null>(threadId);
  threadIdRef.current = threadId;
  useEffect(() => {
    if (threadId === null) {
      setSessions([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.listThreadChatSessions(threadId);
        if (cancelled) return;
        if (list.length === 0) {
          // Bootstrap a default session pinned to the active run's
          // provider when one is in flight (so resuming an existing run
          // through the dropdown picks the right CLI), otherwise fall
          // back to claude-code as the safe default.
          const fallbackProvider: ProviderId =
            activeRun?.provider === 'claude-code' ||
            activeRun?.provider === 'codex-cli' ||
            activeRun?.provider === 'gemini-cli' ||
            activeRun?.provider === 'amp-cli' ||
            activeRun?.provider === 'cursor-cli' ||
            activeRun?.provider === 'copilot-cli' ||
            activeRun?.provider === 'opencode-cli' ||
            activeRun?.provider === 'droid-cli' ||
            activeRun?.provider === 'ccr-cli' ||
            activeRun?.provider === 'qwen-cli' ||
            activeRun?.provider === 'acp'
              ? activeRun.provider
              : 'claude-code';
          try {
            const created = await api.createThreadChatSession({
              threadId,
              agentProvider: fallbackProvider,
            });
            if (cancelled) return;
            setSessions([created]);
            setActiveSessionId(created.id);
          } catch {
            // Best-effort: the dropdown will simply render empty and
            // the next send goes through without a session tag.
          }
        } else {
          setSessions(list);
          if (activeSessionId === null && list[0]) {
            setActiveSessionId(list[0].id);
          }
        }
      } catch {
        if (!cancelled) setSessions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally exclude activeSessionId / setActiveSessionId so we
    // don't re-fetch on every selection — the dropdown drives its own
    // state and the list only needs to refresh when the thread or
    // active run changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, activeRun?.id]);
  const { focusedRepoId } = useFocusedRepo();

  // Pick the provider to query for slash commands. activeRun.provider can be
  // arbitrary strings from older runs, so narrow defensively.
  const provider: ProviderId = useMemo(() => {
    const p = activeRun?.provider;
    if (
      p === 'claude-code' ||
      p === 'codex-cli' ||
      p === 'gemini-cli' ||
      p === 'amp-cli' ||
      p === 'cursor-cli' ||
      p === 'copilot-cli' ||
      p === 'opencode-cli' ||
      p === 'droid-cli' ||
      p === 'ccr-cli' ||
      p === 'qwen-cli' ||
      p === 'acp'
    ) {
      return p;
    }
    return 'claude-code';
  }, [activeRun?.provider]);

  // Discover slash commands for the active provider. Cache-warmed by the
  // backend; cheap to re-fetch on provider switch.
  useEffect(() => {
    let cancelled = false;
    api
      .getSlashCommands(provider)
      .then((cmds) => {
        if (!cancelled) setAllCommands(cmds);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [provider]);

  // Track pending inline review comments on the active run. Comments are
  // added from the diff viewer (a different surface), so poll periodically
  // while the modal is open.
  const activeRunId = activeRun?.id ?? null;
  useEffect(() => {
    if (activeRunId === null) {
      setPendingComments([]);
      return;
    }
    let cancelled = false;
    function refresh(): void {
      api
        .getReviewComments(activeRunId as number)
        .then((cs) => {
          if (!cancelled) setPendingComments(cs);
        })
        .catch(() => undefined);
    }
    refresh();
    const id = window.setInterval(refresh, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [activeRunId]);

  // Listen for prefill requests from the preview inspect flow. The Preview
  // tab dispatches `kanbots:composer:insert` with a formatted markdown block
  // describing the clicked element; we append it to the current draft (with
  // a newline separator if non-empty) and focus the input so the user can
  // immediately add a question.
  useEffect(() => {
    function onInsert(e: Event): void {
      const detail = (e as CustomEvent<{ text?: string }>).detail;
      const text = detail?.text;
      if (!text) return;
      setBody((prev) => (prev.length === 0 ? text : `${prev}\n${text}`));
      // Defer focus so the controlled-input value lands first.
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
    window.addEventListener('kanbots:composer:insert', onInsert);
    return () => window.removeEventListener('kanbots:composer:insert', onInsert);
  }, []);

  // Open the slash-command menu when the input starts with `/` and the
  // first whitespace hasn't appeared yet (i.e. the user is still typing
  // the command name).
  const slashQuery = useMemo<string | null>(() => {
    const m = /^\/(\S*)$/.exec(body);
    return m ? m[1] ?? '' : null;
  }, [body]);
  const slashOpen = slashQuery !== null;

  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  const filteredCommands = useMemo<SlashCommandPayload[]>(() => {
    if (slashQuery === null) return [];
    const q = slashQuery.toLowerCase();
    if (q.length === 0) return allCommands;
    return allCommands.filter((c) => c.name.toLowerCase().includes(q));
  }, [slashQuery, allCommands]);

  function applySlash(cmd: SlashCommandPayload): void {
    setBody(`/${cmd.name} `);
    inputRef.current?.focus();
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>): void {
    if (slashOpen && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const cmd = filteredCommands[slashIndex];
        if (cmd) applySlash(cmd);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const cmd = filteredCommands[slashIndex];
        if (cmd) applySlash(cmd);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setBody('');
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
    }
  }

  async function send(): Promise<void> {
    const trimmed = body.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError(null);
    try {
      // /review is orchestration — spawn reviewer on the last implement
      // branch. Posting it as a normal message creates a fresh main worktree
      // and the Diff tab goes empty.
      const reviewMatch = trimmed.match(/^\/review(?:\s+(.*))?$/is);
      if (reviewMatch) {
        const extra = (reviewMatch[1] ?? '').trim();
        await api.spawnReviewer(issueNumber, {
          ...(focusedRepoId !== null ? { repoId: focusedRepoId } : {}),
          ...(extra.length > 0 ? { prompt: extra } : {}),
        });
        setBody('');
        onSent();
        return;
      }
      let messageBody = trimmed;
      // Consume any pending inline review comments and prepend them as a
      // structured block so the agent sees them as context.
      if (activeRunId !== null && pendingComments.length > 0) {
        const consumed = await api.consumeReviewComments(activeRunId);
        if (consumed.length > 0) {
          const block = consumed
            .map((c) => `- \`${c.filePath}:${c.lineNumber}\` (${c.side}) — ${c.body}`)
            .join('\n');
          messageBody = `Inline review comments:\n${block}\n\n${trimmed}`;
        }
        setPendingComments([]);
      }
      const postOpts: Parameters<typeof api.postMessage>[2] = {};
      if (focusedRepoId !== null) postOpts.repoId = focusedRepoId;
      if (activeSessionId !== null) postOpts.chatSessionId = activeSessionId;
      await api.postMessage(issueNumber, messageBody, postOpts);
      setBody('');
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      {threadId !== null ? (
        <div className="kb-chat-foot-session">
          <SessionDropdown
            sessions={sessions}
            activeSessionId={activeSessionId}
            onActiveSessionChange={setActiveSessionId}
            onSessionsChange={setSessions}
            onCreateSession={(input) => {
              const args: Parameters<typeof api.createThreadChatSession>[0] = {
                threadId,
                agentProvider: input.provider,
              };
              if (input.model !== null) args.agentModel = input.model;
              if (input.title !== null && input.title.length > 0) {
                args.title = input.title;
              }
              return api.createThreadChatSession(args);
            }}
            onRenameSession={(id, title) => api.renameThreadChatSession(id, title)}
            onDeleteSession={async (id) => {
              await api.deleteThreadChatSession(id);
            }}
          />
        </div>
      ) : null}
      <div className="kb-reply-input-wrap">
        {slashOpen && filteredCommands.length > 0 ? (
          <div className="kb-slash-menu" role="listbox" aria-label="Slash commands">
            {filteredCommands.slice(0, 8).map((cmd, i) => (
              <button
                key={`${cmd.source}:${cmd.name}`}
                type="button"
                role="option"
                aria-selected={i === slashIndex}
                className={`kb-slash-item${i === slashIndex ? ' is-active' : ''}`}
                onMouseEnter={() => setSlashIndex(i)}
                onMouseDown={(e) => {
                  // Prevent input blur before click fires.
                  e.preventDefault();
                }}
                onClick={() => applySlash(cmd)}
              >
                <span className="kb-slash-name">/{cmd.name}</span>
                <span className="kb-slash-desc">{cmd.description}</span>
                <span className={`kb-slash-src kb-slash-src-${cmd.source}`}>{cmd.source}</span>
              </button>
            ))}
          </div>
        ) : null}
        <input
          ref={inputRef}
          type="text"
          placeholder="/spec to refine · /review to spawn reviewer · /split to fan out…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKey}
          disabled={sending}
        />
      </div>
      {pendingComments.length > 0 ? (
        <span
          className="kb-reply-badge"
          title={`${pendingComments.length} inline review comment${pendingComments.length === 1 ? '' : 's'} will be sent with your next message`}
        >
          {pendingComments.length} comment{pendingComments.length === 1 ? '' : 's'}
        </span>
      ) : null}
      <button
        type="button"
        className="kb-btn primary"
        onClick={() => void send()}
        disabled={!body.trim() || sending}
      >
        {sending ? 'Sending…' : 'Send'} <span className="kb-kbd">⌘↵</span>
      </button>
      {error ? (
        <span style={{ color: 'var(--failed)', fontSize: 11, marginLeft: 8 }}>{error}</span>
      ) : null}
    </>
  );
}

function Aside({
  issue,
  activeRun,
  latestRun,
}: {
  issue: IssueDetailPayload['issue'];
  activeRun: AgentRun | null;
  latestRun: AgentRun | null;
}) {
  const links = linkedIssueNumbers(issue.labels);
  const sidebarRun = activeRun ?? latestRun;
  const sidebarHeader = activeRun ? 'Live run' : latestRun ? 'Last run' : 'Run';
  return (
    <>
      <div className="kb-mas-block">
        <div className="kb-mas-h">{sidebarHeader}</div>
        {sidebarRun ? (
          <RunSummary run={sidebarRun} layout="aside" />
        ) : (
          <div className="kb-desc-md" style={{ color: 'var(--ink-3)', fontSize: 12 }}>
            No agent runs yet.
          </div>
        )}
      </div>

      <div className="kb-mas-block">
        <div className="kb-mas-h">Properties</div>
        <div className="kb-mas-row">
          <span className="k">Status</span>
          <span className="v">{issue.status ?? 'inbox'}</span>
        </div>
        <div className="kb-mas-row">
          <span className="k">Assignee</span>
          <span className="v">{issue.assignees[0] ?? '—'}</span>
        </div>
        <div className="kb-mas-row">
          <span className="k">Priority</span>
          <span className="v">{priorityFromLabels(issue.labels) ?? '—'}</span>
        </div>
        <div className="kb-mas-row">
          <span className="k">Folder</span>
          <span className="v mono">current</span>
        </div>
        <div className="kb-mas-row">
          <span className="k">Worktree</span>
          <span className="v mono">
            {sidebarRun?.worktreePath ?? '—'}
          </span>
        </div>
        <div className="kb-mas-row">
          <span className="k">Branch</span>
          <span className="v mono">{sidebarRun?.branchName ?? '—'}</span>
        </div>
        <div className="kb-mas-row">
          <span className="k">Base</span>
          <span className="v mono">main</span>
        </div>
      </div>

      {links.length > 0 ? (
        <div className="kb-mas-block">
          <div className="kb-mas-h">Linked</div>
          <LinkedIssues numbers={links} currentNumber={issue.number} />
        </div>
      ) : null}

      <div className="kb-mas-block">
        <div className="kb-mas-h">Author</div>
        <div className="kb-mas-row">
          <span
            className="kb-rail-avatar"
            style={{
              width: 22,
              height: 22,
              fontSize: 10,
              background: colorForLogin(issue.user.login),
            }}
            aria-hidden
          >
            {issue.user.login.slice(0, 1).toUpperCase()}
          </span>
          <span className="v">{issue.user.login}</span>
        </div>
      </div>
    </>
  );
}

function LinkedIssues({
  numbers,
  currentNumber,
}: {
  numbers: number[];
  currentNumber: number;
}) {
  const { issues } = useIssues();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {numbers
        .filter((n) => n !== currentNumber)
        .map((n) => {
          const linked = issues.find((i) => i.number === n);
          return (
            <a
              key={n}
              href={`#/issue/${n}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                padding: '6px 8px',
                borderRadius: 6,
                background: 'var(--bg-2)',
                border: '1px solid var(--hairline-soft)',
                textDecoration: 'none',
                color: 'inherit',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--ff-mono)',
                  fontSize: 11,
                  color: 'var(--ink-3)',
                }}
              >
                #{n}
              </span>
              <span
                style={{
                  flex: 1,
                  color: 'var(--ink-1)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {linked?.title ?? '(not loaded)'}
              </span>
              {linked?.state === 'closed' ? (
                <span style={{ color: 'var(--review)', fontSize: 10 }}>closed</span>
              ) : null}
            </a>
          );
        })}
    </div>
  );
}

/**
 * Renders a compact "Parent: #<n> · <title>" link above the issue title
 * when the current issue has at least one recorded parent. Clicking the
 * link navigates to the parent via `onOpenDetail`. If no parent is
 * recorded (the issue is a root) the component renders nothing.
 */
function ParentBreadcrumb({
  childNumber,
  onOpenDetail,
}: {
  childNumber: number;
  onOpenDetail?: (issueNumber: number) => void;
}) {
  const [parents, setParents] = useState<IssueRelationPayload[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api
      .listIssueParents(childNumber)
      .then((rows) => {
        if (!cancelled) setParents(rows);
      })
      .catch(() => {
        if (!cancelled) setParents([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [childNumber]);

  if (loading || parents.length === 0) return null;

  return (
    <div className="kb-sub-issues-parent">
      {parents.map((p) => (
        <button
          key={p.id}
          type="button"
          className="kb-sub-issues-parent-link"
          onClick={() => onOpenDetail?.(p.child.number)}
          disabled={!onOpenDetail}
          title={`Open parent #${p.child.number}`}
        >
          <span className="kb-sub-issues-parent-label">Parent</span>
          <span className="kb-sub-issues-parent-num">#{p.child.number}</span>
          <span className="kb-sub-issues-parent-title">{p.child.title}</span>
        </button>
      ))}
    </div>
  );
}

function statusBadge(status: StatusKey | null): { label: string; cls: string } {
  // Mirrors the status pill conventions used elsewhere — kept inline to
  // avoid pulling another file in just for the colour map. The labels
  // here are short forms suitable for a tight list row.
  switch (status) {
    case 'backlog':
      return { label: 'backlog', cls: 'kb-sub-issue-status-backlog' };
    case 'todo':
      return { label: 'todo', cls: 'kb-sub-issue-status-todo' };
    case 'inProgress':
      return { label: 'in progress', cls: 'kb-sub-issue-status-running' };
    case 'review':
      return { label: 'review', cls: 'kb-sub-issue-status-review' };
    case 'done':
      return { label: 'done', cls: 'kb-sub-issue-status-done' };
    default:
      return { label: 'inbox', cls: 'kb-sub-issue-status-inbox' };
  }
}

/**
 * Renders the list of child sub-issues for `parentNumber` plus an
 * affordance to link an existing issue as a new sub-issue. Creating a
 * brand-new sub-issue via the create modal is intentionally out of
 * scope here — the user can create the issue first, then link it. That
 * keeps this surface narrow and avoids cross-modal state passing.
 */
function SubIssuesSection({
  parentNumber,
  onOpenDetail,
}: {
  parentNumber: number;
  onOpenDetail?: (issueNumber: number) => void;
}) {
  const [children, setChildren] = useState<IssueRelationPayload[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { issues: allIssues } = useIssues();

  const refresh = useCallback(async () => {
    try {
      const rows = await api.listIssueChildren(parentNumber);
      setChildren(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [parentNumber]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  async function handleRemove(id: number): Promise<void> {
    setError(null);
    try {
      await api.removeIssueRelation(id);
      await refresh();
      // Re-fetch the board so the "↳N" badge stays in sync after an
      // unlink (the count lives on the decorated issue and only
      // refreshes when the issues list refetches).
      dispatchIssuesRefetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleAdd(childNumber: number): Promise<void> {
    setError(null);
    try {
      await api.addIssueRelation({ parentNumber, childNumber });
      setAdding(false);
      await refresh();
      dispatchIssuesRefetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="kb-tdm-section kb-sub-issues">
      <h3>Sub-issues</h3>
      {error ? (
        <div className="kb-sub-issues-error" role="alert">
          {error}
        </div>
      ) : null}
      {loading ? (
        <div className="kb-sub-issues-empty">Loading…</div>
      ) : children.length === 0 && !adding ? (
        <div className="kb-sub-issues-empty">No sub-issues yet.</div>
      ) : (
        <div className="kb-sub-issues-list">
          {children.map((rel) => {
            const badge = statusBadge(rel.child.status);
            return (
              <div key={rel.id} className="kb-sub-issue-row">
                <span className={`kb-sub-issue-pill ${badge.cls}`}>{badge.label}</span>
                <button
                  type="button"
                  className="kb-sub-issue-open"
                  onClick={() => onOpenDetail?.(rel.child.number)}
                  disabled={!onOpenDetail}
                  title={`Open #${rel.child.number}`}
                >
                  <span className="kb-sub-issue-num">#{rel.child.number}</span>
                  <span className="kb-sub-issue-title">{rel.child.title}</span>
                </button>
                {rel.child.state === 'closed' ? (
                  <span className="kb-sub-issue-closed">closed</span>
                ) : null}
                <button
                  type="button"
                  className="kb-sub-issue-unlink"
                  onClick={() => void handleRemove(rel.id)}
                  title="Unlink (the issue is not deleted)"
                  aria-label={`Unlink #${rel.child.number}`}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
      {adding ? (
        <SubIssueAddPicker
          parentNumber={parentNumber}
          existing={new Set(children.map((c) => c.child.number))}
          allIssues={allIssues}
          onPick={(n) => void handleAdd(n)}
          onCancel={() => {
            setAdding(false);
            setError(null);
          }}
        />
      ) : (
        <button
          type="button"
          className="kb-sub-issue-add"
          onClick={() => setAdding(true)}
        >
          + Add sub-issue
        </button>
      )}
    </div>
  );
}

/**
 * Inline picker that lets the user filter the workspace issue list by
 * number/title and pick one to link as a sub-issue. Lives inside the
 * SubIssuesSection so it can share the section's refresh callback and
 * error state without the host modal having to mediate.
 */
function SubIssueAddPicker({
  parentNumber,
  existing,
  allIssues,
  onPick,
  onCancel,
}: {
  parentNumber: number;
  existing: Set<number>;
  allIssues: ReadonlyArray<{
    number: number;
    title: string;
    state: 'open' | 'closed';
  }>;
  onPick: (issueNumber: number) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  // Filter to: non-self, non-already-linked, fuzzy-match against
  // number/title. The list comes from `useIssues()` so it reflects the
  // open board — the user can always cancel and link a closed issue by
  // re-opening it first (linking closed issues is intentionally not a
  // happy path on the board).
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = allIssues.filter((i) => {
      if (i.number === parentNumber) return false;
      if (existing.has(i.number)) return false;
      if (!q) return true;
      const numStr = `#${i.number}`;
      return (
        numStr.includes(q) ||
        i.title.toLowerCase().includes(q) ||
        String(i.number).includes(q)
      );
    });
    return filtered.slice(0, 8);
  }, [allIssues, query, parentNumber, existing]);

  return (
    <div className="kb-sub-issue-picker">
      <div className="kb-sub-issue-picker-row">
        <input
          type="text"
          className="kb-input kb-sub-issue-input"
          placeholder="Search by # or title…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <button type="button" className="kb-btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <div className="kb-sub-issue-matches">
        {matches.length === 0 ? (
          <div className="kb-sub-issues-empty">No matches.</div>
        ) : (
          matches.map((i) => (
            <button
              key={i.number}
              type="button"
              className="kb-sub-issue-match"
              onClick={() => onPick(i.number)}
            >
              <span className="kb-sub-issue-num">#{i.number}</span>
              <span className="kb-sub-issue-title">{i.title}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function OverviewTab({
  issue,
  displayRun,
  cloudRunId,
  onOpenDetail,
}: {
  issue: IssueDetailPayload['issue'];
  displayRun: AgentRun | null;
  cloudRunId: string | null;
  onOpenDetail?: (issueNumber: number) => void;
}) {
  const stream = useIssueRunStream(displayRun, cloudRunId);
  const recentToolCalls = stream.events.filter((e) => e.type === 'tool_use').slice(-4).reverse();
  const resultByToolUseId = buildResultIndex(stream.events);
  const acMatches = (issue.body ?? '').match(/(?:^|\n)\s*AC:\s*\n((?:[-*]\s.+\n?)+)/);
  const acItems = acMatches?.[1]?.match(/(?:^|\n)[-*]\s(.+)/g)?.map((l) => l.replace(/^[\s-*]+/, '')) ?? [];

  return (
    <>
      {issue.sentryMeta ? <SentryAnalysisSection issue={issue} /> : null}

      <div className="kb-tdm-section">
        <h3>Description</h3>
        <div className="kb-desc-md">{issue.body || '(no description)'}</div>
      </div>

      <SubIssuesSection
        parentNumber={issue.number}
        {...(onOpenDetail ? { onOpenDetail } : {})}
      />

      {acItems.length > 0 ? (
        <div className="kb-tdm-section">
          <h3>Spec — extracted from AC: block</h3>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {acItems.map((item, i) => (
              <li key={i} style={{ display: 'flex', gap: 8, padding: '5px 0', fontSize: 12.5, color: 'var(--ink-1)' }}>
                <span
                  style={{
                    width: 13,
                    height: 13,
                    borderRadius: 3,
                    border: '1px solid var(--hairline)',
                    background: 'var(--bg-2)',
                    flexShrink: 0,
                    marginTop: 2,
                  }}
                  aria-hidden
                />
                {item}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {recentToolCalls.length > 0 ? (
        <div className="kb-tdm-section">
          <h3>What the agent did just now</h3>
          {recentToolCalls.map((ev) => (
            <ToolUseCard
              key={ev.id}
              toolUse={ev}
              result={resultByToolUseId.get(toolUseIdOf(ev)) ?? null}
              isLive={false}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

function SentryAnalysisSection({ issue }: { issue: IssueDetailPayload['issue'] }) {
  const meta = issue.sentryMeta;
  const [suggestion, setSuggestion] = useState<SentrySuggestion | null>(meta?.suggestion ?? null);
  const [analyzing, setAnalyzing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!meta) return null;

  async function handleAnalyze(): Promise<void> {
    if (analyzing) return;
    setAnalyzing(true);
    setError(null);
    try {
      const result = await api.analyzeSentryIssue(issue.number);
      setSuggestion(result);
      dispatchIssuesRefetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleApply(): Promise<void> {
    if (applying) return;
    setApplying(true);
    setError(null);
    try {
      await api.applySentrySuggestion(issue.number);
      dispatchIssuesRefetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="kb-tdm-section kb-sentry-section">
      <h3>
        Sentry{' '}
        <span className="kb-sentry-section-status" data-status={meta.status}>
          {meta.status === 'analyzed'
            ? 'analyzed'
            : meta.status === 'applied'
              ? 'applied'
              : meta.status === 'upstream_resolved'
                ? 'upstream resolved'
                : 'unreviewed'}
        </span>
      </h3>
      <div className="kb-sentry-section-meta">
        {meta.errorType ? (
          <code>
            {meta.errorType}: {meta.errorValue ?? ''}
          </code>
        ) : null}
        <div className="kb-sentry-section-row">
          <span>Occurrences: {meta.count}</span>
          {meta.culprit ? <span>Where: {meta.culprit}</span> : null}
          {meta.permalink ? (
            <a href={meta.permalink} target="_blank" rel="noreferrer noopener">
              View in Sentry ↗
            </a>
          ) : null}
        </div>
      </div>

      {error ? <div className="kb-sentry-error">{error}</div> : null}

      {suggestion ? (
        <div className="kb-sentry-suggestion">
          <div className="kb-sentry-suggestion-head">
            <span
              className={`kb-sentry-verdict kb-sentry-verdict-${suggestion.verdict}`}
              title={`Confidence: ${suggestion.confidence} · Category: ${suggestion.category}`}
            >
              {suggestion.verdict === 'task' ? 'Recommend converting to task' : 'Likely skippable'}
            </span>
            <span className="kb-sentry-confidence">
              {suggestion.confidence} confidence · {suggestion.category}
            </span>
          </div>
          <p className="kb-sentry-reasoning">{suggestion.reasoning}</p>
          <div className="kb-sentry-suggestion-fields">
            <div>
              <strong>Suggested title:</strong> {suggestion.suggestedTitle}
            </div>
            <details>
              <summary>Suggested body</summary>
              <pre className="kb-sentry-body-preview">{suggestion.suggestedBody}</pre>
            </details>
          </div>
          <div className="kb-sentry-suggestion-actions">
            <button
              type="button"
              className="kb-btn primary"
              onClick={() => void handleApply()}
              disabled={applying || meta.status === 'applied'}
            >
              {meta.status === 'applied'
                ? 'Applied'
                : applying
                  ? 'Applying…'
                  : 'Convert to task'}
            </button>
            <button
              type="button"
              className="kb-btn ghost"
              onClick={() => void handleAnalyze()}
              disabled={analyzing}
            >
              {analyzing ? 'Re-analyzing…' : 'Re-analyze'}
            </button>
          </div>
        </div>
      ) : (
        <div className="kb-sentry-suggestion-actions">
          <button
            type="button"
            className="kb-btn primary"
            onClick={() => void handleAnalyze()}
            disabled={analyzing}
          >
            {analyzing ? 'Analyzing…' : 'Analyze'}
          </button>
        </div>
      )}
    </div>
  );
}

type TimelineItem =
  | { kind: 'event'; sortKey: string; id: string; event: AgentEvent }
  | { kind: 'message'; sortKey: string; id: string; message: Message; cards: Card[] };

function ThreadTab({
  activeRun,
  displayRun,
  cloudRunId,
  messages,
  issueNumber,
  issueLabels,
  issueStatus,
  onActionDone,
}: {
  activeRun: AgentRun | null;
  displayRun: AgentRun | null;
  cloudRunId: string | null;
  messages: Message[];
  issueNumber: number;
  issueLabels: readonly string[];
  issueStatus: StatusKey | null;
  onActionDone: () => void;
}) {
  const stream = useIssueRunStream(displayRun, cloudRunId);
  const isLive =
    cloudRunId !== null || (activeRun !== null && activeRun.id === displayRun?.id);

  const cardsByMessageId = new Map<number, Card[]>();
  for (const c of stream.cards) {
    const arr = cardsByMessageId.get(c.messageId) ?? [];
    arr.push(c);
    cardsByMessageId.set(c.messageId, arr);
  }

  // Pair every tool_use with its tool_result (matched on toolUseId) so the
  // ToolUseCard can render both halves inside one card.
  const resultByToolUseId = buildResultIndex(stream.events);

  const items: TimelineItem[] = [];
  for (const m of messages) {
    items.push({
      kind: 'message',
      sortKey: m.createdAt,
      id: `m${m.id}`,
      message: m,
      cards: cardsByMessageId.get(m.id) ?? [],
    });
  }
  for (const e of stream.events) {
    // tool_result events are folded into their tool_use parent.
    if (e.type === 'tool_result') continue;
    items.push({ kind: 'event', sortKey: e.createdAt, id: `e${e.id}`, event: e });
  }
  items.sort((a, b) => {
    if (a.sortKey === b.sortKey) return a.id.localeCompare(b.id);
    return a.sortKey < b.sortKey ? -1 : 1;
  });

  // Show the agent spinner whenever the run is still doing work — same
  // status set the header pill considers "active".
  const isRunning =
    displayRun !== null &&
    (displayRun.status === 'running' ||
      displayRun.status === 'starting' ||
      displayRun.status === 'awaiting_input');

  const sectionRef = useRef<HTMLDivElement | null>(null);
  useStickToBottom(sectionRef, [items.length, stream.events.length, isRunning]);

  if (items.length === 0 && !isRunning) {
    return (
      <>
        <div className="kb-tdm-section" ref={sectionRef}>
          <h3>Agent thread</h3>
          <div className="kb-desc-md" style={{ color: 'var(--ink-3)' }}>
            No agent activity yet. Reply below to start the conversation.
          </div>
        </div>
        <PrCommentsSection issueNumber={issueNumber} />
      </>
    );
  }

  return (
    <>
      <div className="kb-tdm-section" ref={sectionRef}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Agent thread</h3>
          {displayRun ? (
            <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
              run #{displayRun.id} · {STATUS_LABEL[displayRun.status]}
              {isLive ? '' : ` · ended ${ageString(displayRun.endedAt ?? displayRun.startedAt)} ago`}
            </span>
          ) : null}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map((it) =>
            it.kind === 'message' ? (
              <MessageRow key={it.id} message={it.message} cards={it.cards} />
            ) : it.event.type === 'tool_use' ? (
              <ToolUseCard
                key={it.id}
                toolUse={it.event}
                result={resultByToolUseId.get(toolUseIdOf(it.event)) ?? null}
                isLive={isLive}
              />
            ) : (
              <EventRow key={it.id} event={it.event} />
            ),
          )}
          {isRunning && displayRun ? (
            <AgentSpinner
              seed={displayRun.id}
              startedAt={displayRun.startedAt}
              tokensOut={displayRun.tokenUsageOutput ?? null}
            />
          ) : null}
          {displayRun && displayRun.status === 'complete' ? (
            <CompletionActions
              runId={displayRun.id}
              issueNumber={issueNumber}
              issueLabels={issueLabels}
              issueStatus={issueStatus}
              onChanged={onActionDone}
            />
          ) : null}
        </div>
      </div>
      <PrCommentsSection issueNumber={issueNumber} />
    </>
  );
}

/**
 * Section appended to the Thread tab that surfaces the comments on the
 * GitHub PR linked to this issue (when one exists). Polls every 30s
 * while the modal is mounted; degrades to a single fetch on mount when
 * the workspace is in local mode or the PR can't be located.
 */
function PrCommentsSection({ issueNumber }: { issueNumber: number }) {
  const [data, setData] = useState<PrCommentsListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [posting, setPosting] = useState(false);

  const refetch = useCallback(async (): Promise<void> => {
    try {
      const next = await api.listPrComments(issueNumber);
      setData(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [issueNumber]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await api.listPrComments(issueNumber);
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    // Poll every 30s while the modal is open. Tolerable for a personal
    // PAT (~120 calls/hr); the conditional fetch (cache-aware Octokit
    // hook already in GitHubClient) makes most polls return 304.
    const interval = window.setInterval(() => {
      void refetch();
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [issueNumber, refetch]);

  const onSubmitReply = useCallback(async (): Promise<void> => {
    const trimmed = replyBody.trim();
    if (trimmed.length === 0 || posting) return;
    setPosting(true);
    setError(null);
    try {
      await api.replyToPrComment(issueNumber, trimmed);
      setReplyBody('');
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPosting(false);
    }
  }, [replyBody, posting, issueNumber, refetch]);

  // Hide the section entirely when the workspace can't surface PR
  // comments (local mode, no linked PR, or initial load hasn't returned
  // yet AND there's nothing to render).
  if (data === null && error === null) return null;
  if (data !== null && data.linkedPullNumber === null) return null;

  const comments = data?.comments ?? [];
  const inlineGroups = groupInlineComments(comments);
  const conversationComments = comments.filter((c) => !c.inline);

  return (
    <div className="kb-pr-comments">
      <div className="kb-pr-comments-head">
        <GitHubGlyph />
        <span>PR review</span>
        {data?.linkedPullNumber !== undefined && data.linkedPullNumber !== null ? (
          <a
            href={data.linkedPullHtmlUrl ?? '#'}
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: 'var(--ink-3)', marginLeft: 4 }}
          >
            #{data.linkedPullNumber}
          </a>
        ) : null}
      </div>
      {error ? (
        <div style={{ color: 'var(--failed)', fontSize: 12, marginBottom: 8 }}>
          {error}
        </div>
      ) : null}
      {comments.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 8 }}>
          No comments on the PR yet.
        </div>
      ) : null}
      {conversationComments.map((c) => (
        <PrCommentRow key={`c${c.id}`} comment={c} />
      ))}
      {inlineGroups.map((group) => (
        <div key={`g:${group.filePath}`}>
          <div className="kb-pr-comment-file">{group.filePath}</div>
          {group.comments.map((c) => (
            <PrCommentRow key={`i${c.id}`} comment={c} />
          ))}
        </div>
      ))}
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <textarea
          value={replyBody}
          onChange={(e) => setReplyBody(e.target.value)}
          placeholder="Reply on the PR…"
          rows={2}
          style={{
            background: 'var(--bg-1)',
            border: '1px solid var(--hairline)',
            borderRadius: 8,
            padding: '6px 9px',
            fontSize: 12.5,
            color: 'var(--ink-1)',
            outline: 'none',
            fontFamily: 'inherit',
            resize: 'vertical',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="kb-btn ghost"
            disabled={posting || replyBody.trim().length === 0}
            onClick={() => void onSubmitReply()}
          >
            {posting ? 'Posting…' : 'Reply on PR'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface InlineCommentGroup {
  filePath: string;
  comments: PrCommentPayload[];
}

function groupInlineComments(
  comments: ReadonlyArray<PrCommentPayload>,
): InlineCommentGroup[] {
  const byFile = new Map<string, PrCommentPayload[]>();
  for (const c of comments) {
    if (!c.inline) continue;
    const path = c.filePath ?? '(unknown)';
    const list = byFile.get(path) ?? [];
    list.push(c);
    byFile.set(path, list);
  }
  return Array.from(byFile.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filePath, list]) => ({ filePath, comments: list }));
}

function PrCommentRow({ comment }: { comment: PrCommentPayload }) {
  const login = comment.author.login;
  const initials = login.slice(0, 2).toUpperCase();
  const tone = colorForLogin(login);
  return (
    <div className="kb-pr-comment">
      {comment.author.avatarUrl ? (
        <img
          className="kb-pr-comment-avatar"
          src={comment.author.avatarUrl}
          alt={login}
        />
      ) : (
        <span
          className="kb-pr-comment-avatar"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: tone,
            color: 'var(--bg-1)',
            fontSize: 10,
            fontWeight: 600,
          }}
        >
          {initials}
        </span>
      )}
      <div>
        <div className="kb-pr-comment-meta">
          <a
            href={comment.htmlUrl}
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: 'var(--ink-1)', fontWeight: 500 }}
          >
            {login}
          </a>
          {' · '}
          {ageString(comment.createdAt)} ago
          {comment.inline && comment.lineNumber !== undefined
            ? ` · line ${comment.lineNumber}`
            : ''}
        </div>
        <div className="kb-pr-comment-body">{comment.body}</div>
      </div>
    </div>
  );
}

function GitHubGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

// Pin the scroll container to the bottom while the user is already at (or
// near) the bottom. If they scroll up, leave them alone until they scroll
// back down within `threshold` px of the bottom.
function useStickToBottom(
  anchorRef: RefObject<HTMLElement | null>,
  deps: ReadonlyArray<unknown>,
  threshold = 80,
): void {
  const pinnedRef = useRef(true);
  const scrollerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const scroller = el.closest('.kb-modal-main') as HTMLElement | null;
    scrollerRef.current = scroller;
    if (!scroller) return;
    const onScroll = (): void => {
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      pinnedRef.current = distance <= threshold;
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [anchorRef, threshold]);

  useEffect(() => {
    if (!pinnedRef.current) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // Wait for layout to settle (images, code blocks expanding, etc.).
    const id = requestAnimationFrame(() => {
      scroller.scrollTop = scroller.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

function buildResultIndex(events: AgentEvent[]): Map<string, AgentEvent> {
  const idx = new Map<string, AgentEvent>();
  for (const e of events) {
    if (e.type !== 'tool_result') continue;
    const id = (e.payload as { toolUseId?: unknown }).toolUseId;
    if (typeof id === 'string') idx.set(id, e);
  }
  return idx;
}

function toolUseIdOf(ev: AgentEvent): string {
  const id = (ev.payload as { toolUseId?: unknown }).toolUseId;
  return typeof id === 'string' ? id : `seq:${ev.seq}`;
}

function CompletionActions({
  runId,
  issueNumber,
  issueLabels,
  issueStatus,
  onChanged,
}: {
  runId: number;
  issueNumber: number;
  issueLabels: readonly string[];
  issueStatus: StatusKey | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [prModalOpen, setPrModalOpen] = useState(false);
  const alreadyDone = issueStatus === 'done';
  const { focusedRepoId } = useFocusedRepo();

  async function call<T>(
    name: string,
    fn: () => Promise<T>,
    success: (r: T) => string,
  ): Promise<void> {
    setBusy(name);
    setError(null);
    setInfo(null);
    try {
      const r = await fn();
      setInfo(success(r));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      style={{
        border: '1px solid var(--accent-line)',
        borderRadius: 8,
        padding: 12,
        background: 'color-mix(in oklch, var(--bg-1) 80%, var(--accent-soft))',
      }}
    >
      <div style={{ fontSize: 12, color: 'var(--ink-2)', marginBottom: 8 }}>
        <b style={{ color: 'var(--accent)' }}>Run complete.</b> What's next?
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button
          type="button"
          className="kb-btn ghost"
          disabled={busy !== null}
          onClick={() =>
            void call(
              'review',
              () =>
                api.spawnReviewer(
                  issueNumber,
                  focusedRepoId !== null ? { repoId: focusedRepoId } : {},
                ),
              (r) => `Review agent started — run #${r.id}`,
            )
          }
        >
          {busy === 'review' ? 'Spawning…' : 'Review code'}
        </button>
        <button
          type="button"
          className="kb-btn ghost"
          disabled={busy !== null || alreadyDone}
          onClick={() =>
            void call(
              'mark-complete',
              () =>
                api.updateIssue(issueNumber, {
                  labels: withStatus(issueLabels, 'done'),
                }),
              () => 'Marked complete · worktrees cleaned up (unmerged branches kept)',
            )
          }
        >
          {busy === 'mark-complete'
            ? 'Marking…'
            : alreadyDone
              ? 'Marked complete'
              : 'Mark as complete'}
        </button>
        <button
          type="button"
          className="kb-btn ghost"
          disabled={busy !== null}
          onClick={() => {
            setError(null);
            setInfo(null);
            setPrModalOpen(true);
          }}
          title="Drafts a title + body from this run's diff, then opens the PR with your edits."
        >
          Open draft PR
        </button>
      </div>
      {info ? (
        <div style={{ fontSize: 11, color: 'var(--ink-2)', marginTop: 8 }}>{info}</div>
      ) : null}
      {error ? (
        <div style={{ fontSize: 11, color: 'var(--failed)', marginTop: 8 }}>error: {error}</div>
      ) : null}
      {prModalOpen ? (
        <CreatePrModal
          runId={runId}
          onClose={() => setPrModalOpen(false)}
          onCreated={(prUrl) => {
            setPrModalOpen(false);
            setInfo(`PR opened: ${prUrl}`);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function MessageRow({ message, cards }: { message: Message; cards: Card[] }) {
  if (message.role === 'system') {
    return (
      <div
        style={{
          fontSize: 11,
          color: 'var(--ink-3)',
          textAlign: 'center',
          padding: '4px 0',
        }}
      >
        — {message.body} · {ageString(message.createdAt)} ago —
        {cards.map((c) =>
          c.type === 'decision' ? (
            <DecisionInline key={c.id} card={c as Card<DecisionPayload>} />
          ) : null,
        )}
      </div>
    );
  }
  const isUser = message.role === 'user';
  const label = isUser ? 'you' : 'claude';
  const labelColor = isUser ? 'var(--ink-1)' : 'var(--accent)';
  const bg = isUser
    ? 'var(--bg-2)'
    : 'color-mix(in oklch, var(--bg-1) 80%, var(--accent-soft))';
  const border = isUser ? 'var(--hairline)' : 'var(--accent-line)';
  return (
    <div
      style={{
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 8,
        padding: '10px 12px',
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 5 }}>
        <b style={{ color: labelColor }}>{label}</b> · {ageString(message.createdAt)} ago
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--ink-1)', whiteSpace: 'pre-wrap' }}>
        {message.body}
      </div>
      {cards.map((c) =>
        c.type === 'decision' ? (
          <DecisionInline key={c.id} card={c as Card<DecisionPayload>} />
        ) : null,
      )}
    </div>
  );
}

function DecisionInline({ card }: { card: Card<DecisionPayload> }) {
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(null);
    }
  }

  return (
    <div className="kb-decision" role="region" aria-label="Agent question" style={{ marginTop: 10 }}>
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
      <div
        style={{
          background: 'color-mix(in oklch, var(--bg-1) 80%, var(--accent-soft))',
          border: '1px solid var(--accent-line)',
          borderRadius: 8,
          padding: '10px 12px',
        }}
      >
        <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 5 }}>
          <b style={{ color: 'var(--accent)' }}>claude</b> · {ageString(event.createdAt)} ago
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--ink-1)', whiteSpace: 'pre-wrap' }}>
          {text}
        </div>
      </div>
    );
  }
  if (event.type === 'error') {
    const p = event.payload as { message?: string };
    return (
      <div className="kb-tcall" style={{ borderColor: 'var(--failed)' }}>
        <div className="kb-tcall-head">
          <span className="name" style={{ color: 'var(--failed)' }}>error</span>
          <span className="arg">{p.message ?? 'unknown'}</span>
          <span className="dur">{ageString(event.createdAt)} ago</span>
        </div>
      </div>
    );
  }
  if (event.type === 'containment_warning') {
    const p = event.payload as {
      tool?: string;
      reason?: string;
      paths?: string[];
      heuristic?: boolean;
      mode?: string;
    };
    const arg =
      `${p.tool ?? 'tool'} → ${(p.paths ?? []).join(', ') || '(unknown path)'}` +
      (p.heuristic ? ' (heuristic)' : '');
    return (
      <div
        className="kb-tcall"
        style={{ borderColor: 'var(--warning, #c47a00)', background: 'color-mix(in oklch, var(--bg-1) 80%, #c47a0033)' }}
      >
        <div className="kb-tcall-head">
          <span className="name" style={{ color: 'var(--warning, #c47a00)' }}>
            ⚠ containment {p.mode === 'pause' ? 'pause' : 'warn'}
          </span>
          <span className="arg" title={p.reason}>{arg}</span>
          <span className="dur">{ageString(event.createdAt)} ago</span>
        </div>
      </div>
    );
  }
  return null;
}

function DiffTabModal({ activeRun }: { activeRun: AgentRun | null }) {
  const [data, setData] = useState<DiffPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeRun) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .getAgentRunDiff(activeRun.id)
      .then((p) => {
        if (!cancelled) setData(p);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRun?.id]);

  if (!activeRun) {
    return (
      <div className="kb-tdm-section">
        <h3>Diff</h3>
        <div className="kb-desc-md" style={{ color: 'var(--ink-3)' }}>
          No active run for this issue.
        </div>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="kb-tdm-section">
        <h3>Diff</h3>
        <div className="kb-desc-md">Loading…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="kb-tdm-section">
        <h3>Diff</h3>
        <div className="kb-desc-md" style={{ color: 'var(--failed)' }}>
          {error}
        </div>
      </div>
    );
  }
  if (!data || data.empty) {
    return (
      <div className="kb-tdm-section">
        <h3>Diff</h3>
        <div className="kb-desc-md" style={{ color: 'var(--ink-3)' }}>
          No changes vs. base.
        </div>
      </div>
    );
  }
  return (
    <div className="kb-tdm-section">
      <h3>
        Diff vs {data.base} · {data.files.length} file{data.files.length === 1 ? '' : 's'}
      </h3>
      <div className="kb-diff-block">
        <div className="kb-diff-head">
          <span className="branch">{data.branch ?? 'HEAD'}</span>
          <span className="arrow">←</span>
          <span className="branch" style={{ color: 'var(--ink-3)' }}>
            {data.base}
          </span>
          <span className="stat">{data.files.length}</span>
        </div>
        {data.files.map((f) => (
          <DiffFileBlockModal key={f.path} file={f} />
        ))}
      </div>
    </div>
  );
}

function DiffFileBlockModal({ file }: { file: DiffFile }) {
  return (
    <div className="kb-diff-file">
      <div className="kb-diff-fhead">
        <span className={`stat-tag ${file.status}`}>{file.status}</span>
        <span className="path">{file.path}</span>
      </div>
      <div className="kb-diff-hunk">
        {file.patch.split('\n').map((line, idx) => {
          let cls = '';
          if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) {
            cls = '';
          } else if (line.startsWith('@@')) cls = 'hunk';
          else if (line.startsWith('+')) cls = 'add';
          else if (line.startsWith('-')) cls = 'del';
          return (
            <span key={idx} className={`kb-diff-line ${cls}`}>
              {line || ' '}
              {'\n'}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function PreviewTabModal({ activeRun }: { activeRun: AgentRun | null }) {
  // Translate an inspect selection into a markdown context block and hand it
  // to the chat composer via a window-scoped event. The composer
  // (`ReplyFooter`) listens for `kanbots:composer:insert` regardless of the
  // currently-visible tab — it lives in the modal footer, so the insert
  // always lands even if the user is staring at the Preview tab.
  function handleInspectSelect(sel: PreviewInspectSelection): void {
    const header = formatInspectHeader(sel);
    const preview = sel.textPreview.trim();
    const block = preview ? `${header}\n\`${preview}\`\n\n` : `${header}\n\n`;
    window.dispatchEvent(
      new CustomEvent('kanbots:composer:insert', { detail: { text: block } }),
    );
  }
  return (
    <div className="kb-tdm-section">
      <h3>Branch preview · live dev server on this worktree</h3>
      <PreviewPanel
        branch={activeRun?.branchName ?? null}
        worktreePath={activeRun?.worktreePath ?? null}
        {...(activeRun ? { activeRunId: activeRun.id } : {})}
        size="tall"
        onInspectSelect={handleInspectSelect}
      />
    </div>
  );
}

function formatInspectHeader(sel: PreviewInspectSelection): string {
  const loc =
    sel.filePath && typeof sel.lineNumber === 'number'
      ? `\`src/${sel.filePath}:${sel.lineNumber}\``
      : sel.filePath
        ? `\`src/${sel.filePath}\``
        : null;
  if (sel.reactComponent && loc) {
    return `Inspecting <${sel.reactComponent}> in ${loc}:`;
  }
  if (loc) {
    const idSuffix = sel.id ? `#${sel.id}` : '';
    return `Inspecting <${sel.tagName}${idSuffix}> in ${loc}:`;
  }
  if (sel.selector) {
    return `Inspecting <${sel.tagName}> at \`${sel.selector}\`:`;
  }
  return `Inspecting <${sel.tagName}>:`;
}

function RunsTab({ issueNumber }: { issueNumber: number }) {
  const { data, loading, error } = useFetch<AgentRun[]>(`runs:${issueNumber}`, () =>
    api.listIssueRuns(issueNumber),
  );

  if (loading) {
    return (
      <div className="kb-tdm-section">
        <h3>Run history</h3>
        <div className="kb-desc-md">Loading…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="kb-tdm-section">
        <h3>Run history</h3>
        <div className="kb-desc-md" style={{ color: 'var(--failed)' }}>
          {error.message}
        </div>
      </div>
    );
  }
  const runs = data ?? [];
  if (runs.length === 0) {
    return (
      <div className="kb-tdm-section">
        <h3>Run history</h3>
        <div className="kb-desc-md" style={{ color: 'var(--ink-3)' }}>
          No agent runs yet.
        </div>
      </div>
    );
  }

  return (
    <div className="kb-tdm-section">
      <h3>Run history</h3>
      <div className="kb-run-timeline">
        {runs.map((r) => {
          const status = r.status;
          const isActive =
            status === 'running' || status === 'awaiting_input' || status === 'starting';
          return (
            <div key={r.id} className={`kb-run-row kb-status-${status}`}>
              <div className="kb-marker">
                <div className="dot" />
              </div>
              <div>
                <div className="kb-run-meta-line">
                  <span style={{ color: isActive ? 'var(--running)' : 'var(--ink-2)', fontWeight: 600 }}>
                    {status === 'running' ? '● Running' : status === 'complete' ? '✓ Completed' : status === 'failed' ? '✗ Failed' : status === 'awaiting_input' ? '? Awaiting' : status === 'stopped' ? '◼ Stopped' : '… Starting'}
                  </span>
                  <span className="id">run #{r.id}</span>
                  <span>· {ageString(r.startedAt)} ago</span>
                </div>
                <div className="kb-run-summary">{r.exitReason ?? '(no exit reason)'}</div>
                <div className="kb-run-stats-inline">
                  <span>{r.model ?? '—'}</span>
                  <span>
                    {fmtTokens(r.tokenUsageInput)}/{fmtTokens(r.tokenUsageOutput)} tok
                  </span>
                  <span>{fmtElapsed(r.startedAt, r.endedAt ?? undefined)}</span>
                </div>
              </div>
              <button type="button" className="kb-btn ghost" disabled title="Phase 11">
                {isActive ? 'Stop' : 'View'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AutopilotStopButton({
  issueNumber,
  onAfter,
}: {
  issueNumber: number;
  onAfter: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function stop(stopChildren: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const session = await api.getAutopilotByIssue(issueNumber);
      if (!session) {
        throw new Error('Autopilot session not found for this card.');
      }
      await api.stopAutopilot(session.id, { stopChildren });
      setConfirmOpen(false);
      dispatchIssuesRefetch();
      onAfter();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="kb-btn ghost"
        onClick={() => setConfirmOpen(true)}
        disabled={busy}
      >
        Stop autopilot
      </button>
      {confirmOpen ? (
        <div className="kb-modal-scrim kb-app" onClick={() => !busy && setConfirmOpen(false)}>
          <div
            className="kb-modal sm"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 460 }}
          >
            <div className="kb-modal-head">
              <h2>Stop autopilot</h2>
              <span className="grow" />
            </div>
            <div className="kb-modal-body" style={{ display: 'block', padding: '14px 20px' }}>
              <div style={{ fontSize: 13, color: 'var(--ink-1)', marginBottom: 12 }}>
                The autopilot loop will stop creating new tasks. Choose what happens to any
                child task that's currently running.
              </div>
              {error ? (
                <div style={{ fontSize: 11, color: 'var(--failed)', marginBottom: 8 }}>
                  {error}
                </div>
              ) : null}
            </div>
            <div className="kb-modal-foot">
              <button
                type="button"
                className="kb-btn ghost"
                onClick={() => setConfirmOpen(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <span className="grow" />
              <button
                type="button"
                className="kb-btn ghost"
                onClick={() => void stop(false)}
                disabled={busy}
              >
                Let children finish
              </button>
              <button
                type="button"
                className="kb-btn primary"
                onClick={() => void stop(true)}
                disabled={busy}
                style={{ marginLeft: 8 }}
              >
                {busy ? 'Stopping…' : 'Stop and cancel children'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function AutopilotTab({ issueNumber }: { issueNumber: number }) {
  const { data, loading, error, refetch } = useFetch<AutopilotSession | null>(
    `autopilot:${issueNumber}`,
    () => api.getAutopilotByIssue(issueNumber),
  );

  // Refetch on broadcast — orchestrator fires `issues:changed` after every
  // session/cycle update.
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.kanbots : undefined;
    if (!bridge) return;
    return bridge.subscribe(ISSUES_CHANGED_CHANNEL, () => {
      void refetch();
    });
  }, [refetch]);

  if (loading && !data) {
    return (
      <div className="kb-tdm-section">
        <h3>Autopilot</h3>
        <div className="kb-desc-md">Loading…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="kb-tdm-section">
        <h3>Autopilot</h3>
        <div className="kb-desc-md" style={{ color: 'var(--failed)' }}>
          {error.message}
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="kb-tdm-section">
        <h3>Autopilot</h3>
        <div className="kb-desc-md" style={{ color: 'var(--ink-3)' }}>
          No autopilot session found for this card. It may have been started by an older app
          version.
        </div>
      </div>
    );
  }

  const session = data;
  const personas =
    session.config.kind === 'feature-dev' ? session.config.personas : [];
  const checks = session.config.kind === 'qa' ? session.config.checks : [];
  const liveUi = session.config.kind === 'qa' ? session.config.liveUi : false;
  const featureDevConfig =
    session.config.kind === 'feature-dev' ? session.config : null;
  const parallelism = featureDevConfig?.parallelism ?? 1;
  const runningPersonaNames = new Set(
    session.children
      .filter((c) => c.status === 'running' && c.persona)
      .map((c) => c.persona as string),
  );
  const cycleHint =
    session.config.kind === 'feature-dev' && personas.length > 0
      ? parallelism > 1
        ? `${runningPersonaNames.size}/${parallelism} slots running`
        : `Next: ${personas[session.cycleIndex % personas.length]?.name ?? '—'}`
      : '';

  return (
    <div className="kb-tdm-section">
      <h3>Autopilot · {session.kind}</h3>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '4px 16px',
          fontSize: 12,
          marginBottom: 14,
        }}
      >
        <span style={{ color: 'var(--ink-3)' }}>Status</span>
        <span style={{ color: 'var(--ink-1)' }}>
          {session.status}
          {session.stopReason ? (
            <span style={{ color: 'var(--ink-3)' }}> · {session.stopReason}</span>
          ) : null}
        </span>
        <span style={{ color: 'var(--ink-3)' }}>Started</span>
        <span style={{ color: 'var(--ink-1)' }}>{ageString(session.startedAt)} ago</span>
        {session.endedAt ? (
          <>
            <span style={{ color: 'var(--ink-3)' }}>Ended</span>
            <span style={{ color: 'var(--ink-1)' }}>{ageString(session.endedAt)} ago</span>
          </>
        ) : null}
        <span style={{ color: 'var(--ink-3)' }}>Cycle</span>
        <span style={{ color: 'var(--ink-1)' }}>
          {session.cycleIndex} {cycleHint ? `· ${cycleHint}` : ''}
        </span>
        {featureDevConfig ? (
          <>
            <span style={{ color: 'var(--ink-3)' }}>Model</span>
            <span style={{ color: 'var(--ink-1)' }} className="mono">
              {featureDevConfig.model ?? 'default'}
            </span>
            <span style={{ color: 'var(--ink-3)' }}>Effort</span>
            <span style={{ color: 'var(--ink-1)' }} className="mono">
              {featureDevConfig.effort ?? 'medium'}
            </span>
            <span style={{ color: 'var(--ink-3)' }}>Parallel</span>
            <span style={{ color: 'var(--ink-1)' }} className="mono">
              {parallelism}
            </span>
          </>
        ) : null}
      </div>

      {personas.length > 0 ? (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 6 }}>Personas</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {personas.map((p, i) => {
              const highlighted =
                session.status === 'running' &&
                (parallelism > 1
                  ? runningPersonaNames.has(p.name)
                  : i === session.cycleIndex % personas.length);
              return (
                <span
                  key={p.id}
                  className="kb-chip mono"
                  style={
                    highlighted
                      ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
                      : undefined
                  }
                >
                  {p.name}
                </span>
              );
            })}
          </div>
        </div>
      ) : null}

      {checks.length > 0 || liveUi ? (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 6 }}>QA scope</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {checks.map((c) => (
              <span key={c.kind} className="kb-chip mono">
                {c.kind}: {c.command}
              </span>
            ))}
            {liveUi ? <span className="kb-chip mono">live UI</span> : null}
          </div>
        </div>
      ) : null}

      <div>
        <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 8 }}>
          Children · {session.children.length}
        </div>
        {session.planningSlots && session.planningSlots.length > 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              marginBottom: session.children.length > 0 ? 8 : 0,
            }}
          >
            {session.planningSlots.map((slot) => (
              <PlanningSlotRow key={slot.slotIndex} slot={slot} />
            ))}
          </div>
        ) : null}
        {session.children.length === 0 &&
        (!session.planningSlots || session.planningSlots.length === 0) ? (
          <div className="kb-desc-md" style={{ color: 'var(--ink-3)' }}>
            No tasks created yet. The first one will appear shortly.
          </div>
        ) : null}
        {session.children.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {[...session.children].reverse().map((child, idx) => (
              <ChildRow key={`${child.issueNumber}-${idx}`} child={child} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ChildRow({ child }: { child: AutopilotChildEntry }) {
  const isReal = child.issueNumber > 0;
  return (
    <a
      href={isReal ? `#/issue/${child.issueNumber}` : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        borderRadius: 6,
        background: 'var(--bg-2)',
        border: '1px solid var(--hairline-soft)',
        textDecoration: 'none',
        color: 'inherit',
        fontSize: 12,
        cursor: isReal ? 'pointer' : 'default',
      }}
      onClick={(e) => {
        if (!isReal) e.preventDefault();
      }}
    >
      <span
        style={{
          fontFamily: 'var(--ff-mono)',
          fontSize: 11,
          color: 'var(--ink-3)',
          minWidth: 40,
        }}
      >
        {isReal ? `#${child.issueNumber}` : '—'}
      </span>
      <span
        className={`kb-tag kb-tag-${child.kind === 'bug' ? 'BUG' : 'FEAT'}`}
        style={{ flexShrink: 0 }}
      >
        {child.kind === 'bug' ? 'BUG' : 'FEAT'}
      </span>
      <span
        style={{
          flex: 1,
          color: 'var(--ink-1)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {child.title}
      </span>
      {child.persona ? (
        <span style={{ color: 'var(--ink-3)', fontSize: 11 }}>{child.persona}</span>
      ) : null}
      <span
        style={{
          color:
            child.status === 'complete'
              ? 'var(--review)'
              : child.status === 'failed' || child.status === 'stopped' || child.status === 'skipped'
                ? 'var(--failed)'
                : 'var(--running)',
          fontSize: 11,
          minWidth: 64,
          textAlign: 'right',
        }}
      >
        {child.status}
      </span>
    </a>
  );
}

function PlanningSlotRow({ slot }: { slot: AutopilotPlanningSlot }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const events = slot.recentEvents.slice(-3);
  return (
    <div
      style={{
        padding: '8px 10px',
        borderRadius: 6,
        background: 'var(--bg-2)',
        border: '1px solid var(--hairline-soft)',
        fontSize: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: 'var(--running)',
            flexShrink: 0,
          }}
        />
        <span style={{ flex: 1, color: 'var(--ink-1)' }}>
          <span style={{ color: 'var(--ink-3)' }}>Planning · </span>
          {slot.persona}
        </span>
        <span style={{ color: 'var(--ink-3)', fontSize: 11 }}>
          {fmtElapsed(slot.startedAt)}
        </span>
      </div>
      {events.length === 0 ? (
        <div
          className="mono"
          style={{ color: 'var(--ink-3)', fontSize: 11, paddingLeft: 18 }}
        >
          starting…
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            paddingLeft: 18,
            fontSize: 11,
          }}
        >
          {events.map((e, i) => (
            <span
              key={`${e.at}-${i}`}
              className="mono"
              style={{
                color: i === events.length - 1 ? 'var(--ink-2)' : 'var(--ink-3)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {e.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

