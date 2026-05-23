import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import type { AgentRunSummary } from '@kanbots/cloud-client';
import { api, getCloudCtx } from '../../api.js';
import { getBridge } from '../../desktop-bridge.js';
import { InlineDiff, type InlineDiffMode } from '../run/InlineDiff.js';
import { useDiffPrefs } from '../../hooks/useDiffPrefs.js';

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'stopped', 'timed_out']);

function isActiveStatus(status: string): boolean {
  return !TERMINAL_RUN_STATUSES.has(status);
}

/**
 * Snapshot of the most recent thread context (card body + N most recent
 * comments) used to feed a restarted agent so it can pick up where the
 * previous run left off. The cloud CLI doesn't read cloud comments
 * itself, so we splice them into `appendSystemPrompt` at restart time.
 */
const RESTART_CONTEXT_COMMENT_LIMIT = 12;

async function buildRestartContext(
  orgSlug: string,
  projectSlug: string,
  issueNumber: number,
): Promise<string | null> {
  const bridge = getBridge();
  if (!bridge) return null;
  try {
    const card = await bridge.cloudCardsGet({ orgSlug, projectSlug, number: issueNumber });
    const commentsResp = await bridge.cloudCommentsList({
      orgSlug,
      projectSlug,
      number: issueNumber,
    });
    const lines: string[] = [];
    lines.push(`This is a continuation of task #${issueNumber}: ${card.title}`);
    if (card.body) {
      lines.push('', 'Task description:', card.body);
    }
    const recent = commentsResp.data.slice(-RESTART_CONTEXT_COMMENT_LIMIT);
    if (recent.length > 0) {
      lines.push('', 'Recent thread (oldest first):');
      for (const c of recent) {
        lines.push(`---`);
        lines.push(c.body);
      }
    }
    lines.push('', 'Continue from the latest message in the thread.');
    return lines.join('\n');
  } catch {
    return null;
  }
}

/**
 * Read-only, VSCode-tab-style file viewer with two modes:
 *
 *   • "Current" tab — renders the working-tree file content with a
 *     line-number gutter. No edit affordances; this is strictly a
 *     reading surface.
 *
 *   • "Changes (N)" tab — one GitHub-PR-style diff card per worktree
 *     that has uncommitted changes for this file. Each card is tagged
 *     with the originating task (#N + title) and agent run metadata
 *     (provider · model · status) so the user can see at a glance
 *     "this hunk came from task X's run Y by claude-code". The reply
 *     form lets them talk back to that run's thread.
 *
 * Editing the file is deliberately out of scope — the modal answers
 * "what's in this file, and what did the agents change?", not "let me
 * patch it from here".
 */

export interface FileChangeViewerProps {
  filePath: string;
  worktrees: string[];
  onClose: () => void;
  /**
   * Navigate to a card after a new agent task has been created from
   * inside the viewer. When omitted, the viewer just shows an inline
   * confirmation and the user can find the task in the rail.
   */
  onSelectIssue?: (issueNumber: number) => void;
}

/**
 * Truncate a free-form prompt to a single-line title suitable for a
 * card. Mirrors what the user would type if they manually opened the
 * task-create modal — first non-empty line, ~72 chars.
 */
function deriveTitle(filePath: string, prompt: string): string {
  const fileName = filePath.split('/').pop() ?? filePath;
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return `Work on ${fileName}`;
  const firstLine = trimmed.split('\n')[0]?.trim() ?? '';
  if (firstLine.length === 0) return `Work on ${fileName}`;
  const capped = firstLine.length > 72 ? `${firstLine.slice(0, 69)}…` : firstLine;
  return capped;
}

/**
 * Wrap the user's prompt with a short file-context preamble so the
 * spawned agent knows which path the request came from. We keep this
 * lightweight — the agent can `Read` the file itself once it picks up
 * the task.
 */
function buildPrompt(filePath: string, prompt: string): string {
  const trimmed = prompt.trim();
  return [`File in scope: \`${filePath}\``, '', trimmed].join('\n');
}

