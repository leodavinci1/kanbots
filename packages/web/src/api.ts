import { cardsToIssues, cardToIssue, statusFromLabels } from './cloud-adapter.js';
import type {
  ChannelArgs,
  ChannelName,
  ChannelResult,
  PostMessageResult,
  UploadAttachmentResult,
} from './global.js';
import type {
  AgentCheck,
  AgentRun,
  AutopilotConfig,
  AutopilotKind,
  AutopilotSession,
  Card,
  ChatConversation,
  ChatPayload,
  ChatPostMessageResult,
  Comment,
  Config,
  CreateIssueInput,
  DiffPayload,
  DraftedIssue,
  Issue,
  IssueDetail,
  Message,
  PendingDecisionPayload,
  PreviewStatePayload,
  ProviderId,
  ProviderSaveInput,
  ProviderSettingsInput,
  ProviderTestConnectionResult,
  ProvidersPayload,
  ReviewCommentPayload,
  SentryConfigInput,
  SentryConfigPayload,
  SentrySuggestion,
  SentrySyncResult,
  SentryTestConnectionResult,
  ShipCommitResult,
  ShipMergeResult,
  ShipPRResult,
  ShipStatus,
  SlashCommandPayload,
  StatusKey,
  UpdateIssuePatch,
  Workspace,
  WorkspaceBudgets,
  WorkspaceFolderPayload,
  WorkspaceHouseRules,
  WorkspaceScriptsBridgePayload,
  WorkspaceRunScriptResult,
} from './types.js';

export type { PostMessageResult, UploadAttachmentResult } from './global.js';
export type { ReviewCommentPayload } from './types.js';

export interface ResolveCardResult {
  card: Card;
  run: AgentRun;
}

export interface DismissCardResult {
  card: Card;
  run: AgentRun;
}

export interface PostMessageOptions {
  dispatch?: boolean;
  model?: string;
  provider?: ProviderId;
  appendSystemPrompt?: string;
}

export interface DispatchIssueResult {
  run: AgentRun;
  message: Message;
}

export interface DispatchIssueInput {
  fromStatus: StatusKey | null;
  model?: string;
  provider?: ProviderId;
}

interface BridgeError extends Error {
  details?: unknown;
}

// Cloud-only launch — phase 1 unification: when a cloud workspace is open,
// `setCloudCtx` is called by the App with the active org/project slugs.
// Mode-aware api functions check `cloudCtx` and route to the cloud client
// bridge instead of local IPC; everything else stays as local-mode IPC.
// Callers don't need to know the mode — they keep calling `api.foo()`.
interface CloudCtx {
  orgSlug: string;
  projectSlug: string;
}
let cloudCtx: CloudCtx | null = null;
export function setCloudCtx(ctx: CloudCtx | null): void {
  cloudCtx = ctx;
}
export function isCloudMode(): boolean {
  return cloudCtx !== null;
}
/**
 * Read-only accessor for the cloud context. Mostly used by mode-aware
 * UI that needs the org/project slugs to call the cloud bridge directly
 * (e.g. FileChangeViewer's restart-agent flow).
 */
export function getCloudCtx(): CloudCtx | null {
  return cloudCtx;
}

function getCloudBridge() {
  if (typeof window === 'undefined' || !window.kanbots) {
    throw new Error('window.kanbots not available — renderer must run inside Electron');
  }
  return window.kanbots;
}

function refuseInCloud(op: string): never {
  throw new Error(`${op} is not yet available in cloud mode (phase 2-4 of the unification plan).`);
}

function invoke<C extends ChannelName>(
  channel: C,
  args: ChannelArgs<C>,
): Promise<ChannelResult<C>> {
  if (typeof window === 'undefined' || !window.kanbots?.invoke) {
    return Promise.reject(
      new Error('window.kanbots not available — renderer must run inside Electron'),
    );
  }
  return window.kanbots.invoke(channel, args).catch((err: unknown) => {
    throw translateBridgeError(err);
  });
}

