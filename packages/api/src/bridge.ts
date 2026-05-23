import type {
  AgentCheck,
  AgentEvent,
  AgentEventType,
  AgentRun,
  AgentRunStatus,
  AutopilotCheckCommand,
  AutopilotChildEntry,
  AutopilotChildKind,
  AutopilotChildStatus,
  AutopilotConfig,
  AutopilotEffort,
  AutopilotKind,
  AutopilotPersonaSnapshot,
  AutopilotPlanningEvent,
  AutopilotPlanningSlot,
  AutopilotSession,
  AutopilotStatus,
  Card,
  CardStatus,
  CardType,
  ChatConversation,
  CheckKind,
  DiffHunk,
  Learning,
  Message,
  PreviewState,
  Role,
  SentryImportStatus,
  SentrySuggestion,
  SentrySuggestionCategory,
  SentrySuggestionConfidence,
  SentrySuggestionVerdict,
} from '@kanbots/local-store';
import type {
  AgentKey,
  Comment,
  CreateIssueInput,
  Issue,
  PullRequest,
  StatusKey,
  UpdateIssuePatch,
} from '@kanbots/core';

export type {
  AgentCheck,
  AgentEvent,
  AgentEventType,
  AgentRun,
  AgentRunStatus,
  AutopilotCheckCommand,
  AutopilotChildEntry,
  AutopilotChildKind,
  AutopilotChildStatus,
  AutopilotConfig,
  AutopilotEffort,
  AutopilotKind,
  AutopilotPersonaSnapshot,
  AutopilotPlanningEvent,
  AutopilotPlanningSlot,
  AutopilotSession,
  AutopilotStatus,
  Card,
  CardStatus,
  CardType,
  ChatConversation,
  CheckKind,
  DiffHunk,
  Learning,
  Message,
  PreviewState,
  Role,
  AgentKey,
  Comment,
  CreateIssueInput,
  Issue,
  StatusKey,
  UpdateIssuePatch,
  SentryImportStatus,
  SentrySuggestion,
  SentrySuggestionCategory,
  SentrySuggestionConfidence,
  SentrySuggestionVerdict,
};

export interface DecisionPayload {
  question: string;
  options: Array<{ value: string; label: string }>;
}

export type ContainmentMode = 'off' | 'warn' | 'pause';

export interface Config {
  owner: string;
  repo: string;
  mode?: 'github' | 'local';
  repoPath?: string;
  authorLogin?: string;
  /** How to react when an agent's tool_use targets a path outside its
   *  worktree. Default: 'warn'. */
  containmentMode?: ContainmentMode;
}

export interface DraftIssueInput {
  description: string;
}

export interface DraftedIssue {
  title: string;
  body: string;
}

export type DraftIssueFn = (input: DraftIssueInput) => Promise<DraftedIssue>;

export type SuggestFeatureEntryStatus =
  | 'backlog'
  | 'todo'
  | 'in-progress'
  | 'in-review'
  | 'done'
  | 'closed'
  | 'unlabeled';

export interface SuggestFeatureBacklogEntry {
  title: string;
  body?: string;
  status?: SuggestFeatureEntryStatus;
  number?: number;
}

export type PlannerEvent =
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'thought'; text: string };

export interface SuggestFeatureInput {
  backlog: SuggestFeatureBacklogEntry[];
  personaPrompt: string;
  provider?: ProviderId;
  /** Free-form scope from the user — narrows the suggestion to a topic, area, or constraint. */
  userNotes?: string;
  onEvent?: (event: PlannerEvent) => void;
}

export type SuggestFeatureFn = (input: SuggestFeatureInput) => Promise<DraftedIssue>;

export interface SentryAnalyzerInput {
  errorType: string | null;
  errorValue: string | null;
  culprit: string | null;
  permalink: string | null;
  environment: string | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
  stackFrames: Array<{
    filename: string | null;
    function: string | null;
    lineno: number | null;
    inApp: boolean;
    contextLine: string | null;
  }>;
  breadcrumbs: Array<{
    timestamp: string | null;
    category: string | null;
    level: string | null;
    message: string | null;
  }>;
}

export type SentryAnalyzerFn = (input: SentryAnalyzerInput) => Promise<SentrySuggestion>;

export type ProviderId = 'claude-code' | 'codex-cli';

