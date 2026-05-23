import { openDb, type Db } from './db.js';
import { migrations } from './migrations/index.js';
import { runMigrations } from './migrations/runner.js';
import { AgentChecksRepo } from './repos/agent-checks.js';
import { AgentEventsRepo } from './repos/agent-events.js';
import { AgentRunsRepo } from './repos/agent-runs.js';
import { AutopilotSessionsRepo } from './repos/autopilot-sessions.js';
import { CardsRepo } from './repos/cards.js';
import { ChatConversationsRepo } from './repos/chat-conversations.js';
import { DiffHunksRepo } from './repos/diff-hunks.js';
import { FoldersRepo } from './repos/folders.js';
import { HttpCacheRepo } from './repos/http-cache.js';
import { LearningsRepo } from './repos/learnings.js';
import { LocalIssuesRepo } from './repos/local-issues.js';
import { MessagesRepo } from './repos/messages.js';
import { PromotionsRepo } from './repos/promotions.js';
import { ProviderSettingsRepo, ProvidersRepo } from './repos/providers.js';
import { ReviewCommentsRepo } from './repos/review-comments.js';
import { SentryConfigRepo } from './repos/sentry-config.js';
import { SentryImportsRepo } from './repos/sentry-imports.js';
import { ThreadsRepo } from './repos/threads.js';
import { WorkspacesRepo } from './repos/workspaces.js';

export interface Store {
  readonly threads: ThreadsRepo;
  readonly messages: MessagesRepo;
  readonly cards: CardsRepo;
  readonly chatConversations: ChatConversationsRepo;
  readonly agentRuns: AgentRunsRepo;
  readonly events: AgentEventsRepo;
  readonly checks: AgentChecksRepo;
  readonly promotions: PromotionsRepo;
  readonly httpCache: HttpCacheRepo;
  readonly learnings: LearningsRepo;
  readonly diffHunks: DiffHunksRepo;
  readonly localIssues: LocalIssuesRepo;
  readonly workspaces: WorkspacesRepo;
  readonly folders: FoldersRepo;
  readonly autopilotSessions: AutopilotSessionsRepo;
  readonly providers: ProvidersRepo;
  readonly providerSettings: ProviderSettingsRepo;
  readonly reviewComments: ReviewCommentsRepo;
  readonly sentryConfig: SentryConfigRepo;
  readonly sentryImports: SentryImportsRepo;
  readonly db: Db;
  close(): void;
}

export interface OpenStoreOptions {
  path: string;
}

export function openStore(opts: OpenStoreOptions): Store {
  const db = openDb(opts.path);
  runMigrations(db, migrations);
  return wrap(db);
}

export function openStoreInMemory(): Store {
  return openStore({ path: ':memory:' });
}

function wrap(db: Db): Store {
  return {
    threads: new ThreadsRepo(db),
    messages: new MessagesRepo(db),
    cards: new CardsRepo(db),
    chatConversations: new ChatConversationsRepo(db),
    agentRuns: new AgentRunsRepo(db),
    events: new AgentEventsRepo(db),
    checks: new AgentChecksRepo(db),
    promotions: new PromotionsRepo(db),
    httpCache: new HttpCacheRepo(db),
    learnings: new LearningsRepo(db),
    diffHunks: new DiffHunksRepo(db),
    localIssues: new LocalIssuesRepo(db),
    workspaces: new WorkspacesRepo(db),
    folders: new FoldersRepo(db),
    autopilotSessions: new AutopilotSessionsRepo(db),
    providers: new ProvidersRepo(db),
    providerSettings: new ProviderSettingsRepo(db),
    reviewComments: new ReviewCommentsRepo(db),
    sentryConfig: new SentryConfigRepo(db),
    sentryImports: new SentryImportsRepo(db),
    db,
    close: () => db.close(),
  };
}

export const PACKAGE_NAME = '@kanbots/local-store';

export type { Db } from './db.js';
export { migrations, runMigrations };
export type { Migration } from './migrations/types.js';

