import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  createWorktree as defaultCreateWorktree,
  defaultBranchName,
  defaultWorktreePath,
  DEFAULT_GRACEFUL_TIMEOUT_MS,
  setAcpWorkspaceCommand,
  stampWorktreeIdentity as defaultStampWorktreeIdentity,
  inspectToolUse,
  startAgentRun as defaultStartAgentRun,
  type AgentRunHandle,
  type ContainmentEscape,
  type CreateWorktreeInput,
  type StampWorktreeIdentityInput,
  type StampWorktreeIdentityResult,
  type StartAgentRunOptions,
  type StreamEvent,
  type Worktree,
} from '@kanbots/dispatcher';
import type { AgentEvent, AgentRun, AgentRunStatus, Card, Store } from '@kanbots/local-store';
import { BRIEFING_MARKER, renderSiblingBriefing } from './sibling-briefing.js';
import {
  describeReapOutcome,
  reapOrphanProcess,
  type ReapOptions,
  type ReapOutcome,
} from './reap-orphans.js';

const DEFAULT_DECISION_PROMPT = `When you need a decision from the user before continuing, end your turn with a fenced code block:

\`\`\`kanbots-decision
{
  "question": "the question you want answered",
  "options": [
    {"value": "a", "label": "Option A"},
    {"value": "b", "label": "Option B"}
  ]
}
\`\`\`

After emitting the block, end your turn (do not continue working). The user will pick an option and you will resume with their choice provided as the next user message.`;

export type ContainmentMode = 'off' | 'warn' | 'pause';

export interface CreateSupervisorOptions {
  store: Store;
  /**
   * Working directory for agent runs. Pass a string for a fixed workspace,
   * or a function for the device-chat supervisor whose cwd follows whichever
   * workspace (local or cloud-bound) is currently active.
   */
  repoPath: string | (() => string);
  startAgentRun?: (opts: StartAgentRunOptions) => AgentRunHandle;
  createWorktree?: (input: CreateWorktreeInput) => Promise<Worktree>;
  stampWorktreeIdentity?: (
    input: StampWorktreeIdentityInput,
  ) => Promise<StampWorktreeIdentityResult>;
  prepareWorktreeDir?: (path: string) => Promise<void>;
  appendSystemPromptDefault?: string;
  /**
   * Default per-run cost budget in USD. When a run is started without an
   * explicit costBudgetUsd, this default is applied. The supervisor stops
   * a run as soon as agent_runs.total_cost_usd >= budget. Cap is best-effort:
   * it fires between turns (on `result` events), so a long in-flight tool
   * call can overshoot. Pass a function to read it dynamically (so changes
   * to workspace defaults take effect on subsequent runs).
   */
  defaultRunCostBudgetUsd?: number | null | (() => number | null | undefined);
  /**
   * Workspace-wide rules prepended to the system prompt of every run started
   * via the supervisor (issue runs, chat runs, autopilot child runs). Pass a
   * function to read it dynamically so edits take effect on the next run. An
   * empty/whitespace-only value is treated as "no rules".
   */
  houseRules?: string | null | (() => string | null | undefined);
  /**
   * Shell-style command invoked by the ACP adapter when the user selects the
   * `acp` provider. The supervisor reads this just before spawning and
   * forwards it to the dispatcher via `setAcpWorkspaceCommand`, so the user
   * can change it from Settings without restarting the desktop app. When
   * unset/empty the dispatcher falls back to `KANBOTS_ACP_COMMAND`, then to
   * the documented Gemini default. Pass a function to read it dynamically.
   */
  acpCommand?: string | null | (() => string | null | undefined);
  onRunComplete?: (run: AgentRun) => Promise<void> | void;
  /**
   * Maximum time to wait after SIGTERM before escalating to SIGKILL during stop().
   * The supervisor's stop() Promise is also bounded by this (plus a small slack)
   * so callers cannot deadlock on an unkillable child.
   */
  stopGracefulTimeoutMs?: number;
  /** Test seam: override pid liveness/comm/kill behaviour for reaping orphans. */
  reapOverrides?: Partial<ReapOptions>;
  /** How to react when an agent's tool_use targets a path outside its
   *  worktree. Default: 'warn'. */
  containmentMode?: ContainmentMode;
  onRunStatusChange?: (run: AgentRun) => Promise<void> | void;
}

const STOP_FORCE_RESOLVE_SLACK_MS = 2_000;

export interface StartRunInput {
  threadId: number;
  issueNumber: number;
  prompt: string;
  appendSystemPrompt?: string;
  model?: string;
  provider?: import('@kanbots/dispatcher').AgentRunProvider;
  costBudgetUsd?: number | null;
  /** Persona id when dispatched via autopilot. Recorded on agent_runs for
   *  per-persona analytics. */
  personaId?: string;
  /** Coarse classification (e.g. `feat`, `bug`) derived from issue labels at
   *  dispatch. Used to bucket runs in the analytics dashboard. */
  cardKind?: string;
  /** Raw issue body length captured at dispatch — used to compute the
   *  card_size_bucket and kept around so thresholds can be re-tuned without
   *  losing history. */
  issueBodyChars?: number;
  /**
   * Which workspace repo to base the run's worktree on. When set, the
   * supervisor reads the repo's path from `workspace_repos` instead of
   * falling back to the host-level `repoPath`. Omit to use the workspace's
   * primary repo (which is the host-level repoPath in single-repo setups
   * post-migration 0025). Callers that don't yet know about multi-repo
   * workspaces can keep omitting this and they keep working.
   */
  repoId?: number;
  /**
   * Issue-thread chat-session id when the run was dispatched from the
   * TaskDetailModal reply footer's session dropdown. Persisted on the
   * agent_runs row so the renderer can filter the transcript by session
   * and scope active/latest run lookups per session (see
   * findActiveForChatSession / findLatestForChatSession). NULL for runs
   * dispatched outside the session dropdown (legacy issue replies,
   * drag-to-inProgress, autopilot children).
   */
  chatSessionId?: number;
}

export interface ResumeRunInput {
  runId: number;
  prompt: string;
  appendSystemPrompt?: string;
  costBudgetUsd?: number | null;
}