export interface ProviderConfigPayload {
  id: ProviderId;
  enabled: boolean;
  hasKey: boolean;
  defaultModel: string | null;
  keyEncryption: 'safe' | 'plain';
  lastValidatedAt: string | null;
  lastError: string | null;
}

export interface ProviderSettingsPayload {
  defaultProvider: ProviderId | null;
  defaultModel: string | null;
}

export interface ProvidersPayload {
  providers: ProviderConfigPayload[];
  settings: ProviderSettingsPayload;
  safeStorageAvailable: boolean;
  /** True iff at least one provider is enabled and has usable credentials. */
  anyConfigured: boolean;
}

export interface ProviderSaveInput {
  id: ProviderId;
  enabled?: boolean;
  defaultModel?: string | null;
  /** New API key in plaintext. If null, clears the stored key. If omitted, keeps existing. */
  apiKey?: string | null;
}

export interface ProviderTestConnectionResult {
  ok: boolean;
  error?: string;
  models?: string[];
}

export interface ProviderSettingsInput {
  defaultProvider?: ProviderId | null;
  defaultModel?: string | null;
}

export interface SentryConfigPayload {
  enabled: boolean;
  orgSlug: string | null;
  projectSlug: string | null;
  hasToken: boolean;
  tokenEncryption: 'safe' | 'plain';
  safeStorageAvailable: boolean;
  pollIntervalSeconds: number;
  environmentFilter: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  consecutiveAuthFailures: number;
}

export interface SentryConfigInput {
  enabled?: boolean;
  orgSlug?: string | null;
  projectSlug?: string | null;
  token?: string | null;
  pollIntervalSeconds?: number;
  environmentFilter?: string | null;
}

export interface SentryTestConnectionResult {
  ok: true;
  project: { slug: string; name: string };
}

export interface SentrySyncResult {
  imported: number;
  updated: number;
  totalSeen: number;
  lastSyncedAt: string;
}

export interface SentryMetaPayload {
  sentryIssueId: string;
  status: SentryImportStatus;
  count: number;
  permalink: string | null;
  culprit: string | null;
  errorType: string | null;
  errorValue: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  analyzedAt: string | null;
  suggestion: SentrySuggestion | null;
}

export interface IssueActiveRunPayload {
  id: number;
  status: AgentRunStatus;
  branch: string | null;
  model: string | null;
  startedAt: string;
  currentTool: string | null;
  currentArg: string | null;
  totalCostUsd: number | null;
  pendingDecision:
    | {
        cardId: number;
        question: string;
        options: Array<{ value: string; label: string }>;
      }
    | null;
  checks: {
    typecheck: 'pass' | 'fail' | 'running' | 'idle';
    tests: 'pass' | 'fail' | 'running' | 'idle';
    lint: 'pass' | 'fail' | 'running' | 'idle';
  } | null;
  previewUrl: string | null;
  previewState: string | null;
  // Reserved for Phase 11 (agent intelligence) — currently unset by the
  // API but exposed so renderer code can light up when populated.
  additions?: number | null;
  deletions?: number | null;
  filesChanged?: number | null;
  progress?: number | null;
  /** Cloud-mode KSUID for the run. Unset in local mode. Set when the
   * issue comes from a cloud project so renderer hooks can open an SSE
   * subscription against /projects/:p/runs/:cloudRunId/stream. */
  cloudRunId?: string;
}

export interface DecoratedIssue extends Issue {
  status: StatusKey | null;
  agent: AgentKey | null;
  activeRun: IssueActiveRunPayload | null;
  sentryMeta: SentryMetaPayload | null;
  /** Cloud-mode KSUID of the most recent run, populated whether or not
   * the run is still active. The detail modal subscribes to this so the
   * SSE endpoint replays the run's events even after it terminates,
   * keeping the thread visible across refreshes. Unset in local mode. */
  cloudLatestRunId?: string;
}

export interface ThreadPayload {
  id: number;
  createdAt: string;
  messages: Message[];
  activeRun: AgentRun | null;
  latestRun: AgentRun | null;
}

export interface IssueDetail {
  issue: DecoratedIssue;
  comments: Comment[];
  thread: ThreadPayload | null;
}

export interface PostMessageResult {
  message: Message;
  thread: ThreadPayload | null;
  dispatchError?: string;
}