// IPC serializes errors to plain Error with a JSON-encoded message of
// shape { name, message, details? }. Unwrap so renderer code can branch
// on err.name (e.g. 'AlreadyActive', 'NotFound', 'ValidationError').
function translateBridgeError(err: unknown): Error {
  if (err instanceof Error) {
    try {
      const parsed = JSON.parse(err.message) as {
        name?: unknown;
        message?: unknown;
        details?: unknown;
      };
      if (typeof parsed.message === 'string') {
        const next: BridgeError = new Error(parsed.message);
        if (typeof parsed.name === 'string' && parsed.name.length > 0) {
          next.name = parsed.name;
        }
        if (parsed.details !== undefined) next.details = parsed.details;
        return next;
      }
    } catch {
      // not a JSON envelope; fall through and return original
    }
    return err;
  }
  return new Error(String(err));
}

function buildPostMessageArgs(
  n: number,
  body: string,
  opts: PostMessageOptions,
): ChannelArgs<'issues:post-message'> {
  const args: ChannelArgs<'issues:post-message'> = { number: n, body };
  if (opts.dispatch !== undefined) args.dispatch = opts.dispatch;
  if (opts.model !== undefined) args.model = opts.model;
  if (opts.provider !== undefined) args.provider = opts.provider;
  if (opts.appendSystemPrompt !== undefined) {
    args.appendSystemPrompt = opts.appendSystemPrompt;
  }
  return args;
}

function buildDispatchArgs(
  n: number,
  input: DispatchIssueInput,
): ChannelArgs<'issues:dispatch'> {
  const args: ChannelArgs<'issues:dispatch'> = {
    number: n,
    fromStatus: input.fromStatus,
  };
  if (input.model !== undefined) args.model = input.model;
  if (input.provider !== undefined) args.provider = input.provider;
  return args;
}