interface StartAgentOnFilePanelProps {
  filePath: string;
  /** Lead text shown above the form, explaining what's about to happen. */
  heading: string;
  /** Placeholder text inside the prompt box. */
  placeholder: string;
  onSelectIssue?: (issueNumber: number) => void;
}

/**
 * Inline "Start a new agent on this file" form. Cloud mode only — in
 * local mode the user can still hit "+" on the board. Creates a card
 * with a title derived from the prompt + the file in scope, then
 * dispatches an agent run against it.
 */
function StartAgentOnFilePanel({
  filePath,
  heading,
  placeholder,
  onSelectIssue,
}: StartAgentOnFilePanelProps) {
  const cloudCtx = getCloudCtx();
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ number: number; title: string } | null>(null);

  const start = useCallback(async () => {
    if (cloudCtx === null) return;
    const body = prompt.trim();
    if (body.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const bridge = getBridge();
      if (!bridge) throw new Error('desktop bridge unavailable');
      const title = deriveTitle(filePath, body);
      const card = await bridge.cloudCardsCreate({
        orgSlug: cloudCtx.orgSlug,
        projectSlug: cloudCtx.projectSlug,
        body: { title, body: buildPrompt(filePath, body) },
      });
      await bridge.cloudStartAgentRun({
        orgSlug: cloudCtx.orgSlug,
        projectSlug: cloudCtx.projectSlug,
        number: card.number,
        prompt: buildPrompt(filePath, body),
      });
      setCreated({ number: card.number, title: card.title });
      setPrompt('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [cloudCtx, prompt, busy, filePath]);

  if (cloudCtx === null) {
    return (
      <div className="kb-fcv-start kb-fcv-start-disabled">
        <span className="kb-fcv-hint">
          Sign in to Kanbots Cloud to start an agent on this file from here.
        </span>
      </div>
    );
  }

  return (
    <div className="kb-fcv-start">
      <label className="kb-fcv-reply-label">{heading}</label>
      {created !== null ? (
        <div className="kb-fcv-start-ok">
          <span className="kb-fcv-ok">
            Created task <strong>#{created.number}</strong> — {created.title}
          </span>
          <div className="kb-fcv-start-ok-actions">
            <button
              type="button"
              className="kb-btn"
              onClick={() => setCreated(null)}
            >
              Start another
            </button>
            {onSelectIssue !== undefined ? (
              <button
                type="button"
                className="kb-btn primary"
                onClick={() => onSelectIssue(created.number)}
              >
                View task
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <>
          <textarea
            className="kb-fcv-reply-text"
            placeholder={placeholder}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            disabled={busy}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void start();
              }
            }}
          />
          <div className="kb-fcv-reply-foot">
            {error ? <span className="kb-fcv-err">{error}</span> : null}
            <span className="kb-fcv-hint">⌘⏎ to start</span>
            <button
              type="button"
              className="kb-btn primary"
              onClick={() => void start()}
              disabled={busy || prompt.trim().length === 0}
            >
              {busy ? 'Starting…' : 'Create task & start agent'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

type StatusCode = 'M' | 'A' | 'D' | 'R' | '??' | 'U' | null;

interface DiffPayload {
  status: StatusCode;
  oldText: string | null;
  newText: string | null;
}

interface DiffViewState {
  loading: boolean;
  data: DiffPayload | null;
  error: string | null;
}

/**
 * `.kanbots/worktrees/issue-<n>-<r>` is the convention used by both
 * the local supervisor (`defaultWorktreePath` in @kanbots/dispatcher,
 * numeric runId) and the cloud dispatcher (last-10-chars of the
 * KSUID, alphanumeric). The regex accepts both shapes; the caller
 * treats runId as opaque.
 */
function parseWorktreeContext(
  worktreePath: string,
): { issueNumber: number; runId: string } | null {
  const m = /\.kanbots\/worktrees\/issue-(\d+)-([A-Za-z0-9]+)\/?$/.exec(worktreePath);
  if (m === null) return null;
  const issueNumber = Number.parseInt(m[1] ?? '', 10);
  const runId = m[2] ?? '';
  if (!Number.isFinite(issueNumber) || runId.length === 0) return null;
  return { issueNumber, runId };
}

function statusLabel(status: StatusCode): string {
  switch (status) {
    case 'M':
      return 'Modified';
    case 'A':
      return 'Added';
    case 'D':
      return 'Deleted';
    case 'R':
      return 'Renamed';
    case '??':
      return 'Untracked';
    case 'U':
      return 'Conflict';
    default:
      return 'Clean';
  }
}

/**
 * Count added / deleted lines from raw old/new text by comparing line
 * sets — same approximation GitHub uses in the file-strip stats. It's
 * not as precise as walking the LCS but it's O(n) and Good Enough™ for
 * a header chip.
 */
function quickStats(oldText: string | null, newText: string | null): { added: number; deleted: number } {
  if (oldText === null && newText === null) return { added: 0, deleted: 0 };
  if (oldText === null) {
    const lines = (newText ?? '').split('\n');
    const trailing = lines.length > 0 && lines.at(-1) === '' ? 1 : 0;
    return { added: lines.length - trailing, deleted: 0 };
  }
  if (newText === null) {
    const lines = oldText.split('\n');
    const trailing = lines.length > 0 && lines.at(-1) === '' ? 1 : 0;
    return { added: 0, deleted: lines.length - trailing };
  }
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  // Build multisets (counter maps), subtract the intersection. The
  // difference under each side is the lines unique to that side.
  const oldCount = new Map<string, number>();
  for (const l of oldLines) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
  let deleted = 0;
  let added = 0;
  const remaining = new Map(oldCount);
  for (const l of newLines) {
    const have = remaining.get(l);
    if (have && have > 0) remaining.set(l, have - 1);
    else added += 1;
  }
  for (const n of remaining.values()) deleted += n;
  return { added, deleted };
}

/**
 * Read-only file content view with a line-number gutter. Renders the
 * working-tree contents of `filePath` (resolved against the active
 * repo's main checkout). Bails out gracefully on binary content, files
 * over the size cap, and missing/inaccessible paths.
 */
interface FileContentViewState {
  loading: boolean;
  content: string | null;
  size: number;
  truncated: boolean;
  isBinary: boolean;
  error: string | null;
}

function FileContentView({ filePath }: { filePath: string }) {
  const [state, setState] = useState<FileContentViewState>({
    loading: true,
    content: null,
    size: 0,
    truncated: false,
    isBinary: false,
    error: null,
  });

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) {
      setState({
        loading: false,
        content: null,
        size: 0,
        truncated: false,
        isBinary: false,
        error: 'desktop bridge unavailable',
      });
      return;
    }
    let cancelled = false;
    setState({
      loading: true,
      content: null,
      size: 0,
      truncated: false,
      isBinary: false,
      error: null,
    });
    void bridge
      .workspaceFileRead({ filePath })
      .then((res) => {
        if (cancelled) return;
        setState({
          loading: false,
          content: res.content,
          size: res.size,
          truncated: res.truncated,
          isBinary: res.isBinary,
          error: res.error,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          loading: false,
          content: null,
          size: 0,
          truncated: false,
          isBinary: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const lines = useMemo(() => {
    if (state.content === null) return null;
    const raw = state.content.split('\n');
    if (raw.length > 0 && raw.at(-1) === '') raw.pop();
    return raw;
  }, [state.content]);

  if (state.loading) {
    return <div className="kb-fcv-empty">Loading file…</div>;
  }
  if (state.error !== null) {
    return <div className="kb-fcv-empty kb-fcv-err">Could not read file: {state.error}</div>;
  }
  if (state.isBinary) {
    return (
      <div className="kb-fcv-empty">
        Binary file ({formatBytes(state.size)}) — preview unavailable.
      </div>
    );
  }
  if (lines === null) {
    return <div className="kb-fcv-empty">File is empty or unreadable.</div>;
  }

  const gutter = Math.max(2, String(lines.length).length);

  return (
    <div className="kb-fcv-content">
      {state.truncated ? (
        <div className="kb-fcv-trunc">
          Showing the first {formatBytes(2 * 1024 * 1024)} of a {formatBytes(state.size)} file.
        </div>
      ) : null}
      <div className="kb-fcv-code" role="region" aria-label="File contents">
        {lines.map((line, i) => (
          <div key={i} className="kb-fcv-code-line">
            <span className="kb-fcv-code-num" aria-hidden>
              {String(i + 1).padStart(gutter, ' ')}
            </span>
            <span className="kb-fcv-code-text">{line || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface RunMetaState {
  loading: boolean;
  run: AgentRunSummary | null;
  cardTitle: string | null;
  error: string | null;
}

interface WorktreeDiffCardProps {
  worktreePath: string;
  filePath: string;
  defaultOpen: boolean;
  diffMode: InlineDiffMode;
  ignoreWhitespace: boolean;
  // Tick counters from the parent: when these increment, the card forces its
  // local `open` to the corresponding state. Lets a single button in the
  // modal head expand or collapse every card without removing the
  // per-card chevron's ability to toggle individually afterwards.
  expandTick: number;
  collapseTick: number;
  onMessageSent?: () => void;
  onSelectIssue?: (issueNumber: number) => void;
}

function WorktreeDiffCard({
  worktreePath,
  filePath,
  defaultOpen,
  diffMode,
  ignoreWhitespace,
  expandTick,
  collapseTick,
  onMessageSent,
  onSelectIssue,
}: WorktreeDiffCardProps) {
  const [state, setState] = useState<DiffViewState>({
    loading: true,
    data: null,
    error: null,
  });
  const ctx = parseWorktreeContext(worktreePath);
  const cloudCtx = getCloudCtx();
  // Inline-comment UI is local-only: cloud KSUID suffixes are alphanumeric
  // and don't address rows in the local `agent_runs` table. Coerce to a
  // finite integer; pass to InlineDiff only when both succeed.
  const localRunId = useMemo<number | null>(() => {
    if (ctx === null || cloudCtx !== null) return null;
    const n = Number.parseInt(ctx.runId, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [ctx, cloudCtx]);
  const [reply, setReply] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [posted, setPosted] = useState(false);
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (expandTick > 0) setOpen(true);
  }, [expandTick]);
  useEffect(() => {
    if (collapseTick > 0) setOpen(false);
  }, [collapseTick]);
  const [meta, setMeta] = useState<RunMetaState>({
    loading: ctx !== null && cloudCtx !== null,
    run: null,
    cardTitle: null,
    error: null,
  });

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) return;
    let cancelled = false;
    setState({ loading: true, data: null, error: null });
    void bridge
      .workspaceFileDiff({ worktreePath, filePath })
      .then((data) => {
        if (cancelled) return;
        setState({ loading: false, data, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          loading: false,
          data: null,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [worktreePath, filePath]);

  // Fetch the originating task title + the agent run metadata so the
  // card header can show "#42 · Fix login bug · claude-code · sonnet".
  // We use cloudRunsListForCard then match by runId because the cloud
  // KSUIDs we get from the worktree path are the *last 10 chars*, not
  // the full id — so we can only match by suffix.
  useEffect(() => {
    if (ctx === null || cloudCtx === null) {
      setMeta({ loading: false, run: null, cardTitle: null, error: null });
      return;
    }
    const bridge = getBridge();
    if (!bridge) {
      setMeta({ loading: false, run: null, cardTitle: null, error: null });
      return;
    }
    let cancelled = false;
    setMeta((prev) => ({ ...prev, loading: true, error: null }));
    void Promise.all([
      bridge.cloudCardsGet({
        orgSlug: cloudCtx.orgSlug,
        projectSlug: cloudCtx.projectSlug,
        number: ctx.issueNumber,
      }),
      bridge.cloudRunsListForCard({
        orgSlug: cloudCtx.orgSlug,
        projectSlug: cloudCtx.projectSlug,
        number: ctx.issueNumber,
      }),
    ])
      .then(([card, runs]) => {
        if (cancelled) return;
        const run = runs.data.find((r) => r.id.endsWith(ctx.runId)) ?? null;
        setMeta({
          loading: false,
          run,
          cardTitle: card.title,
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setMeta({
          loading: false,
          run: null,
          cardTitle: null,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [ctx, cloudCtx]);

  const hasActiveRun = meta.run !== null ? isActiveStatus(meta.run.status) : null;

  const send = useCallback(
    async (action: 'send' | 'send-restart') => {
      if (ctx === null) return;
      const body = reply.trim();
      if (body.length === 0 || posting) return;
      setPosting(true);
      setPostError(null);
      try {
        await api.postMessage(ctx.issueNumber, body, { dispatch: false });
        if (action === 'send-restart' && cloudCtx !== null) {
          const bridge = getBridge();
          if (bridge !== null) {
            const context = await buildRestartContext(
              cloudCtx.orgSlug,
              cloudCtx.projectSlug,
              ctx.issueNumber,
            );
            await bridge.cloudStartAgentRun({
              orgSlug: cloudCtx.orgSlug,
              projectSlug: cloudCtx.projectSlug,
              number: ctx.issueNumber,
              prompt: body,
              ...(context !== null ? { appendSystemPrompt: context } : {}),
            });
          }
        }
        setReply('');
        setPosted(true);
        onMessageSent?.();
      } catch (err) {
        setPostError(err instanceof Error ? err.message : String(err));
      } finally {
        setPosting(false);
      }
    },
    [ctx, reply, posting, cloudCtx, onMessageSent],
  );

  const worktreeLabel = worktreePath.split('/').pop() ?? worktreePath;
  const stats = useMemo(
    () => quickStats(state.data?.oldText ?? null, state.data?.newText ?? null),
    [state.data],
  );
  const statusCode = state.data?.status ?? null;

  return (
    <section className={`kb-fcv-worktree${open ? ' is-open' : ' is-closed'}`}>
      <button
        type="button"
        className="kb-fcv-worktree-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? 'Collapse diff' : 'Expand diff'}
      >
        <span className="kb-fcv-chevron" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        {statusCode !== null ? (
          <span className={`kb-fcv-status kb-fcv-status-${statusCode.toLowerCase().replace('?', 'u')}`}>
            {statusCode === '??' ? 'U' : statusCode}
          </span>
        ) : null}
        <span className="kb-fcv-worktree-title">
          {ctx === null ? (
            <span className="kb-fcv-task">{worktreeLabel}</span>
          ) : (
            <>
              <span className="kb-fcv-task">
                <strong>#{ctx.issueNumber}</strong>
                {meta.cardTitle ? (
                  <span className="kb-fcv-task-title"> · {meta.cardTitle}</span>
                ) : meta.loading ? (
                  <span className="kb-fcv-task-title kb-fcv-muted"> · loading…</span>
                ) : null}
              </span>
              <span className="kb-fcv-agent">
                {meta.run ? (
                  <>
                    <span className="kb-fcv-chip" title={`provider: ${meta.run.provider}`}>
                      {meta.run.provider}
                    </span>
                    <span className="kb-fcv-chip kb-fcv-chip-model" title={`model: ${meta.run.model}`}>
                      {meta.run.model}
                    </span>
                    <span className={`kb-fcv-chip kb-fcv-chip-status is-${meta.run.status}`}>
                      {meta.run.status}
                    </span>
                  </>
                ) : (
                  <span className="kb-fcv-chip kb-fcv-muted" title={worktreePath}>
                    run {ctx.runId}
                  </span>
                )}
              </span>
            </>
          )}
        </span>
        <span className="kb-fcv-stats" aria-hidden>
          {stats.added > 0 ? <span className="kb-fcv-stat-add">+{stats.added}</span> : null}
          {stats.deleted > 0 ? <span className="kb-fcv-stat-del">−{stats.deleted}</span> : null}
        </span>
        <span className="kb-fcv-worktree-status">{statusLabel(statusCode)}</span>
      </button>

      {open ? (
        <>
          <div className="kb-fcv-diff-wrap">
            {state.loading ? (
              <div className="kb-fcv-empty">Loading diff…</div>
            ) : state.error !== null ? (
              <div className="kb-fcv-empty kb-fcv-err">{state.error}</div>
            ) : state.data === null
              || (state.data.oldText === null && state.data.newText === null) ? (
              <div className="kb-fcv-empty">No diff data available.</div>
            ) : (
              <InlineDiff
                oldString={state.data.oldText ?? ''}
                newString={state.data.newText ?? ''}
                mode={diffMode}
                ignoreWhitespace={ignoreWhitespace}
                {...(localRunId !== null
                  ? { runId: localRunId, filePath }
                  : {})}
              />
            )}
          </div>

          {ctx !== null ? (
            <div className="kb-fcv-reply">
              <label className="kb-fcv-reply-label">
                Talk to the agent that made this change
                {hasActiveRun === false ? (
                  <span className="kb-fcv-reply-hint-inline"> — prior run has ended</span>
                ) : null}
              </label>
              <textarea
                className="kb-fcv-reply-text"
                placeholder={`Reply to thread for #${ctx.issueNumber}…`}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                rows={3}
                disabled={posting}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    const action = hasActiveRun === false ? 'send-restart' : 'send';
                    void send(action);
                  }
                }}
              />
              <div className="kb-fcv-reply-foot">
                {postError ? <span className="kb-fcv-err">{postError}</span> : null}
                {posted && reply.length === 0 ? <span className="kb-fcv-ok">Sent.</span> : null}
                <span className="kb-fcv-hint">⌘⏎ to send</span>
                {cloudCtx !== null && hasActiveRun === false ? (
                  <>
                    <button
                      type="button"
                      className="kb-btn"
                      onClick={() => void send('send')}
                      disabled={posting || reply.trim().length === 0}
                      title="Post the comment without starting a new agent run."
                    >
                      Send only
                    </button>
                    <button
                      type="button"
                      className="kb-btn primary"
                      onClick={() => void send('send-restart')}
                      disabled={posting || reply.trim().length === 0}
                      title="Post the comment and start a new agent run that picks up the thread."
                    >
                      {posting ? 'Restarting…' : 'Send & restart agent'}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="kb-btn primary"
                    onClick={() => void send('send')}
                    disabled={posting || reply.trim().length === 0}
                  >
                    {posting ? 'Sending…' : 'Send'}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <StartAgentOnFilePanel
              filePath={filePath}
              heading="This change is in the main worktree — start a new agent on it"
              placeholder={`Describe what an agent should do with the change in ${filePath}…`}
              {...(onSelectIssue !== undefined ? { onSelectIssue } : {})}
            />
          )}
        </>
      ) : null}
    </section>
  );
}

type Tab = 'current' | 'changes';

export function FileChangeViewer({
  filePath,
  worktrees,
  onClose,
  onSelectIssue,
}: FileChangeViewerProps) {
  const hasChanges = worktrees.length > 0;
  const [tab, setTab] = useState<Tab>(hasChanges ? 'changes' : 'current');
  const { prefs: diffPrefs, set: setDiffPref } = useDiffPrefs();
  const [expandTick, setExpandTick] = useState(0);
  const [collapseTick, setCollapseTick] = useState(0);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function stopInner(e: MouseEvent<HTMLDivElement>): void {
    e.stopPropagation();
  }

  const fileName = filePath.split('/').pop() ?? filePath;
  const dirName = filePath.length > fileName.length
    ? filePath.slice(0, filePath.length - fileName.length - 1)
    : '';

  return (
    <div className="kb-modal-scrim" onMouseDown={onClose} role="dialog" aria-modal="true">
      <div className="kb-modal kb-modal-fcv" onMouseDown={stopInner}>
        <div className="kb-modal-head">
          <h2 className="kb-fcv-title">
            <span className="kb-fcv-file" title={filePath}>
              {dirName ? <span className="kb-fcv-file-dir">{dirName}/</span> : null}
              <span className="kb-fcv-file-name">{fileName}</span>
            </span>
            <span className="kb-fcv-readonly" aria-label="read-only">read-only</span>
          </h2>
          <span className="grow" />
          {hasChanges ? (
            <>
              <div className="kb-diff-mode" role="group" aria-label="Diff view mode">
                <button
                  type="button"
                  className={`kb-diff-mode-btn${diffPrefs.mode === 'unified' ? ' is-active' : ''}`}
                  aria-pressed={diffPrefs.mode === 'unified'}
                  title="Unified diff (single column)"
                  onClick={() => setDiffPref('mode', 'unified')}
                >
                  Unified
                </button>
                <button
                  type="button"
                  className={`kb-diff-mode-btn${diffPrefs.mode === 'split' ? ' is-active' : ''}`}
                  aria-pressed={diffPrefs.mode === 'split'}
                  title="Side-by-side diff (two columns)"
                  onClick={() => setDiffPref('mode', 'split')}
                >
                  Split
                </button>
              </div>
              <button
                type="button"
                className={`kb-diff-toggle${diffPrefs.ignoreWhitespace ? ' is-active' : ''}`}
                aria-pressed={diffPrefs.ignoreWhitespace}
                title={
                  diffPrefs.ignoreWhitespace
                    ? 'Showing diff with whitespace changes hidden — click to include them'
                    : 'Click to hide whitespace-only changes'
                }
                onClick={() => setDiffPref('ignoreWhitespace', !diffPrefs.ignoreWhitespace)}
              >
                Ignore ws
              </button>
              {worktrees.length > 1 ? (
                <>
                  <button
                    type="button"
                    className="kb-diff-action"
                    title="Expand all diffs"
                    onClick={() => setExpandTick((t) => t + 1)}
                  >
                    Expand all
                  </button>
                  <button
                    type="button"
                    className="kb-diff-action"
                    title="Collapse all diffs"
                    onClick={() => setCollapseTick((t) => t + 1)}
                  >
                    Collapse all
                  </button>
                </>
              ) : null}
            </>
          ) : null}
          <button type="button" className="x-btn" onClick={onClose} aria-label="Close" title="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </button>
        </div>

        <div className="kb-fcv-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            className={`kb-fcv-tab${tab === 'current' ? ' is-active' : ''}`}
            aria-selected={tab === 'current'}
            onClick={() => setTab('current')}
          >
            Current
          </button>
          {hasChanges ? (
            <button
              type="button"
              role="tab"
              className={`kb-fcv-tab${tab === 'changes' ? ' is-active' : ''}`}
              aria-selected={tab === 'changes'}
              onClick={() => setTab('changes')}
            >
              Changes
              <span className="kb-fcv-tab-count">{worktrees.length}</span>
            </button>
          ) : null}
        </div>

        <div className="kb-modal-body kb-fcv-body">
          {tab === 'current' ? (
            <>
              <FileContentView filePath={filePath} />
              <StartAgentOnFilePanel
                filePath={filePath}
                heading="Start an agent on this file"
                placeholder={`Tell an agent what to do with ${filePath}…`}
                {...(onSelectIssue !== undefined
                  ? {
                      onSelectIssue: (n: number) => {
                        onSelectIssue(n);
                        onClose();
                      },
                    }
                  : {})}
              />
            </>
          ) : (
            worktrees.map((wt, idx) => (
              <WorktreeDiffCard
                key={wt}
                worktreePath={wt}
                filePath={filePath}
                defaultOpen={idx === 0}
                diffMode={diffPrefs.mode}
                ignoreWhitespace={diffPrefs.ignoreWhitespace}
                expandTick={expandTick}
                collapseTick={collapseTick}
                {...(onSelectIssue !== undefined
                  ? {
                      onSelectIssue: (n: number) => {
                        onSelectIssue(n);
                        onClose();
                      },
                    }
                  : {})}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