export interface DispatchResult {
  run: AgentRun;
  message: Message;
}

export interface SplitResult {
  parent: number;
  children: DecoratedIssue[];
}

export interface ResolveCardResult {
  card: Card;
  run: AgentRun;
}

export interface DismissCardResult {
  card: Card;
  run: AgentRun;
}

export interface ForkRunResult {
  source: number;
  run: AgentRun;
  worktree: string;
  branch: string;
}

export interface RunStatsResult {
  additions: number;
  deletions: number;
  filesChanged: number;
}

export interface PromoteCommitResult {
  commitSha: string;
  base: string;
  cleanup: {
    worktreeRemoved: boolean;
    branchDeleted: boolean;
  };
}

export interface PromotePrResult {
  pr: PullRequest;
}

export interface EventSubscribeResult {
  subscriptionId: string;
  runStatus: AgentRunStatus;
}

export interface CostTodayResult {
  totalUsd: number;
  since: string;
}

export interface CostBreakdownItem {
  workspace: string;
  provider: string;
  totalUsd: number;
}

// Same shape Claude Code's `statusLine` JSON exposes under
// `rate_limits.{five_hour,seven_day}.used_percentage`. Sourced from the
// authenticated OAuth `/usage` endpoint so the values match claude.ai's
// "Plan usage limits" panel exactly.
export interface CostUsageWindow {
  pct: number; // 0..1 utilization
  resetsAt: string | null; // ISO date or null when unknown
}

export interface CostUsageResult {
  fiveHour: CostUsageWindow | null;
  sevenDay: CostUsageWindow | null;
  // 'oauth' = live numbers, 'unauthorized' = token expired (relog required),
  // 'unavailable' = creds missing or endpoint down.
  source: 'oauth' | 'unauthorized' | 'unavailable';
}

export interface CooldownStatePayload {
  active: boolean;
  until: string | null;
  reason: 'rate_limit' | 'overloaded' | 'quota' | null;
  consecutiveHits: number;
  message: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  currentFolderId: string;
}

export interface WorkspaceBudgets {
  runCostBudgetUsd: number | null;
  sessionCostBudgetUsd: number | null;
}

export interface WorkspaceHouseRules {
  houseRules: string | null;
}

export interface WorkspaceScriptsBridgePayload {
  scripts: {
    devServer?: string;
    setup?: string;
    cleanup?: string;
  };
}

export interface WorkspaceRunScriptResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: string;
}

/**
 * Inline review comment captured against a worktree diff. Stored locally
 * keyed on (run, file, line, side) and consumed by the composer the next
 * time the user posts a message to the run, prepending the accumulated
 * comments so the agent can act on them.
 */
export interface ReviewCommentPayload {
  id: number;
  runId: number;
  filePath: string;
  lineNumber: number;
  side: 'old' | 'new' | 'context';
  body: string;
  createdAt: string;
  consumedAt: string | null;
}

/**
 * Discovered slash command surface for the chat composer typeahead. The
 * `source` tag lets the renderer style entries differently (built-in vs.
 * user-authored vs. kanbots orchestration).
 */
export interface SlashCommandPayload {
  name: string;
  description: string;
  source: 'builtin' | 'user' | 'skill' | 'kanbots';
}

export interface WorkspaceFolderPayload {
  id: string;
  workspaceId: string;
  name: string;
  path: string;
  defaultBranch: string;
  addedAt: string;
  current: boolean;
}

export type DiffFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'other';

export interface DiffFile {
  path: string;
  status: DiffFileStatus;
  patch: string;
}

export interface DiffPayload {
  base: string;
  branch: string | null;
  files: DiffFile[];
  empty: boolean;
}

export interface PendingDecisionPayload {
  cardId: number;
  runId: number;
  issueNumber: number;
  question: string;
  options: Array<{ value: string; label: string }>;
  createdAt: string;
}

export interface PreviewStatePayload {
  url: string | null;
  state: PreviewState;
  pid: number | null;
}

export interface UploadAttachmentResult {
  filename: string;
  absolutePath: string;
  relativePath: string;
  size: number;
  contentType: string;
}

export type AgentRunEventPayload =
  | { subscriptionId: string; kind: 'event'; event: AgentEvent }
  | { subscriptionId: string; kind: 'card'; card: Card }
  | { subscriptionId: string; kind: 'status'; status: AgentRunStatus }
  | { subscriptionId: string; kind: 'end' };