export interface StartChatInput {
  threadId: number;
  prompt: string;
  appendSystemPrompt?: string;
  model?: string;
  provider?: import('@kanbots/dispatcher').AgentRunProvider;
  costBudgetUsd?: number | null;
  /**
   * Extra args appended to the underlying `claude` invocation. Used by the
   * standalone chat agent to wire its MCP server (`--mcp-config <path>`) so
   * the chat agent can call kanban tools.
   */
  extraArgs?: string[];
  /**
   * Stable env vars added to the agent process. Used to pass the localhost
   * tool-bridge URL + token to the MCP server.
   */
  env?: Record<string, string>;
  /**
   * Chat-session scope for the new run. Stored on the agent_runs row
   * (column `chat_session_id`) so a conversation with multiple parallel
   * sessions can keep their event streams cleanly separated. Distinct
   * from the dispatcher session token recorded in `session_id`.
   */
  chatSessionId?: number;
}

export interface ResumeChatInput {
  runId: number;
  prompt: string;
  appendSystemPrompt?: string;
  costBudgetUsd?: number | null;
  extraArgs?: string[];
  env?: Record<string, string>;
}

export type AgentEventListener = (event: AgentEvent) => void;
export type AgentStatusListener = (status: AgentRunStatus) => void;
export type CardListener = (card: Card) => void;

export interface CooldownState {
  active: boolean;
  until: string | null;
  reason: 'rate_limit' | 'overloaded' | 'quota' | null;
  consecutiveHits: number;
  message: string | null;
}

export type CooldownListener = (state: CooldownState) => void;

export class RateLimitedError extends Error {
  readonly code = 'RATE_LIMITED' as const;
  readonly cooldown: CooldownState;
  constructor(cooldown: CooldownState) {
    super(
      `Claude API in cooldown (${cooldown.reason ?? 'rate_limit'}); resumes at ${
        cooldown.until ?? 'unknown'
      }`,
    );
    this.name = 'RateLimitedError';
    this.cooldown = cooldown;
  }
}

const COOLDOWN_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
const COOLDOWN_MAX_MS = 300_000;

export interface AgentSupervisor {
  start(input: StartRunInput): Promise<AgentRun>;
  resume(input: ResumeRunInput): Promise<AgentRun>;
  startChat(input: StartChatInput): Promise<AgentRun>;
  resumeChat(input: ResumeChatInput): Promise<AgentRun>;
  stop(runId: number): Promise<AgentRun>;
  getRun(runId: number): AgentRun | null;
  listEvents(runId: number, sinceSeq?: number): AgentEvent[];
  listCards(runId: number): Card[];
  isActive(runId: number): boolean;
  subscribe(
    runId: number,
    onEvent: AgentEventListener,
    onStatus: AgentStatusListener,
    onCard?: CardListener,
  ): () => void;
  getCooldown(): CooldownState;
  subscribeCooldown(listener: CooldownListener): () => void;
  waitForCooldown(signal?: AbortSignal): Promise<void>;
}

interface ActiveRun {
  handle: AgentRunHandle;
  hasDecision: boolean;
  pendingMessageId: number | null;
  threadId: number;
  worktreePath: string | null;
  containmentPaused: boolean;
  /**
   * Cumulative cost as observed across `result` stream events. The dispatcher
   * emits one `result` per turn; a single `claude -p` process typically emits
   * one. We accumulate so resumed sessions stay bounded.
   */
  costSoFarUsd: number;
  budgetUsd: number | null;
  budgetExceeded: boolean;
}

const ACTIVE_STATUSES: ReadonlyArray<AgentRunStatus> = ['starting', 'running', 'awaiting_input'];

export interface ThreadAlreadyActiveError extends Error {
  name: 'AlreadyActive';
  run: AgentRun;
}

export function isThreadAlreadyActiveError(err: unknown): err is ThreadAlreadyActiveError {
  return err instanceof Error && err.name === 'AlreadyActive' && 'run' in err;
}

function threadAlreadyActiveError(run: AgentRun): ThreadAlreadyActiveError {
  const err = new Error(
    `agent run #${run.id} is already ${run.status} on thread ${run.threadId}`,
  ) as ThreadAlreadyActiveError;
  err.name = 'AlreadyActive';
  err.run = run;
  return err;
}