export { CardAlreadyResolvedError } from './repos/cards.js';
export type { CreateCardInput } from './repos/cards.js';
export type { CreateThreadInput } from './repos/threads.js';
export {
  CHAT_REPO_NAME,
  CHAT_REPO_OWNER,
  type CreateChatConversationInput,
} from './repos/chat-conversations.js';
export type { CreateMessageInput } from './repos/messages.js';
export type { CreateAgentRunInput, UpdateAgentRunPatch } from './repos/agent-runs.js';
export type {
  ListAllLearningsInput,
  ListForInjectionInput,
  UpsertLearningInput,
  UpsertLearningResult,
} from './repos/learnings.js';
export {
  hashLearningContent,
  normaliseLearningContent,
} from './repos/learnings.js';
export type { AppendDiffHunkInput } from './repos/diff-hunks.js';
export { makeSnapshotId } from './repos/diff-hunks.js';
export type {
  CreateAutopilotSessionInput,
  UpdateAutopilotSessionPatch,
} from './repos/autopilot-sessions.js';
export type { AppendAgentEventInput, ListAgentEventsOptions } from './repos/agent-events.js';
export type { CreatePromotionInput } from './repos/promotions.js';
export type { SetCacheInput } from './repos/http-cache.js';

export {
  LocalIssueNotFoundError,
  type CreateLocalCommentInput,
  type CreateLocalIssueInput,
  type UpdateLocalIssuePatch,
} from './repos/local-issues.js';
export { LocalIssueSource, type LocalIssueSourceOptions } from './local-issue-source.js';

export type { ProviderConfigPatch, ProviderSettingsPatch } from './repos/providers.js';
export { PROVIDER_IDS } from './repos/providers.js';
export type {
  AddReviewCommentInput,
  ListReviewCommentsForFileInput,
  ListReviewCommentsInput,
  ReviewComment,
  ReviewCommentSide,
} from './repos/review-comments.js';
export type { SentryConfigPatch } from './repos/sentry-config.js';
export type { UpsertSentryImportInput } from './repos/sentry-imports.js';

export type { Workspace, CreateWorkspaceInput } from './repos/workspaces.js';
export type { Folder, CreateFolderInput } from './repos/folders.js';

export {
  describeKanbotsDir,
  ensureGitignoreEntry,
  ensureKanbotsDir,
  findGitRoot,
  HOUSE_RULES_MAX_BYTES,
  readWorkspaceConfig,
  resolveGitUserName,
  WORKSPACE_SCRIPT_MAX_BYTES,
  writeWorkspaceConfig,
  type CheckCommandKind,
  type CheckCommandOverride,
  type CheckCommandOverrides,
  type GitHubWorkspaceConfig,
  type KanbotsDir,
  type LocalWorkspaceConfig,
  type WorkspaceConfig,
  type WorkspaceDefaults,
  type WorkspaceMode,
  type WorkspaceScriptKind,
  type WorkspaceScripts,
} from './workspace.js';

export type {
  AgentCheck,
  AgentEvent,
  AgentEventId,
  AgentEventType,
  AgentRun,
  AgentRunId,
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
  CacheEntry,
  Card,
  CardId,
  CardStatus,
  CardType,
  ChatConversation,
  ChatConversationId,
  CheckKind,
  CheckStatus,
  CuratorRunState,
  DiffHunk,
  DiffHunkId,
  DiffHunkMode,
  DiffHunkStatus,
  Learning,
  LearningId,
  LearningTag,
  Message,
  MessageId,
  PreviewState,
  Promotion,
  PromotionId,
  PromotionKind,
  ProviderConfig,
  ProviderId,
  ProviderKeyEncryption,
  ProviderSettings,
  Role,
  SentryConfig,
  SentryImport,
  SentryImportStatus,
  SentrySuggestion,
  SentrySuggestionCategory,
  SentrySuggestionConfidence,
  SentrySuggestionVerdict,
  SentryTokenEncryption,
  SuccessSignal,
  Thread,
  ThreadId,
} from './types.js';

export { canUpgradeSuccessSignal } from './types.js';

export type { StartCheckInput, FinishCheckInput } from './repos/agent-checks.js';