export const api = {
  config: async (): Promise<Config> => {
    if (cloudCtx !== null) {
      // Synthetic config so renderer breadcrumbs render `orgSlug/projectSlug`.
      // `mode: 'github'` keeps the existing display branch (`owner/repo`)
      // working without widening the Config union — phase 3 will add a
      // dedicated 'cloud' mode value with a project-config endpoint.
      return {
        owner: cloudCtx.orgSlug,
        repo: cloudCtx.projectSlug,
        mode: 'github',
      };
    }
    return invoke('config:get', undefined);
  },
  issues: async (state: 'open' | 'closed' | 'all' = 'open'): Promise<Issue[]> => {
    if (cloudCtx !== null) {
      const bridge = getCloudBridge();
      const list = await bridge.cloudCardsList({
        orgSlug: cloudCtx.orgSlug,
        projectSlug: cloudCtx.projectSlug,
        query: { limit: 200 },
      });
      // `state` filtering is approximate in cloud mode: archived_at handles
      // closed-equivalent. Phase 2 may add a `state` query param if needed.
      const issues = cardsToIssues(list.data);
      if (state === 'closed') return issues.filter((i) => i.state === 'closed');
      if (state === 'open') return issues.filter((i) => i.state === 'open');
      return issues;
    }
    return invoke('issues:list', { state });
  },
  issue: async (n: number): Promise<IssueDetail> => {
    if (cloudCtx !== null) {
      const bridge = getCloudBridge();
      const [card, commentsResp] = await Promise.all([
        bridge.cloudCardsGet({
          orgSlug: cloudCtx.orgSlug,
          projectSlug: cloudCtx.projectSlug,
          number: n,
        }),
        bridge.cloudCommentsList({
          orgSlug: cloudCtx.orgSlug,
          projectSlug: cloudCtx.projectSlug,
          number: n,
        }),
      ]);
      const comments: Comment[] = commentsResp.data.map((c) => ({
        id: Number(c.id),
        body: c.body,
        user: { login: 'cloud-user', avatarUrl: null },
        createdAt: c.created_at,
        updatedAt: c.edited_at ?? c.created_at,
        htmlUrl: '',
      }));
      // Synthesize a Thread out of the card's comments so the renderer's
      // ThreadTab has something to render in cloud mode. Cloud doesn't have
      // first-class "thread" rows yet — comments are the user-visible
      // history. Agent text/tool events stream live via useCloudRunStream,
      // so this populates only the user-side messages.
      const messages = commentsResp.data.map((c, i) => ({
        id: Number(c.id) || i + 1,
        threadId: 1,
        role: 'user' as const,
        body: c.body,
        createdAt: c.created_at,
        agentRunId: null,
        promotedGithubCommentId: null,
        promotedAt: null,
      }));
      const thread = {
        id: 1,
        createdAt: messages[0]?.createdAt ?? card.created_at,
        messages,
        activeRun: null,
        latestRun: null,
      };
      return { issue: cardToIssue(card), comments, thread };
    }
    return invoke('issues:get', { number: n });
  },
  updateIssue: async (n: number, patch: UpdateIssuePatch): Promise<Issue> => {
    if (cloudCtx !== null) {
      const bridge = getCloudBridge();
      const body: Parameters<typeof bridge.cloudCardsUpdate>[0]['body'] = {};
      // If labels are being patched (drag-drop), translate the status: label
      // (kebab-cased — e.g. status:in-progress) into the cloud CardStatus.
      // An explicit label patch with no status:* tag means "Inbox" (the
      // null-status column on the board), which maps to cloud 'inbox'.
      if (patch.labels !== undefined) {
        body.status = statusFromLabels(patch.labels) ?? 'inbox';
      }
      if (patch.title !== undefined) body.title = patch.title;
      if (patch.body !== undefined) body.body = patch.body;
      if (
        body.status === undefined &&
        body.title === undefined &&
        body.body === undefined
      ) {
        refuseInCloud(`api.updateIssue (no status/title/body in patch)`);
      }
      const updated = await bridge.cloudCardsUpdate({
        orgSlug: cloudCtx.orgSlug,
        projectSlug: cloudCtx.projectSlug,
        number: n,
        body,
      });
      return cardToIssue(updated);
    }
    return invoke('issues:patch', { number: n, patch });
  },
  addComment: async (n: number, body: string): Promise<Comment> => {
    if (cloudCtx !== null) {
      const bridge = getCloudBridge();
      const created = await bridge.cloudCommentsAdd({
        orgSlug: cloudCtx.orgSlug,
        projectSlug: cloudCtx.projectSlug,
        number: n,
        body,
      });
      // CommentSummary → renderer Comment: stub the GitHub-shaped user.
      return {
        id: Number(created.id),
        body: created.body,
        user: { login: 'cloud-user', avatarUrl: null },
        createdAt: created.created_at,
        updatedAt: created.edited_at ?? created.created_at,
        htmlUrl: '',
      };
    }
    return invoke('issues:add-comment', { number: n, body });
  },
  postMessage: async (
    n: number,
    body: string,
    opts: PostMessageOptions = {},
  ): Promise<PostMessageResult> => {
    if (cloudCtx !== null) {
      // Cloud mode has no local thread/message store; the kickoff text
      // becomes the agent's prompt directly via startAgent. Persist the
      // text as a card comment so it stays visible on the cloud board,
      // then return a synthetic result so TaskCreateModal's "Dispatch"
      // flow doesn't have to know the difference. If the comment write
      // fails we DO surface it — silently losing the kickoff makes
      // the post-dispatch thread look empty for no apparent reason.
      const bridge = getCloudBridge();
      const created = await bridge.cloudCommentsAdd({
        orgSlug: cloudCtx.orgSlug,
        projectSlug: cloudCtx.projectSlug,
        number: n,
        body,
      });
      return {
        message: {
          id: Number(created.id) || 0,
          threadId: 0,
          role: 'user',
          body: created.body,
          createdAt: created.created_at,
        } as unknown as PostMessageResult['message'],
        thread: { id: 0 } as unknown as PostMessageResult['thread'],
      };
    }
    return invoke('issues:post-message', buildPostMessageArgs(n, body, opts));
  },
  createIssue: async (input: CreateIssueInput): Promise<Issue> => {
    if (cloudCtx !== null) {
      const bridge = getCloudBridge();
      // TaskCreateModal encodes the target column as a status:* label
      // (e.g. status:in-progress for "Create & dispatch", status:todo for
      // "Spec first"). Map that onto the cloud `status` field so the card
      // lands in the right column instead of defaulting to Inbox.
      const status = input.labels ? statusFromLabels(input.labels) : null;
      const createBody: Parameters<typeof bridge.cloudCardsCreate>[0]['body'] = {
        title: input.title,
      };
      if (input.body !== undefined) createBody.body = input.body;
      if (status !== null) createBody.status = status;
      const created = await bridge.cloudCardsCreate({
        orgSlug: cloudCtx.orgSlug,
        projectSlug: cloudCtx.projectSlug,
        body: createBody,
      });
      return cardToIssue(created);
    }
    return invoke('issues:create', input);
  },
  draftIssue: (description: string): Promise<DraftedIssue> =>
    invoke('composer:draft', { description }),
  suggestFeature: (
    personaPrompt: string,
    provider?: ProviderId,
    userNotes?: string,
  ): Promise<DraftedIssue> => {
    const args: ChannelArgs<'composer:suggest'> = { personaPrompt };
    if (provider !== undefined) args.provider = provider;
    const trimmedNotes = userNotes?.trim();
    if (trimmedNotes) args.userNotes = trimmedNotes;
    return invoke('composer:suggest', args);
  },
  startAgent: async (
    issueNumber: number,
    input: {
      threadId: number;
      prompt: string;
      appendSystemPrompt?: string;
      model?: string;
      provider?: ProviderId;
    },
  ): Promise<AgentRun> => {
    if (cloudCtx !== null) {
      const bridge = getCloudBridge();
      const { runId } = await bridge.cloudStartAgentRun({
        orgSlug: cloudCtx.orgSlug,
        projectSlug: cloudCtx.projectSlug,
        number: issueNumber,
        prompt: input.prompt,
        ...(input.appendSystemPrompt !== undefined
          ? { appendSystemPrompt: input.appendSystemPrompt }
          : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
      });
      // The renderer's AgentRun type expects a numeric id; cloud runs are
      // KSUIDs. Return a synthetic AgentRun shape — components that need
      // run state poll the cloud via cloudRunsGet using the string runId
      // (latest_run on the card already carries it). Local-only fields
      // are left at safe zero/empty defaults.
      return {
        id: 0,
        cloudRunId: runId,
        threadId: input.threadId,
        issueNumber,
        status: 'starting',
        startedAt: new Date().toISOString(),
      } as unknown as AgentRun;
    }
    const args: ChannelArgs<'issues:start-agent'> = {
      number: issueNumber,
      threadId: input.threadId,
      prompt: input.prompt,
    };
    if (input.appendSystemPrompt !== undefined) {
      args.appendSystemPrompt = input.appendSystemPrompt;
    }
    if (input.model !== undefined) args.model = input.model;
    if (input.provider !== undefined) args.provider = input.provider;
    return invoke('issues:start-agent', args);
  },
  dispatchIssue: async (
    issueNumber: number,
    input: DispatchIssueInput,
  ): Promise<DispatchIssueResult> => {
    if (cloudCtx !== null) {
      // Cloud has no separate "dispatch" — starting an agent run IS the
      // dispatch. Pull the card to build a kickoff prompt from its body
      // (the local dispatcher does the same internally), then kick off
      // the run via cloudStartAgentRun. The board's caller only uses
      // dispatchIssue for its side effect, so the return value is
      // synthesised to satisfy the shared shape.
      const bridge = getCloudBridge();
      const card = await bridge.cloudCardsGet({
        orgSlug: cloudCtx.orgSlug,
        projectSlug: cloudCtx.projectSlug,
        number: issueNumber,
      });
      const prompt =
        (card.body && card.body.trim().length > 0
          ? card.body
          : card.title) ||
        `Implement #${issueNumber}.`;
      const { runId } = await bridge.cloudStartAgentRun({
        orgSlug: cloudCtx.orgSlug,
        projectSlug: cloudCtx.projectSlug,
        number: issueNumber,
        prompt,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
      });
      const now = new Date().toISOString();
      return {
        run: {
          id: 0,
          cloudRunId: runId,
          threadId: 0,
          issueNumber,
          status: 'starting',
          startedAt: now,
        } as unknown as AgentRun,
        message: {
          id: 0,
          threadId: 0,
          role: 'user',
          body: prompt,
          createdAt: now,
        } as unknown as DispatchIssueResult['message'],
      };
    }
    return invoke('issues:dispatch', buildDispatchArgs(issueNumber, input));
  },
  stopAgent: (runId: number): Promise<AgentRun> => invoke('agent-runs:stop', { runId }),
  getAgentRun: (runId: number): Promise<AgentRun> => invoke('agent-runs:get', { runId }),
  getAgentRunDiff: (runId: number): Promise<DiffPayload> =>
    invoke('agent-runs:diff', { runId }),
  revealAgentRunWorktree: (runId: number): Promise<{ worktreePath: string }> =>
    invoke('agent-runs:reveal-worktree', { runId }),
  getAgentRunStats: (
    runId: number,
  ): Promise<{ additions: number; deletions: number; filesChanged: number }> =>
    invoke('agent-runs:stats', { runId }),
  listIssueRuns: (issueNumber: number): Promise<AgentRun[]> =>
    invoke('issues:list-runs', { number: issueNumber }),
  listPendingDecisions: (): Promise<PendingDecisionPayload[]> => {
    if (cloudCtx !== null) return Promise.resolve([]);
    return invoke('decisions:pending', undefined);
  },
  workspace: async (): Promise<Workspace> => {
    if (cloudCtx !== null) {
      // Synthetic — phase 3 ships a real project-config endpoint that will
      // back this with cloud workspace metadata.
      return {
        id: `${cloudCtx.orgSlug}/${cloudCtx.projectSlug}`,
        name: cloudCtx.projectSlug,
        currentFolderId: '',
      };
    }
    return invoke('workspace:get', undefined);
  },
  getWorkspaceBudgets: (): Promise<WorkspaceBudgets> =>
    invoke('workspace:get-budgets', undefined),
  setWorkspaceBudgets: (input: WorkspaceBudgets): Promise<WorkspaceBudgets> =>
    invoke('workspace:set-budgets', input),
  getWorkspaceHouseRules: (): Promise<WorkspaceHouseRules> =>
    invoke('workspace:get-house-rules', undefined),
  setWorkspaceHouseRules: (input: WorkspaceHouseRules): Promise<WorkspaceHouseRules> =>
    invoke('workspace:set-house-rules', input),
  getWorkspaceScripts: (): Promise<WorkspaceScriptsBridgePayload> =>
    invoke('workspace:get-scripts', undefined),
  setWorkspaceScripts: (input: {
    devServer?: string | null;
    setup?: string | null;
    cleanup?: string | null;
  }): Promise<WorkspaceScriptsBridgePayload> => invoke('workspace:set-scripts', input),
  runWorkspaceScript: (kind: 'setup' | 'cleanup'): Promise<WorkspaceRunScriptResult> =>
    invoke('workspace:run-script', { kind }),
  getReviewComments: (
    runId: number,
    includeConsumed?: boolean,
  ): Promise<ReviewCommentPayload[]> =>
    invoke('review-comments:list', {
      runId,
      ...(includeConsumed ? { includeConsumed } : {}),
    }),
  listReviewCommentsForFile: (
    runId: number,
    filePath: string,
  ): Promise<ReviewCommentPayload[]> =>
    invoke('review-comments:list-for-file', { runId, filePath }),
  addReviewComment: (input: {
    runId: number;
    filePath: string;
    lineNumber: number;
    side: 'old' | 'new' | 'context';
    body: string;
  }): Promise<ReviewCommentPayload> => invoke('review-comments:add', input),
  removeReviewComment: (id: number): Promise<{ ok: boolean }> =>
    invoke('review-comments:remove', { id }),
  consumeReviewComments: (runId: number): Promise<ReviewCommentPayload[]> =>
    invoke('review-comments:consume-pending', { runId }),
  listFolders: (): Promise<WorkspaceFolderPayload[]> => {
    if (cloudCtx !== null) return Promise.resolve([]);
    return invoke('folders:list', undefined);
  },
  addFolder: (input: {
    name: string;
    path: string;
    defaultBranch?: string;
  }): Promise<WorkspaceFolderPayload> => {
    const args: ChannelArgs<'folders:add'> = { name: input.name, path: input.path };
    if (input.defaultBranch !== undefined) args.defaultBranch = input.defaultBranch;
    return invoke('folders:add', args);
  },
  getAgentRunChecks: (runId: number): Promise<AgentCheck[]> =>
    invoke('agent-runs:checks:list', { runId }),
  getCheckCommands: (): Promise<
    Record<'typecheck' | 'tests' | 'lint' | 'e2e', { command: string; args: string[] }>
  > => invoke('agent-runs:checks:commands', undefined),
  /**
   * List the slash commands available for the given agent CLI. Combines
   * the CLI's built-in catalog with user-authored commands and skills
   * discovered on disk, plus kanbots orchestration commands. Result is
   * cached server-side for 30s so a burst of `/` keypresses in the
   * composer typeahead is cheap.
   */
  getSlashCommands: (agent: ProviderId): Promise<SlashCommandPayload[]> =>
    invoke('agent-cli:slash-commands', { agent }),
  runAgentRunChecks: (
    runId: number,
    kinds?: Array<'typecheck' | 'tests' | 'lint' | 'e2e'>,
  ): Promise<AgentCheck[]> => {
    const args: ChannelArgs<'agent-runs:checks:run'> = { runId };
    if (kinds !== undefined) args.kinds = kinds;
    return invoke('agent-runs:checks:run', args);
  },
  getAgentRunPreview: (runId: number): Promise<PreviewStatePayload> =>
    invoke('agent-runs:preview:get', { runId }),
  startAgentRunPreview: (runId: number): Promise<PreviewStatePayload> =>
    invoke('agent-runs:preview:start', { runId }),
  stopAgentRunPreview: (runId: number): Promise<PreviewStatePayload> =>
    invoke('agent-runs:preview:stop', { runId }),
  approveIssue: (issueNumber: number): Promise<Issue> =>
    invoke('issues:approve', { number: issueNumber }),
  requestChangesIssue: (issueNumber: number): Promise<Issue> =>
    invoke('issues:request-changes', { number: issueNumber }),
  shipStatus: (issueNumber: number): Promise<ShipStatus> =>
    invoke('ship:status', { issueNumber }),
  shipCommit: (
    issueNumber: number,
    message?: string,
  ): Promise<ShipCommitResult> =>
    invoke('ship:commit', {
      issueNumber,
      ...(message !== undefined ? { message } : {}),
    }),
  shipMerge: (
    issueNumber: number,
    targetBranch: string,
  ): Promise<ShipMergeResult> =>
    invoke('ship:merge', { issueNumber, targetBranch }),
  shipCreatePR: (input: {
    issueNumber: number;
    targetBranch?: string;
    title?: string;
    body?: string;
    draft?: boolean;
  }): Promise<ShipPRResult> => invoke('ship:create-pr', input),
  archiveIssue: async (issueNumber: number): Promise<Issue> => {
    if (cloudCtx !== null) {
      // Cloud archive is a soft-delete (sets archived_at) — it's the DELETE
      // verb on the card resource, not a status change. Re-fetch the card
      // after so the renderer's Issue carries the new closed/archived state.
      const bridge = getCloudBridge();
      await bridge.cloudCardsArchive({
        orgSlug: cloudCtx.orgSlug,
        projectSlug: cloudCtx.projectSlug,
        number: issueNumber,
      });
      const card = await bridge.cloudCardsGet({
        orgSlug: cloudCtx.orgSlug,
        projectSlug: cloudCtx.projectSlug,
        number: issueNumber,
      });
      return cardToIssue(card);
    }
    return invoke('issues:archive', { number: issueNumber });
  },
  unarchiveIssue: async (issueNumber: number): Promise<Issue> => {
    if (cloudCtx !== null) {
      const bridge = getCloudBridge();
      const restored = await bridge.cloudCardsUnarchive({
        orgSlug: cloudCtx.orgSlug,
        projectSlug: cloudCtx.projectSlug,
        number: issueNumber,
      });
      return cardToIssue(restored);
    }
    return invoke('issues:unarchive', { number: issueNumber });
  },
  listArchivedIssues: async (): Promise<Issue[]> => {
    if (cloudCtx !== null) {
      const bridge = getCloudBridge();
      const list = await bridge.cloudCardsList({
        orgSlug: cloudCtx.orgSlug,
        projectSlug: cloudCtx.projectSlug,
        query: { limit: 200, include_archived: true },
      });
      // cardsToIssues drops archived cards on purpose (board never renders
      // them); the archive view wants the opposite — only archived rows.
      return list.data.filter((c) => c.archived_at !== null).map(cardToIssue);
    }
    return invoke('issues:list-archived', undefined);
  },
  splitIssue: (
    issueNumber: number,
    subtasks: Array<{ title: string; body?: string }>,
    opts: { dispatch?: boolean } = {},
  ): Promise<{ parent: number; children: Issue[] }> =>
    invoke('issues:split', {
      number: issueNumber,
      subtasks,
      dispatch: opts.dispatch ?? false,
    }),
  spawnReviewer: (
    issueNumber: number,
    opts: { threadId?: number; prompt?: string; model?: string } = {},
  ): Promise<AgentRun> => {
    const args: ChannelArgs<'issues:reviewer'> = { number: issueNumber };
    if (opts.threadId !== undefined) args.threadId = opts.threadId;
    if (opts.prompt !== undefined) args.prompt = opts.prompt;
    if (opts.model !== undefined) args.model = opts.model;
    return invoke('issues:reviewer', args);
  },
  forkAgentRun: (
    runId: number,
  ): Promise<{ source: number; run: AgentRun; worktree: string; branch: string }> =>
    invoke('agent-runs:fork', { runId }),
  promoteCommit: (
    runId: number,
  ): Promise<ChannelResult<'agent-runs:promote-commit'>> =>
    invoke('agent-runs:promote-commit', { runId }),
  promotePR: (
    runId: number,
  ): Promise<ChannelResult<'agent-runs:promote-pr'>> =>
    invoke('agent-runs:promote-pr', { runId }),
  costToday: async (): Promise<{ totalUsd: number; since: string }> => {
    if (cloudCtx !== null) {
      const bridge = getCloudBridge();
      return bridge.cloudCostToday(cloudCtx.orgSlug);
    }
    return invoke('cost:today', undefined);
  },
  costUsage: async (): Promise<ChannelResult<'cost:usage'>> => {
    if (cloudCtx !== null) {
      // Phase 2: replace with cloud billing usage endpoint.
      return { fiveHour: null, sevenDay: null, source: 'unavailable' };
    }
    return invoke('cost:usage', undefined);
  },
  costBreakdown: (): Promise<ChannelResult<'cost:breakdown'>> =>
    invoke('cost:breakdown', undefined),
  costRollup: (
    args: ChannelArgs<'analytics:rollup'> = {},
  ): Promise<ChannelResult<'analytics:rollup'>> => invoke('analytics:rollup', args),
  costTimeSeries: (
    args: ChannelArgs<'analytics:time-series'>,
  ): Promise<ChannelResult<'analytics:time-series'>> => invoke('analytics:time-series', args),
  resolveCard: (cardId: number, value: string): Promise<ResolveCardResult> =>
    invoke('cards:resolve', { cardId, value }),
  dismissCard: (cardId: number): Promise<DismissCardResult> =>
    invoke('cards:dismiss', { cardId }),
  uploadAttachment: async (file: Blob): Promise<UploadAttachmentResult> => {
    const data = new Uint8Array(await file.arrayBuffer());
    return invoke('attachments:upload', {
      contentType: file.type || 'application/octet-stream',
      data,
    });
  },
  startAutopilot: (input: {
    kind: AutopilotKind;
    title?: string;
    config: AutopilotConfig;
  }): Promise<{ sessionId: number; issueNumber: number }> => {
    const args: ChannelArgs<'autopilot:start'> = { kind: input.kind, config: input.config };
    if (input.title !== undefined) args.title = input.title;
    return invoke('autopilot:start', args);
  },
  stopAutopilot: (
    sessionId: number,
    opts: { stopChildren: boolean },
  ): Promise<{ sessionId: number }> =>
    invoke('autopilot:stop', { sessionId, stopChildren: opts.stopChildren }),
  listActiveAutopilots: (): Promise<AutopilotSession[]> =>
    invoke('autopilot:list-active', undefined),
  getAutopilotByIssue: (issueNumber: number): Promise<AutopilotSession | null> =>
    invoke('autopilot:get-by-issue', { issueNumber }),
  getSentryConfig: (): Promise<SentryConfigPayload> =>
    invoke('sentry:get-config', undefined),
  saveSentryConfig: (input: SentryConfigInput): Promise<SentryConfigPayload> =>
    invoke('sentry:save-config', input),
  testSentryConnection: (input: {
    token?: string;
    orgSlug?: string;
    projectSlug?: string;
  } = {}): Promise<SentryTestConnectionResult> =>
    invoke('sentry:test-connection', input),
  syncSentryNow: (): Promise<SentrySyncResult> =>
    invoke('sentry:sync-now', undefined),
  analyzeSentryIssue: (issueNumber: number): Promise<SentrySuggestion> =>
    invoke('sentry:analyze', { issueNumber }),
  applySentrySuggestion: (issueNumber: number): Promise<Issue> =>
    invoke('sentry:apply-suggestion', { issueNumber }),
  getProviders: (): Promise<ProvidersPayload> => invoke('providers:get', undefined),
  saveProvider: (input: ProviderSaveInput): Promise<ProvidersPayload> =>
    invoke('providers:save', input),
  testProviderConnection: (
    input: { id: ProviderId; apiKey?: string },
  ): Promise<ProviderTestConnectionResult> =>
    invoke('providers:test-connection', input),
  setProviderDefaults: (input: ProviderSettingsInput): Promise<ProvidersPayload> =>
    invoke('providers:set-defaults', input),
  listChats: (): Promise<ChatConversation[]> => {
    // Chat history is per-device (stored at userData/device-chats.db on
    // the desktop), so the same IPC works in both workspace and
    // cloud-only modes.
    return invoke('chat:list', undefined);
  },
  createChat: (title?: string): Promise<ChatPayload> => {
    const args: ChannelArgs<'chat:create'> = title !== undefined ? { title } : {};
    return invoke('chat:create', args);
  },
  getChat: (conversationId: number): Promise<ChatPayload> =>
    invoke('chat:get', { conversationId }),
  renameChat: (conversationId: number, title: string): Promise<ChatConversation> =>
    invoke('chat:rename', { conversationId, title }),
  deleteChat: (conversationId: number): Promise<{ ok: true }> =>
    invoke('chat:delete', { conversationId }),
  postChatMessage: (
    conversationId: number,
    body: string,
    opts: PostMessageOptions = {},
  ): Promise<ChatPostMessageResult> => {
    const args: ChannelArgs<'chat:post-message'> = { conversationId, body };
    if (opts.dispatch !== undefined) args.dispatch = opts.dispatch;
    if (opts.model !== undefined) args.model = opts.model;
    if (opts.provider !== undefined) args.provider = opts.provider;
    if (opts.appendSystemPrompt !== undefined) {
      args.appendSystemPrompt = opts.appendSystemPrompt;
    }
    return invoke('chat:post-message', args);
  },
  stopChatRun: (runId: number): Promise<AgentRun> => invoke('chat:stop-run', { runId }),
} as const;