export interface ShipStatus {
  runId: number | null;
  branchName: string | null;
  worktreePath: string | null;
  hasUncommittedChanges: boolean;
  commitsAheadOfDefault: number;
  defaultMergeTarget: string;
  availableTargets: string[];
}

export interface ShipMergeResult {
  merged: true;
  targetBranch: string;
  mergeCommitSha: string;
  baseCheckoutPath: string;
}

export interface ShipPRResult {
  pr: PullRequest;
}

export interface ShipCommitResult {
  commitSha: string;
}

export interface BridgeChannels {
  'config:get': { args: void; result: Config };
  'issues:list': {
    args: { state?: 'open' | 'closed' | 'all' };
    result: DecoratedIssue[];
  };
  'issues:list-archived': { args: void; result: DecoratedIssue[] };
  'issues:get': { args: { number: number }; result: IssueDetail };
  'issues:create': { args: CreateIssueInput; result: DecoratedIssue };
  'issues:patch': {
    args: { number: number; patch: UpdateIssuePatch };
    result: DecoratedIssue;
  };
  'issues:add-comment': {
    args: { number: number; body: string };
    result: Comment;
  };
  'issues:post-message': {
    args: {
      number: number;
      body: string;
      dispatch?: boolean;
      model?: string;
      provider?: ProviderId;
      appendSystemPrompt?: string;
    };
    result: PostMessageResult;
  };
  'issues:list-runs': { args: { number: number }; result: AgentRun[] };
  'issues:dispatch': {
    args: {
      number: number;
      fromStatus: StatusKey | null;
      model?: string;
      provider?: ProviderId;
    };
    result: DispatchResult;
  };
  'issues:start-agent': {
    args: {
      number: number;
      threadId: number;
      prompt: string;
      appendSystemPrompt?: string;
      model?: string;
      provider?: ProviderId;
    };
    result: AgentRun;
  };
  'issues:archive': { args: { number: number }; result: DecoratedIssue };
  'issues:unarchive': { args: { number: number }; result: DecoratedIssue };
  'issues:approve': { args: { number: number }; result: DecoratedIssue };
  'issues:request-changes': { args: { number: number }; result: DecoratedIssue };
  'issues:split': {
    args: {
      number: number;
      subtasks: Array<{ title: string; body?: string }>;
      dispatch?: boolean;
    };
    result: SplitResult;
  };
  'issues:reviewer': {
    args: { number: number; threadId?: number; prompt?: string; model?: string };
    result: AgentRun;
  };
  'ship:status': {
    args: { issueNumber: number };
    result: ShipStatus;
  };
  'ship:commit': {
    args: { issueNumber: number; message?: string };
    result: ShipCommitResult;
  };
  'ship:merge': {
    args: { issueNumber: number; targetBranch: string };
    result: ShipMergeResult;
  };
  'ship:create-pr': {
    args: {
      issueNumber: number;
      targetBranch?: string;
      title?: string;
      body?: string;
      draft?: boolean;
    };
    result: ShipPRResult;
  };
  'agent-runs:get': { args: { runId: number }; result: AgentRun };
  'agent-runs:stop': { args: { runId: number }; result: AgentRun };
  'agent-runs:diff': { args: { runId: number }; result: DiffPayload };
  'agent-runs:stats': { args: { runId: number }; result: RunStatsResult };
  'agent-runs:reveal-worktree': {
    args: { runId: number };
    result: { worktreePath: string };
  };
  'agent-runs:checks:list': { args: { runId: number }; result: AgentCheck[] };
  'agent-runs:checks:run': {
    args: { runId: number; kinds?: CheckKind[] };
    result: AgentCheck[];
  };
  'agent-runs:checks:commands': {
    args: void;
    result: Record<CheckKind, { command: string; args: string[] }>;
  };
  'agent-cli:slash-commands': {
    args: { agent: ProviderId };
    result: SlashCommandPayload[];
  };
  'agent-runs:preview:get': {
    args: { runId: number };
    result: PreviewStatePayload;
  };
  'agent-runs:preview:start': {
    args: { runId: number };
    result: PreviewStatePayload;
  };
  'agent-runs:preview:stop': {
    args: { runId: number };
    result: PreviewStatePayload;
  };
  'agent-runs:fork': { args: { runId: number }; result: ForkRunResult };
  'agent-runs:promote-commit': {
    args: { runId: number };
    result: PromoteCommitResult;
  };
  'agent-runs:promote-pr': {
    args: { runId: number };
    result: PromotePrResult;
  };
  'agent-runs:events:subscribe': {
    args: { runId: number; sinceSeq?: number };
    result: EventSubscribeResult;
  };
  'agent-runs:events:unsubscribe': {
    args: { subscriptionId: string };
    result: void;
  };
  'cards:resolve': {
    args: { cardId: number; value: string };
    result: ResolveCardResult;
  };
  'cards:dismiss': {
    args: { cardId: number };
    result: DismissCardResult;
  };
  'decisions:pending': { args: void; result: PendingDecisionPayload[] };
  'cost:today': { args: void; result: CostTodayResult };
  'cost:usage': { args: void; result: CostUsageResult };
  'cost:breakdown': { args: void; result: CostBreakdownItem[] };
  'cooldown:get': { args: void; result: CooldownStatePayload };
  'workspace:get': { args: void; result: Workspace };
  'workspace:get-budgets': { args: void; result: WorkspaceBudgets };
  'workspace:set-budgets': {
    args: { runCostBudgetUsd: number | null; sessionCostBudgetUsd: number | null };
    result: WorkspaceBudgets;
  };
  'workspace:get-house-rules': { args: void; result: WorkspaceHouseRules };
  'workspace:set-house-rules': {
    args: { houseRules: string | null };
    result: WorkspaceHouseRules;
  };
  'workspace:get-scripts': { args: void; result: WorkspaceScriptsBridgePayload };
  'workspace:set-scripts': {
    args: {
      devServer?: string | null;
      setup?: string | null;
      cleanup?: string | null;
    };
    result: WorkspaceScriptsBridgePayload;
  };
  'workspace:run-script': {
    args: { kind: 'setup' | 'cleanup' };
    result: WorkspaceRunScriptResult;
  };
  'review-comments:list': {
    args: { runId: number; includeConsumed?: boolean };
    result: ReviewCommentPayload[];
  };
  'review-comments:list-for-file': {
    args: { runId: number; filePath: string };
    result: ReviewCommentPayload[];
  };
  'review-comments:add': {
    args: {
      runId: number;
      filePath: string;
      lineNumber: number;
      side: 'old' | 'new' | 'context';
      body: string;
    };
    result: ReviewCommentPayload;
  };
  'review-comments:remove': { args: { id: number }; result: { ok: boolean } };
  'review-comments:consume-pending': {
    args: { runId: number };
    result: ReviewCommentPayload[];
  };
  'folders:list': { args: void; result: WorkspaceFolderPayload[] };
  'folders:add': {
    args: { name: string; path: string; defaultBranch?: string };
    result: WorkspaceFolderPayload;
  };
  'composer:draft': { args: { description: string }; result: DraftedIssue };
  'composer:suggest': {
    args: { personaPrompt: string; provider?: ProviderId; userNotes?: string };
    result: DraftedIssue;
  };
  'attachments:upload': {
    args: { contentType: string; data: Uint8Array };
    result: UploadAttachmentResult;
  };
  'autopilot:start': {
    args: {
      kind: AutopilotKind;
      title?: string;
      config: AutopilotConfig;
    };
    result: { sessionId: number; issueNumber: number };
  };
  'autopilot:stop': {
    args: { sessionId: number; stopChildren: boolean };
    result: { sessionId: number };
  };
  'autopilot:list-active': { args: void; result: AutopilotSession[] };
  'autopilot:get-by-issue': {
    args: { issueNumber: number };
    result: AutopilotSession | null;
  };
  'sentry:get-config': { args: void; result: SentryConfigPayload };
  'sentry:save-config': {
    args: SentryConfigInput;
    result: SentryConfigPayload;
  };
  'sentry:test-connection': {
    args: { token?: string; orgSlug?: string; projectSlug?: string };
    result: SentryTestConnectionResult;
  };
  'sentry:sync-now': { args: void; result: SentrySyncResult };
  'sentry:analyze': {
    args: { issueNumber: number };
    result: SentrySuggestion;
  };
  'sentry:apply-suggestion': {
    args: { issueNumber: number };
    result: DecoratedIssue;
  };
  'providers:get': { args: void; result: ProvidersPayload };
  'providers:save': { args: ProviderSaveInput; result: ProvidersPayload };
  'providers:test-connection': {
    args: { id: ProviderId; apiKey?: string };
    result: ProviderTestConnectionResult;
  };
  'providers:set-defaults': {
    args: ProviderSettingsInput;
    result: ProvidersPayload;
  };
  'chat:list': { args: void; result: ChatConversation[] };
  'chat:create': {
    args: { title?: string };
    result: ChatPayload;
  };
  'chat:get': {
    args: { conversationId: number };
    result: ChatPayload;
  };
  'chat:rename': {
    args: { conversationId: number; title: string };
    result: ChatConversation;
  };
  'chat:delete': {
    args: { conversationId: number };
    result: { ok: true };
  };
  'chat:post-message': {
    args: {
      conversationId: number;
      body: string;
      dispatch?: boolean;
      model?: string;
      provider?: ProviderId;
      appendSystemPrompt?: string;
    };
    result: ChatPostMessageResult;
  };
  'chat:stop-run': {
    args: { runId: number };
    result: AgentRun;
  };
  'learnings:list': {
    args: {
      repoOwner: string;
      repoName: string;
      includeDeleted?: boolean;
      tag?: 'convention' | 'gotcha' | 'fragile' | 'decision-rationale';
      limit?: number;
    };
    result: Learning[];
  };
  'learnings:delete': {
    args: { id: number };
    result: Learning;
  };
  'learnings:update': {
    args: { id: number; content: string };
    result: Learning;
  };
  'learnings:pin': {
    args: { id: number; pinned: boolean };
    result: Learning;
  };
  'analytics:rollup': {
    args: {
      repoOwner?: string;
      repoName?: string;
      sinceTs?: string;
      cardKind?: string;
      cardSizeBucket?: string;
    };
    result: PersonaModelRollupRow[];
  };
  'analytics:time-series': {
    args: {
      repoOwner?: string;
      repoName?: string;
      sinceTs: string;
      personaId?: string;
      model?: string;
    };
    result: CostTimeSeriesPoint[];
  };
  'analytics:frontier': {
    args: {
      repoOwner?: string;
      repoName?: string;
      sinceTs?: string;
      minRuns?: number;
    };
    result: FrontierPoint[];
  };
  'agent-runs:hunks:list': {
    args: { runId: number };
    result: DiffHunk[];
  };
}