export async function createSupervisor(opts: CreateSupervisorOptions): Promise<AgentSupervisor> {
  const { store } = opts;
  const resolveRepoPath = (): string =>
    typeof opts.repoPath === 'function' ? opts.repoPath() : opts.repoPath;
  const startAgent = opts.startAgentRun ?? defaultStartAgentRun;
  const makeWorktree = opts.createWorktree ?? defaultCreateWorktree;
  const stampIdentity = opts.stampWorktreeIdentity ?? defaultStampWorktreeIdentity;
  const prepareDir = opts.prepareWorktreeDir ?? defaultPrepareDir;
  const decisionInstructions = opts.appendSystemPromptDefault ?? DEFAULT_DECISION_PROMPT;
  const stopGracefulTimeoutMs = opts.stopGracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS;
  const containmentMode: ContainmentMode = opts.containmentMode ?? 'warn';

  function readDefaultBudget(): number | null {
    const raw = opts.defaultRunCostBudgetUsd;
    if (typeof raw === 'function') {
      const value = raw();
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
    }
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
    return null;
  }

  /**
   * Push the workspace-configured ACP command into the dispatcher adapter
   * just before spawning. Always called (regardless of provider) so changes
   * are observed promptly; non-ACP runs ignore the override entirely.
   */
  function applyAcpWorkspaceCommand(): void {
    const raw = opts.acpCommand;
    let value: string | null | undefined;
    if (typeof raw === 'function') {
      value = raw();
    } else {
      value = raw;
    }
    if (value === undefined || value === null) {
      setAcpWorkspaceCommand(null);
      return;
    }
    const trimmed = value.trim();
    setAcpWorkspaceCommand(trimmed.length > 0 ? trimmed : null);
  }

  function resolveBudget(explicit: number | null | undefined): number | null {
    if (explicit === null) return null;
    if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
      return explicit;
    }
    return readDefaultBudget();
  }

  // Falls back to the workspace default provider so dispatch surfaces that
  // don't expose a picker (drag-to-inProgress, autopilot kickoff) honor the
  // user's choice. If neither is set, we keep claude-code as the safety net.
  function resolveProvider(
    explicit: import('@kanbots/dispatcher').AgentRunProvider | undefined,
  ): import('@kanbots/dispatcher').AgentRunProvider {
    if (explicit) return explicit;
    try {
      const def = store.providerSettings.get().defaultProvider;
      if (
        def === 'claude-code' ||
        def === 'codex-cli' ||
        def === 'gemini-cli' ||
        def === 'amp-cli' ||
        def === 'cursor-cli' ||
        def === 'copilot-cli' ||
        def === 'opencode-cli' ||
        def === 'droid-cli' ||
        def === 'ccr-cli' ||
        def === 'qwen-cli' ||
        def === 'acp'
      ) {
        return def;
      }
    } catch {
      // settings row may not exist on first run — fall through
    }
    return 'claude-code';
  }

  // Any 'starting'/'running' rows on construction belong to a previous app
  // process — the supervisor's in-memory handles don't survive restart, so
  // those runs are by definition dead. Before flipping their DB rows to
  // 'failed', try to actually kill the OS-level child processes whose pids we
  // recorded; otherwise they keep mutating their worktree behind our back.
  await reapPreviousGenerationOrphans(store, opts.reapOverrides);
  store.cards.dismissOrphanPendingDecisions();

  const active = new Map<number, ActiveRun>();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  const eventChannel = (runId: number): string => `event:${runId}`;
  const statusChannel = (runId: number): string => `status:${runId}`;
  const cardChannel = (runId: number): string => `card:${runId}`;
  const COOLDOWN_CHANNEL = 'cooldown:changed';

  let cooldownUntilMs: number | null = null;
  let cooldownReason: CooldownState['reason'] = null;
  let cooldownMessage: string | null = null;
  let consecutiveHits = 0;
  let cooldownClearTimer: NodeJS.Timeout | null = null;

  function snapshotCooldown(): CooldownState {
    const now = Date.now();
    const active = cooldownUntilMs !== null && cooldownUntilMs > now;
    return {
      active,
      until: active && cooldownUntilMs !== null ? new Date(cooldownUntilMs).toISOString() : null,
      reason: active ? cooldownReason : null,
      consecutiveHits,
      message: active ? cooldownMessage : null,
    };
  }

  function emitCooldown(): void {
    emitter.emit(COOLDOWN_CHANNEL, snapshotCooldown());
  }

  function applyRateLimit(
    reason: CooldownState['reason'],
    retryAfterMs: number | null,
    message: string,
  ): void {
    consecutiveHits += 1;
    const backoffIdx = Math.min(consecutiveHits - 1, COOLDOWN_BACKOFF_MS.length - 1);
    const backoff = COOLDOWN_BACKOFF_MS[backoffIdx] ?? COOLDOWN_MAX_MS;
    const ms = Math.min(
      COOLDOWN_MAX_MS,
      retryAfterMs !== null && retryAfterMs > 0 ? retryAfterMs : backoff,
    );
    const candidate = Date.now() + ms;
    if (cooldownUntilMs === null || candidate > cooldownUntilMs) {
      cooldownUntilMs = candidate;
    }
    cooldownReason = reason ?? 'rate_limit';
    cooldownMessage = message;
    if (cooldownClearTimer) {
      clearTimeout(cooldownClearTimer);
      cooldownClearTimer = null;
    }
    cooldownClearTimer = setTimeout(
      () => {
        cooldownClearTimer = null;
        emitCooldown();
      },
      Math.max(0, (cooldownUntilMs ?? Date.now()) - Date.now()) + 50,
    );
    emitCooldown();
  }

  function clearCooldownOnSuccess(): void {
    if (consecutiveHits === 0) return;
    consecutiveHits = 0;
    if (cooldownUntilMs !== null && cooldownUntilMs <= Date.now()) {
      cooldownUntilMs = null;
      cooldownReason = null;
      cooldownMessage = null;
      emitCooldown();
    }
  }

  function getCooldown(): CooldownState {
    return snapshotCooldown();
  }

  function subscribeCooldown(listener: CooldownListener): () => void {
    const wrap = (s: CooldownState): void => listener(s);
    emitter.on(COOLDOWN_CHANNEL, wrap);
    return () => {
      emitter.off(COOLDOWN_CHANNEL, wrap);
    };
  }

  function waitForCooldown(signal?: AbortSignal): Promise<void> {
    const state = snapshotCooldown();
    if (!state.active) return Promise.resolve();
    if (signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const cleanup = (): void => {
        if (settled) return;
        settled = true;
        emitter.off(COOLDOWN_CHANNEL, onChange);
        signal?.removeEventListener('abort', onAbort);
      };
      const onChange = (s: CooldownState): void => {
        if (!s.active) {
          cleanup();
          resolve();
        }
      };
      const onAbort = (): void => {
        cleanup();
        resolve();
      };
      emitter.on(COOLDOWN_CHANNEL, onChange);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function readHouseRules(): string | null {
    const raw = opts.houseRules;
    const value = typeof raw === 'function' ? raw() : raw;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function composeSystemPrompt(
    currentRunId: number,
    extra: string | undefined,
  ): { prompt: string; briefing: string | null } {
    const briefing = renderSiblingBriefing(store, currentRunId);
    const houseRules = readHouseRules();
    const learnings = collectLearningsForRun(currentRunId);
    const parts: string[] = [];
    if (houseRules) {
      parts.push(`WORKSPACE_RULES — apply to every turn:\n${houseRules}`);
    }
    parts.push(decisionInstructions);
    if (learnings) parts.push(learnings);
    if (briefing) parts.push(briefing);
    if (extra) parts.push(extra);
    return { prompt: parts.join('\n\n'), briefing };
  }

  /** Pull top-N learnings for the run's repo and format them as a system
   *  block. Bumps use_count on the injected entries so the recency-decayed
   *  ranker rotates between them over time. Returns null when the repo has
   *  no learnings yet. */
  function collectLearningsForRun(runId: number): string | null {
    const run = store.agentRuns.findById(runId);
    if (!run) return null;
    const thread = store.threads.findById(run.threadId);
    if (!thread) return null;
    const entries = store.learnings.listForInjection({
      repoOwner: thread.repoOwner,
      repoName: thread.repoName,
    });
    if (entries.length === 0) return null;
    const lines = entries.map(
      (e) => `[${e.tag}] ${e.content}${e.sourceRunId ? ` (run #${e.sourceRunId})` : ''}`,
    );
    store.learnings.bumpUsage(entries.map((e) => e.id));
    return [
      'LEARNED_FROM_PRIOR_RUNS — durable lessons distilled from earlier runs in this repo. Treat as hints (not hard rules); apply when relevant:',
      ...lines,
    ].join('\n');
  }

  function persistBriefing(runId: number, briefing: string | null): void {
    if (!briefing) return;
    store.events.append({
      agentRunId: runId,
      type: 'text',
      payload: { text: `${BRIEFING_MARKER}\n${briefing}` },
    });
  }

  function ensureAgentMessage(threadId: number, runId: number, body: string): number {
    const existing = active.get(runId);
    if (existing && existing.pendingMessageId !== null) {
      return existing.pendingMessageId;
    }
    const msg = store.messages.create({
      threadId,
      role: 'agent',
      body,
      agentRunId: runId,
    });
    if (existing) existing.pendingMessageId = msg.id;
    return msg.id;
  }

  function findActiveRunForThread(threadId: number): AgentRun | null {
    for (const [runId, entry] of active) {
      if (entry.threadId === threadId) {
        const row = store.agentRuns.findById(runId);
        if (row) return row;
      }
    }
    // Cross-check the DB so the guard survives a restart sweep window where
    // the in-memory `active` map is empty but rows might still be in an
    // active status (e.g. 'awaiting_input' is intentionally left alone by
    // the restart sweep).
    return store.agentRuns.findActiveForThread(threadId);
  }

  function wireHandle(run: AgentRun, handle: AgentRunHandle): void {
    const entry: ActiveRun = {
      handle,
      hasDecision: false,
      pendingMessageId: null,
      threadId: run.threadId,
      worktreePath: run.worktreePath,
      containmentPaused: false,
      costSoFarUsd: run.totalCostUsd ?? 0,
      budgetUsd: run.costBudgetUsd ?? null,
      budgetExceeded: false,
    };
    active.set(run.id, entry);

    handle.on('event', (streamEvent: StreamEvent) => {
      if (streamEvent.kind === 'rate_limit') {
        applyRateLimit(streamEvent.reason, streamEvent.retryAfterMs, streamEvent.message);
        const persistedRl = store.events.append({
          agentRunId: run.id,
          type: 'error',
          payload: {
            message: streamEvent.message,
            rateLimit: true,
            reason: streamEvent.reason,
            retryAfterMs: streamEvent.retryAfterMs,
          },
        });
        emitter.emit(eventChannel(run.id), persistedRl);
        return;
      }
      if (streamEvent.kind === 'session') {
        store.agentRuns.update(run.id, {
          sessionId: streamEvent.sessionId,
          ...(streamEvent.model !== null ? { model: streamEvent.model } : {}),
        });
        return;
      }
      if (streamEvent.kind === 'result') {
        // Best-effort cost cap: total_cost_usd only arrives at turn boundaries,
        // so a runaway tool call within a turn can overshoot before we get a
        // chance to stop. Acceptable tradeoff for between-turn enforcement.
        if (streamEvent.totalCostUsd !== null) {
          entry.costSoFarUsd += streamEvent.totalCostUsd;
          store.agentRuns.update(run.id, { totalCostUsd: entry.costSoFarUsd });
        }
        if (
          !entry.budgetExceeded &&
          entry.budgetUsd !== null &&
          entry.costSoFarUsd >= entry.budgetUsd
        ) {
          entry.budgetExceeded = true;
          store.agentRuns.update(run.id, {
            exitReason: `cost budget exceeded ($${entry.costSoFarUsd.toFixed(4)} / $${entry.budgetUsd.toFixed(2)})`,
          });
          try {
            entry.handle.stop();
          } catch {
            // best-effort
          }
        }
        return;
      }
      if (streamEvent.kind === 'decision') {
        const messageId = ensureAgentMessage(
          run.threadId,
          run.id,
          formatDecisionMessage(streamEvent.question),
        );
        const card = store.cards.create({
          messageId,
          type: 'decision',
          payload: {
            question: streamEvent.question,
            options: streamEvent.options,
          },
        });
        entry.hasDecision = true;
        emitter.emit(cardChannel(run.id), card);
        return;
      }
      if (
        streamEvent.kind === 'tool_use' &&
        containmentMode !== 'off' &&
        entry.worktreePath !== null &&
        !entry.containmentPaused
      ) {
        const verdict = inspectToolUse({
          worktreePath: entry.worktreePath,
          name: streamEvent.name,
          input: streamEvent.input,
        });
        if (verdict.kind === 'escape') {
          handleContainmentEscape(run, entry, streamEvent.name, verdict);
        }
      }
      if (streamEvent.kind === 'diff_hunk' && !streamEvent.needsReconcile) {
        // Persist the hunk for the live diff panel + reject mechanics.
        // The unique snapshot_id index makes this idempotent across replays.
        store.diffHunks.append({
          agentRunId: run.id,
          filePath: streamEvent.filePath,
          opIndex: streamEvent.opIndex,
          mode: streamEvent.mode,
          beforeText: streamEvent.before,
          afterText: streamEvent.after,
        });
      }
      const persisted = persistEvent(store, run.id, streamEvent);
      if (persisted) emitter.emit(eventChannel(run.id), persisted);
    });

    handle.on('close', (summary) => {
      const naturalStatus: AgentRunStatus = summary.killedByStop
        ? 'stopped'
        : summary.result?.isError === true
          ? 'failed'
          : summary.exitCode === 0
            ? 'complete'
            : 'failed';
      const budgetReason = entry.budgetExceeded
        ? `cost budget exceeded ($${entry.costSoFarUsd.toFixed(4)} / $${(entry.budgetUsd ?? 0).toFixed(2)})`
        : null;
      const status: AgentRunStatus = budgetReason
        ? 'stopped'
        : entry.hasDecision && naturalStatus === 'complete'
          ? 'awaiting_input'
          : naturalStatus;
      const exitDetail = (summary.stderr.trim() || summary.result?.text.trim() || '').trim();
      const exitReason = budgetReason
        ? `interrupted: ${budgetReason}`
        : summary.killedByStop
          ? summary.stopEscalation === 'sigkill'
            ? `stopped by user (SIGKILL after ${stopGracefulTimeoutMs}ms)`
            : 'stopped by user'
          : summary.exitCode !== 0
            ? `exit code ${summary.exitCode ?? 'null'}${exitDetail ? `: ${truncate(exitDetail, 500)}` : ''}`
            : summary.result?.isError === true
              ? truncate(exitDetail || 'agent reported an error', 500)
              : null;

      // Terminal classification recorded for analytics + memory curator.
      // Awaiting-input is non-terminal so we leave success_signal alone there;
      // promotion can later upgrade `completed_clean` → `promoted`, and a
      // failed check can downgrade it to `completed_with_failed_checks`.
      const successSignal: import('@kanbots/local-store').SuccessSignal | null =
        status === 'awaiting_input'
          ? null
          : entry.budgetExceeded
            ? 'aborted_budget'
            : summary.killedByStop
              ? 'stopped'
              : status === 'failed'
                ? 'failed'
                : status === 'complete'
                  ? 'completed_clean'
                  : null;

      const updated = store.agentRuns.update(run.id, {
        status,
        endedAt: status === 'awaiting_input' ? null : new Date().toISOString(),
        pid: null,
        stopEscalation: summary.stopEscalation,
        ...(summary.result?.tokenUsage
          ? {
              tokenUsageInput: summary.result.tokenUsage.input,
              tokenUsageOutput: summary.result.tokenUsage.output,
            }
          : {}),
        // Cumulative cost is already tracked across `result` events; only
        // backfill from the final summary if we never saw a result event.
        ...(entry.costSoFarUsd === 0 &&
        summary.result?.totalCostUsd !== undefined &&
        summary.result?.totalCostUsd !== null
          ? { totalCostUsd: summary.result.totalCostUsd }
          : {}),
        ...(summary.result?.durationMs !== undefined && summary.result?.durationMs !== null
          ? { durationMs: summary.result.durationMs }
          : {}),
        ...(exitReason !== null ? { exitReason } : {}),
        ...(successSignal !== null ? { successSignal } : {}),
      });
      if (status !== 'awaiting_input') {
        store.cards.dismissPendingDecisionsForRun(run.id);
      }
      active.delete(run.id);
      if (status === 'complete') clearCooldownOnSuccess();
      // Mirror the terminal status onto the owning chat_session so the
      // multi-session dropdown's status dot reflects the run's outcome.
      // 'starting'/'running' map to 'running'; awaiting_input is its own
      // first-class session state; complete → 'completed'; everything
      // else (failed/stopped/budget) lands as 'failed'.
      if (updated.chatSessionId !== null) {
        const sessionStatus =
          status === 'awaiting_input'
            ? 'awaiting_input'
            : status === 'complete'
              ? 'completed'
              : 'failed';
        store.chatSessions.setStatus(updated.chatSessionId, sessionStatus);
      }
      emitter.emit(statusChannel(run.id), updated.status);
      if (status === 'complete' && opts.onRunComplete) {
        void Promise.resolve(opts.onRunComplete(updated)).catch(() => {
          // best-effort hook; failures must not crash the supervisor
        });
      }
      if (opts.onRunStatusChange) {
        void Promise.resolve(opts.onRunStatusChange(updated)).catch(() => {
          // best-effort hook; failures must not crash the supervisor
        });
      }
    });

    handle.on('error', (err) => {
      const errEvent = store.events.append({
        agentRunId: run.id,
        type: 'error',
        payload: { message: err.message },
      });
      emitter.emit(eventChannel(run.id), errEvent);
    });
  }

  function handleContainmentEscape(
    run: AgentRun,
    entry: ActiveRun,
    toolName: string,
    escape: ContainmentEscape,
  ): void {
    const payload = {
      tool: toolName,
      reason: escape.reason,
      paths: escape.paths,
      heuristic: escape.heuristic,
      mode: containmentMode,
    };
    const ev = store.events.append({
      agentRunId: run.id,
      type: 'containment_warning',
      payload,
    });
    emitter.emit(eventChannel(run.id), ev);
    if (containmentMode !== 'pause') return;

    entry.containmentPaused = true;
    const question =
      `Agent attempted ${toolName} outside its worktree (${escape.paths.join(', ')}). ` +
      'Allow the run to resume?';
    const messageId = ensureAgentMessage(
      run.threadId,
      run.id,
      `Containment alert: ${escape.reason}. Paths: ${escape.paths.join(', ')}`,
    );
    const card = store.cards.create({
      messageId,
      type: 'decision',
      payload: {
        question,
        options: [
          { value: 'resume', label: 'Resume run' },
          { value: 'stop', label: 'Stop run' },
        ],
      },
    });
    entry.hasDecision = true;
    emitter.emit(cardChannel(run.id), card);
    try {
      entry.handle.stop();
    } catch {
      // best-effort: handle.stop already idempotent
    }
  }

  async function startChat(input: StartChatInput): Promise<AgentRun> {
    // When the conversation has a session active on a *different* session
    // a parallel session on the same conversation must be free to spawn,
    // so we scope the conflict check to the session when one is provided
    // and fall back to the thread-wide check otherwise (kept for
    // legacy issue-style chats that don't ride on sessions yet).
    if (input.chatSessionId !== undefined) {
      const sessionActive = store.agentRuns.findActiveForChatSession(input.chatSessionId);
      if (sessionActive !== null) {
        throw threadAlreadyActiveError(sessionActive);
      }
    } else {
      const conflicting = findActiveRunForThread(input.threadId);
      if (conflicting !== null) {
        throw threadAlreadyActiveError(conflicting);
      }
    }
    const cd = snapshotCooldown();
    if (cd.active) throw new RateLimitedError(cd);
    let run = store.agentRuns.create({
      threadId: input.threadId,
      status: 'starting',
      ...(input.chatSessionId !== undefined ? { chatSessionId: input.chatSessionId } : {}),
    });
    const budget = resolveBudget(input.costBudgetUsd);
    const provider = resolveProvider(input.provider);
    run = store.agentRuns.update(run.id, {
      ...(input.model !== undefined ? { model: input.model } : {}),
      provider,
      ...(budget !== null ? { costBudgetUsd: budget } : {}),
    });
    store.threads.setLastModel(input.threadId, provider, input.model ?? null);
    const composed = composeSystemPrompt(run.id, input.appendSystemPrompt);
    persistBriefing(run.id, composed.briefing);
    applyAcpWorkspaceCommand();
    const handle = startAgent({
      cwd: resolveRepoPath(),
      prompt: input.prompt,
      appendSystemPrompt: composed.prompt,
      ...(input.model !== undefined ? { model: input.model } : {}),
      provider,
      ...(input.extraArgs !== undefined ? { extraArgs: input.extraArgs } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
    });
    run = store.agentRuns.update(run.id, {
      status: 'running',
      pid: handle.pid,
    });
    if (run.chatSessionId !== null) {
      store.chatSessions.setStatus(run.chatSessionId, 'running');
    }
    wireHandle(run, handle);
    return run;
  }

  async function resumeChat(input: ResumeChatInput): Promise<AgentRun> {
    const cd = snapshotCooldown();
    if (cd.active) throw new RateLimitedError(cd);
    const existing = store.agentRuns.findById(input.runId);
    if (!existing) throw new Error(`agent run ${input.runId} not found`);
    if (active.has(input.runId)) {
      throw new Error(`agent run ${input.runId} is already active`);
    }
    // Multi-session chats can host parallel runs on the same thread —
    // one per chat_session. Scope the conflict check to the run's own
    // session when it has one so a busy sibling session doesn't block
    // resume here. Issue-style threads (chatSessionId NULL) still use
    // the thread-wide check below.
    if (existing.chatSessionId !== null) {
      const sessionActive = store.agentRuns.findActiveForChatSession(existing.chatSessionId);
      if (sessionActive !== null && sessionActive.id !== input.runId) {
        throw threadAlreadyActiveError(sessionActive);
      }
    } else {
      const conflicting = findActiveRunForThread(existing.threadId);
      if (conflicting !== null && conflicting.id !== input.runId) {
        throw threadAlreadyActiveError(conflicting);
      }
    }
    if (!existing.sessionId) {
      throw new Error(`agent run ${input.runId} has no session_id to resume`);
    }
    const composed = composeSystemPrompt(input.runId, input.appendSystemPrompt);
    persistBriefing(input.runId, composed.briefing);
    applyAcpWorkspaceCommand();
    const handle = startAgent({
      cwd: resolveRepoPath(),
      prompt: input.prompt,
      resumeFromSessionId: existing.sessionId,
      appendSystemPrompt: composed.prompt,
      // Resume always reuses the original provider; non-claude-code can't
      // produce a sessionId today, so this guard is implicit.
      ...(existing.provider
        ? { provider: existing.provider as import('@kanbots/dispatcher').AgentRunProvider }
        : {}),
      ...(input.extraArgs !== undefined ? { extraArgs: input.extraArgs } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
    });
    const run = store.agentRuns.update(input.runId, {
      status: 'running',
      endedAt: null,
      exitReason: null,
      pid: handle.pid,
      ...(input.costBudgetUsd !== undefined ? { costBudgetUsd: input.costBudgetUsd } : {}),
    });
    if (run.chatSessionId !== null) {
      store.chatSessions.setStatus(run.chatSessionId, 'running');
    }
    wireHandle(run, handle);
    emitter.emit(statusChannel(run.id), run.status);
    return run;
  }

  async function start(input: StartRunInput): Promise<AgentRun> {
    // Issue-thread chat sessions can host parallel runs on the same
    // thread (one per session), so scope the conflict check to the
    // session when one is provided — mirrors the startChat path.
    if (input.chatSessionId !== undefined) {
      const sessionActive = store.agentRuns.findActiveForChatSession(input.chatSessionId);
      if (sessionActive !== null) {
        throw threadAlreadyActiveError(sessionActive);
      }
    } else {
      const conflicting = findActiveRunForThread(input.threadId);
      if (conflicting !== null) {
        throw threadAlreadyActiveError(conflicting);
      }
    }
    const cd = snapshotCooldown();
    if (cd.active) throw new RateLimitedError(cd);
    let run = store.agentRuns.create({
      threadId: input.threadId,
      status: 'starting',
      ...(input.chatSessionId !== undefined ? { chatSessionId: input.chatSessionId } : {}),
    });
    const branch = defaultBranchName({
      issueNumber: input.issueNumber,
      runId: run.id,
    });
    // Multi-repo: when the caller passes a workspace_repos.id, the run
    // worktrees against that repo's path instead of the host-level
    // default. Falls back silently to the host repoPath if the id is
    // unknown — caller-facing validation lives in the IPC handlers, the
    // supervisor stays permissive.
    let repoPath = resolveRepoPath();
    if (input.repoId !== undefined) {
      const repoRow = store.workspaceRepos.findById(input.repoId);
      if (repoRow) repoPath = repoRow.repoPath;
    }
    const worktreePath = defaultWorktreePath({
      repoPath,
      issueNumber: input.issueNumber,
      runId: run.id,
    });
    // Persist branch + worktree before the slow worktree-creation awaits so
    // that any `listActiveForRepo` read during that window sees a row with
    // branchName populated, not null.
    run = store.agentRuns.update(run.id, { worktreePath, branchName: branch });

    try {
      await prepareDir(worktreePath);
      await makeWorktree({ repoPath, branch, worktreePath });
      await stampIdentity({
        worktreePath,
        runId: run.id,
        issueNumber: input.issueNumber,
      });
    } catch (err) {
      run = store.agentRuns.update(run.id, {
        status: 'failed',
        endedAt: new Date().toISOString(),
        exitReason: `worktree: ${err instanceof Error ? err.message : String(err)}`,
      });
      return run;
    }

    const budget = resolveBudget(input.costBudgetUsd);
    const provider = resolveProvider(input.provider);
    run = store.agentRuns.update(run.id, {
      ...(input.model !== undefined ? { model: input.model } : {}),
      provider,
      ...(budget !== null ? { costBudgetUsd: budget } : {}),
      ...(input.personaId !== undefined ? { personaId: input.personaId } : {}),
      ...(input.cardKind !== undefined ? { cardKind: input.cardKind } : {}),
      ...(input.issueBodyChars !== undefined
        ? {
            issueBodyChars: input.issueBodyChars,
            cardSizeBucket: computeCardSizeBucket(input.issueBodyChars),
          }
        : {}),
    });
    // Persist last-used model on the thread for the model picker default.
    store.threads.setLastModel(input.threadId, provider, input.model ?? null);

    const composed = composeSystemPrompt(run.id, input.appendSystemPrompt);
    persistBriefing(run.id, composed.briefing);
    applyAcpWorkspaceCommand();
    const handle = startAgent({
      cwd: worktreePath,
      prompt: input.prompt,
      appendSystemPrompt: composed.prompt,
      ...(input.model !== undefined ? { model: input.model } : {}),
      provider,
    });

    run = store.agentRuns.update(run.id, {
      status: 'running',
      pid: handle.pid,
    });
    if (run.chatSessionId !== null) {
      store.chatSessions.setStatus(run.chatSessionId, 'running');
    }
    wireHandle(run, handle);
    return run;
  }

  async function resume(input: ResumeRunInput): Promise<AgentRun> {
    const cd = snapshotCooldown();
    if (cd.active) throw new RateLimitedError(cd);
    const existing = store.agentRuns.findById(input.runId);
    if (!existing) throw new Error(`agent run ${input.runId} not found`);
    if (active.has(input.runId)) {
      throw new Error(`agent run ${input.runId} is already active`);
    }
    const conflicting = findActiveRunForThread(existing.threadId);
    if (conflicting !== null && conflicting.id !== input.runId) {
      throw threadAlreadyActiveError(conflicting);
    }
    if (!existing.sessionId) {
      throw new Error(`agent run ${input.runId} has no session_id to resume`);
    }
    if (!existing.worktreePath) {
      throw new Error(`agent run ${input.runId} has no worktree`);
    }

    const composed = composeSystemPrompt(input.runId, input.appendSystemPrompt);
    persistBriefing(input.runId, composed.briefing);
    applyAcpWorkspaceCommand();
    const handle = startAgent({
      cwd: existing.worktreePath,
      prompt: input.prompt,
      resumeFromSessionId: existing.sessionId,
      appendSystemPrompt: composed.prompt,
    });

    const run = store.agentRuns.update(input.runId, {
      status: 'running',
      endedAt: null,
      exitReason: null,
      pid: handle.pid,
      ...(input.costBudgetUsd !== undefined ? { costBudgetUsd: input.costBudgetUsd } : {}),
    });
    wireHandle(run, handle);
    emitter.emit(statusChannel(run.id), run.status);
    return run;
  }

  async function stop(runId: number): Promise<AgentRun> {
    const entry = active.get(runId);
    if (entry) {
      entry.handle.stop({ gracefulTimeoutMs: stopGracefulTimeoutMs });
      const forceResolveAt = stopGracefulTimeoutMs + STOP_FORCE_RESOLVE_SLACK_MS;
      let timer: NodeJS.Timeout | null = null;
      const guarded = new Promise<'timeout'>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout('timeout'), forceResolveAt);
        if (timer && typeof timer.unref === 'function') timer.unref();
      });
      const outcome = await Promise.race([entry.handle.done.then(() => 'done' as const), guarded]);
      if (timer) clearTimeout(timer);
      if (outcome === 'timeout' && active.has(runId)) {
        // Child is unkillable (e.g. <defunct> waiting on a zombie parent).
        // Force the run out of an active state so the slot is freed and the
        // caller doesn't deadlock. Clean up the in-memory entry; if the close
        // handler fires later, active.delete will be a no-op.
        active.delete(runId);
        store.agentRuns.update(runId, {
          status: 'stopped',
          endedAt: new Date().toISOString(),
          pid: null,
          exitReason: `stopped by user (forced after ${forceResolveAt}ms; child unresponsive)`,
        });
        store.cards.dismissPendingDecisionsForRun(runId);
        emitter.emit(statusChannel(runId), 'stopped' as AgentRunStatus);
      }
      const run = store.agentRuns.findById(runId);
      if (!run) throw new Error(`agent run ${runId} not found`);
      return run;
    }
    const existing = store.agentRuns.findById(runId);
    if (!existing) throw new Error(`agent run ${runId} not found`);
    if (!ACTIVE_STATUSES.includes(existing.status)) return existing;
    // No live handle but DB still says active — manual escape hatch.
    const updated = store.agentRuns.update(runId, {
      status: 'stopped',
      endedAt: new Date().toISOString(),
      pid: null,
    });
    store.cards.dismissPendingDecisionsForRun(runId);
    emitter.emit(statusChannel(runId), updated.status);
    return updated;
  }

  function getRun(runId: number): AgentRun | null {
    return store.agentRuns.findById(runId);
  }

  function listEvents(runId: number, sinceSeq?: number): AgentEvent[] {
    return store.events.list(runId, sinceSeq !== undefined ? { afterSeq: sinceSeq } : {});
  }

  function listCards(runId: number): Card[] {
    return store.cards.listByRun(runId);
  }

  function isActive(runId: number): boolean {
    if (active.has(runId)) return true;
    const run = store.agentRuns.findById(runId);
    return run !== null && ACTIVE_STATUSES.includes(run.status);
  }

  function subscribe(
    runId: number,
    onEvent: AgentEventListener,
    onStatus: AgentStatusListener,
    onCard?: CardListener,
  ): () => void {
    const eventListener = (e: AgentEvent): void => onEvent(e);
    const statusListener = (s: AgentRunStatus): void => onStatus(s);
    const cardListener = (c: Card): void => onCard?.(c);
    emitter.on(eventChannel(runId), eventListener);
    emitter.on(statusChannel(runId), statusListener);
    if (onCard) emitter.on(cardChannel(runId), cardListener);
    return () => {
      emitter.off(eventChannel(runId), eventListener);
      emitter.off(statusChannel(runId), statusListener);
      if (onCard) emitter.off(cardChannel(runId), cardListener);
    };
  }

  return {
    start,
    resume,
    startChat,
    resumeChat,
    stop,
    getRun,
    listEvents,
    listCards,
    isActive,
    subscribe,
    getCooldown,
    subscribeCooldown,
    waitForCooldown,
  };
}

function persistEvent(store: Store, runId: number, ev: StreamEvent): AgentEvent | null {
  switch (ev.kind) {
    case 'text':
      return store.events.append({
        agentRunId: runId,
        type: 'text',
        payload: { text: ev.text },
      });
    case 'tool_use':
      return store.events.append({
        agentRunId: runId,
        type: 'tool_use',
        payload: { toolUseId: ev.toolUseId, name: ev.name, input: ev.input },
      });
    case 'tool_result':
      return store.events.append({
        agentRunId: runId,
        type: 'tool_result',
        payload: {
          toolUseId: ev.toolUseId,
          isError: ev.isError,
          content: ev.content,
        },
      });
    case 'parse_error':
      return store.events.append({
        agentRunId: runId,
        type: 'error',
        payload: { message: ev.message, raw: ev.raw },
      });
    case 'session':
    case 'decision':
      return null;
    case 'result':
      if (ev.isError && ev.text.trim().length > 0) {
        return store.events.append({
          agentRunId: runId,
          type: 'error',
          payload: { message: ev.text },
        });
      }
      return null;
    case 'rate_limit':
    case 'diff_hunk':
      // diff_hunk events are persisted to the diff_hunks table by the
      // supervisor (not via agent_events) so this branch is intentionally
      // a no-op. Keeping it explicit so a future StreamEvent variant
      // forces a compile error.
      return null;
  }
}

function formatDecisionMessage(question: string): string {
  return `Awaiting decision: ${question}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/** Char-length-to-bucket mapping used as a coarse proxy for task size. The
 *  buckets are static so backfilling can be done at any time using the raw
 *  issue_body_chars column. Tuned for analytics grouping; not load-bearing
 *  for routing decisions. */
export function computeCardSizeBucket(chars: number): string {
  if (chars < 500) return 'xs';
  if (chars < 2_000) return 's';
  if (chars < 8_000) return 'm';
  if (chars < 30_000) return 'l';
  return 'xl';
}

async function defaultPrepareDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

const CLAUDE_COMMAND_HINTS = ['claude'] as const;
// Preview commands are user-defined dev servers (default `pnpm dev`). Match
// the most likely process names a node-based dev server would surface as.
const PREVIEW_COMMAND_HINTS = ['node', 'pnpm', 'npm', 'yarn', 'bun', 'next', 'vite'] as const;

async function reapPreviousGenerationOrphans(
  store: Store,
  overrides: Partial<ReapOptions> | undefined,
): Promise<void> {
  const orphans = store.agentRuns.listOrphans();
  const previewOrphans = store.agentRuns.listPreviewOrphans();

  // Reap claude orphans (rows whose status is starting/running/awaiting_input
  // with a recorded pid). After reaping, mark the row failed with a per-row
  // exit reason describing the outcome.
  await Promise.all(
    orphans.map(async (run) => {
      if (run.pid === null) return;
      const outcome = await reapOrphanProcess(run.pid, {
        expectedCommandSubstrings: CLAUDE_COMMAND_HINTS,
        ...overrides,
      });
      const reason = describeReapOutcome(outcome);
      const patch: Parameters<typeof store.agentRuns.update>[1] = {
        status: 'failed',
        endedAt: new Date().toISOString(),
        pid: null,
        exitReason: reason,
      };
      // If this row also had a preview pid, fold its reaping into the same row
      // update so we don't bounce the UI twice.
      if (run.previewPid !== null) {
        const previewOutcome = await reapPreviewPid(run.previewPid, overrides);
        patch.previewPid = null;
        patch.previewState = 'stopped';
        patch.exitReason = `${reason}; preview ${shortPreviewOutcome(previewOutcome)}`;
      }
      store.agentRuns.update(run.id, patch);
    }),
  );

  // Now sweep any remaining starting/running rows that didn't have a pid (e.g.
  // a run that crashed mid-spawn). These get the generic restart reason.
  store.agentRuns.markStartingRunningAsInterrupted('interrupted: app restart');

  // Reap standalone preview orphans — preview pids attached to rows that are
  // no longer in an active status (e.g. complete runs whose preview was still
  // serving a dev server when the app died).
  const handledIds = new Set(orphans.map((r) => r.id));
  await Promise.all(
    previewOrphans.map(async (run) => {
      if (handledIds.has(run.id)) return;
      if (run.previewPid === null) return;
      const outcome = await reapPreviewPid(run.previewPid, overrides);
      store.agentRuns.update(run.id, {
        previewPid: null,
        previewState: 'stopped',
        previewUrl: null,
      });
      // exitReason is reserved for the run itself; preview lifecycle is
      // already conveyed by previewState. Outcome details are dropped here on
      // purpose to avoid clobbering meaningful run-level reasons.
      void outcome;
    }),
  );
}

async function reapPreviewPid(
  pid: number,
  overrides: Partial<ReapOptions> | undefined,
): Promise<ReapOutcome> {
  return reapOrphanProcess(pid, {
    expectedCommandSubstrings: PREVIEW_COMMAND_HINTS,
    ...overrides,
  });
}

function shortPreviewOutcome(outcome: ReapOutcome): string {
  switch (outcome.kind) {
    case 'reaped':
      return `pid ${outcome.pid} reaped (${outcome.signal})`;
    case 'gone':
      return `pid ${outcome.pid} not running`;
    case 'skipped':
      return `pid ${outcome.pid} skipped`;
    case 'error':
      return `pid ${outcome.pid} reap error`;
  }
}