/** Per-(persona × model × provider) rollup. Excludes runs without a
 *  persona id (chat runs and non-autopilot dispatches). */
export interface PersonaModelRollupRow {
  personaId: string;
  model: string | null;
  provider: string | null;
  runs: number;
  successes: number;
  failures: number;
  totalCostUsd: number;
  avgCostUsd: number;
  avgDurationMs: number | null;
  successRate: number;
}

export interface CostTimeSeriesPoint {
  bucketDate: string;
  runs: number;
  totalCostUsd: number;
  successRate: number;
}

export interface FrontierPoint {
  personaId: string;
  model: string | null;
  provider: string | null;
  runs: number;
  avgCostUsd: number;
  successRate: number;
}

export interface ChatPayload {
  conversation: ChatConversation;
  messages: Message[];
  /**
   * Snapshot of every persisted agent_event for runs in this conversation's
   * thread. The renderer merges this with live stream events (deduped by
   * `id`) so the transcript survives across run boundaries — chat resume
   * may reuse a run id, but a *new* chat run gets a new id and the live
   * stream only follows one run at a time.
   */
  events: AgentEvent[];
  /**
   * Snapshot of every card attached to messages in this thread. Used the
   * same way as `events`: merged with live stream cards, deduped by `id`.
   */
  cards: Card[];
  activeRun: AgentRun | null;
  latestRun: AgentRun | null;
}

export interface ChatPostMessageResult {
  conversation: ChatConversation;
  message: Message;
  activeRun: AgentRun | null;
  latestRun: AgentRun | null;
  dispatchError?: string;
}

export type ChannelName = keyof BridgeChannels;
export type ChannelArgs<C extends ChannelName> = BridgeChannels[C]['args'];
export type ChannelResult<C extends ChannelName> = BridgeChannels[C]['result'];
