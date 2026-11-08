import {
  agentFromLabels,
  statusFromLabels,
  type Comment,
  type CreateIssueInput,
  type Issue,
  type StatusKey,
  type UpdateIssuePatch,
} from '@kanbots/core';
import type { AgentRun, Message } from '@kanbots/local-store';
import { z } from 'zod';
import type {
  DecoratedIssue,
  DispatchResult,
  IssueActiveRunPayload,
  IssueDetail,
  PostMessageResult,
  SentryMetaPayload,
  ThreadPayload,
} from '../bridge.js';
import { bootstrapWorkspace } from '../workspace-bootstrap.js';
import { sweepAllRunsForThread } from './agent-runs.js';
import { alreadyActive, badRequest, notFound, parseArgs } from './errors.js';
import type { HandlerDeps } from './types.js';

/**
 * Builds a `parent_number → child_count` map for the current
 * workspace. Returns an empty map when the host has no active
 * workspace (e.g. cloud mode pre-bootstrap) so callers don't have to
 * special-case.
 */
function buildSubIssueCountMap(deps: HandlerDeps): Map<number, number> {
  if (!deps.config.repoPath) return new Map();
  const { workspace } = bootstrapWorkspace(
    deps.store,
    deps.config,
    deps.config.repoPath,
  );
  return deps.store.issueRelations.countChildrenByParent(workspace.id);
}

const issueListSchema = z
  .object({
    state: z.enum(['open', 'closed', 'all']).optional(),
  })
  .strict();

const issueGetSchema = z
  .object({
    number: z.number().int().positive(),
  })
  .strict();

const issueCreateSchema = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().max(65_536).optional(),
    labels: z.array(z.string()).optional(),
    assignees: z.array(z.string()).optional(),
  })
  .strict();

const issuePatchSchema = z
  .object({
    number: z.number().int().positive(),
    patch: z
      .object({
        title: z.string().min(1).optional(),
        body: z.string().optional(),
        state: z.enum(['open', 'closed']).optional(),
        labels: z.array(z.string()).optional(),
        assignees: z.array(z.string()).optional(),
      })
      .strict(),
  })
  .strict();

const addCommentSchema = z
  .object({
    number: z.number().int().positive(),
    body: z.string().min(1).max(65_536),
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
    number: z.number().int().positive(),
    body: z.string().min(1).max(65_536),
    dispatch: z.boolean().optional(),
    model: z.string().min(1).max(120).optional(),
    provider: PROVIDER_ENUM.optional(),
    appendSystemPrompt: z.string().max(20_000).optional(),
    repoId: z.number().int().positive().optional(),
    chatSessionId: z.number().int().positive().optional(),
  })
  .strict();

const listRunsSchema = z
  .object({
    number: z.number().int().positive(),
  })
  .strict();

const dispatchSchema = z
  .object({
    number: z.number().int().positive(),
    fromStatus: z
      .enum(['backlog', 'todo', 'inProgress', 'review', 'done'])
      .nullable()
      .optional(),
    model: z.string().min(1).max(120).optional(),
    provider: PROVIDER_ENUM.optional(),
    repoId: z.number().int().positive().optional(),
  })
  .strict();

export interface ListIssuesArgs {
  state?: 'open' | 'closed' | 'all';
}

export interface GetIssueArgs {
  number: number;
}

export interface CreateIssueArgs {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}

export interface PatchIssueArgs {
  number: number;
  patch: UpdateIssuePatch;
}

export interface AddCommentArgs {
  number: number;
  body: string;
}

export interface PostMessageArgs {
  number: number;
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
  repoId?: number;
  chatSessionId?: number;
}

export interface ListRunsArgs {
  number: number;
}

export interface DispatchArgs {
  number: number;
  fromStatus: StatusKey | null;
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
  repoId?: number;
}

export async function list(
  deps: HandlerDeps,
  args: ListIssuesArgs,
): Promise<DecoratedIssue[]> {
  const parsed = parseArgs(issueListSchema, args ?? {});
  const issues = await deps.source.listIssues(
    parsed.state ? { state: parsed.state } : {},
  );
  const activeRunMap = buildActiveRunMap(deps);
  const sentryMap = buildSentryMetaMap(deps);
  const subIssueCountMap = buildSubIssueCountMap(deps);
  return issues.map((issue) =>
    decorateIssue(
      issue,
      activeRunMap.get(issue.number) ?? null,
      sentryMap.get(issue.number) ?? null,
      subIssueCountMap.get(issue.number) ?? 0,
    ),
  );
}

export async function listArchived(
  deps: HandlerDeps,
): Promise<DecoratedIssue[]> {
  // Archived = closed issue carrying the 'archived' label. We pull the closed
  // set from the source and filter client-side so the same filter works for
  // both the local store and GitHub.
  const issues = await deps.source.listIssues({ state: 'closed' });
  const archived = issues.filter((i) => i.labels.includes('archived'));
  // Most-recently archived first. We don't track an explicit archive timestamp
  // (the action piggy-backs on issue close), so updatedAt is the best proxy.
  archived.sort((a, b) => {
    const at = new Date(a.updatedAt).getTime();
    const bt = new Date(b.updatedAt).getTime();
    return bt - at;
  });
  const sentryMap = buildSentryMetaMap(deps);
  const subIssueCountMap = buildSubIssueCountMap(deps);
  return archived.map((issue) =>
    decorateIssue(
      issue,
      null,
      sentryMap.get(issue.number) ?? null,
      subIssueCountMap.get(issue.number) ?? 0,
    ),
  );
}

export async function get(
  deps: HandlerDeps,
  args: GetIssueArgs,
): Promise<IssueDetail> {
  const parsed = parseArgs(issueGetSchema, args);
  const [issue, comments] = await Promise.all([
    deps.source.getIssue(parsed.number),
    deps.source.listComments(parsed.number),
  ]);
  const thread = deps.store.threads.findByIssue(
    deps.config.owner,
    deps.config.repo,
    parsed.number,
  );
  const threadPayload = thread ? buildThreadPayload(deps, thread.id) : null;
  const activeRunMap = buildActiveRunMap(deps);
  const sentryMeta = lookupSentryMeta(deps, parsed.number);
  const subIssueCountMap = buildSubIssueCountMap(deps);
  return {
    issue: decorateIssue(
      issue,
      activeRunMap.get(parsed.number) ?? null,
      sentryMeta,
      subIssueCountMap.get(parsed.number) ?? 0,
    ),
    comments,
    thread: threadPayload,
  };
}

export async function create(
  deps: HandlerDeps,
  args: CreateIssueArgs,
): Promise<DecoratedIssue> {
  const parsed = parseArgs(issueCreateSchema, args);
  const input: CreateIssueInput = {
    title: parsed.title,
    ...(parsed.body !== undefined ? { body: parsed.body } : {}),
    ...(parsed.labels !== undefined ? { labels: parsed.labels } : {}),
    ...(parsed.assignees !== undefined ? { assignees: parsed.assignees } : {}),
  };
  const issue = await deps.source.createIssue(input);
  return decorateIssue(issue);
}

export async function patch(
  deps: HandlerDeps,
  args: PatchIssueArgs,
): Promise<DecoratedIssue> {
  const parsed = parseArgs(issuePatchSchema, args);
  const updates: UpdateIssuePatch = {
    ...(parsed.patch.title !== undefined ? { title: parsed.patch.title } : {}),
    ...(parsed.patch.body !== undefined ? { body: parsed.patch.body } : {}),
    ...(parsed.patch.state !== undefined ? { state: parsed.patch.state } : {}),
    ...(parsed.patch.labels !== undefined ? { labels: parsed.patch.labels } : {}),
    ...(parsed.patch.assignees !== undefined
      ? { assignees: parsed.patch.assignees }
      : {}),
  };
  const issue = await deps.source.updateIssue(parsed.number, updates);
  const sentryMeta = lookupSentryMeta(deps, parsed.number);
  const subIssueCountMap = buildSubIssueCountMap(deps);
  const decorated = decorateIssue(
    issue,
    null,
    sentryMeta,
    subIssueCountMap.get(parsed.number) ?? 0,
  );
  if (decorated.status === 'done') {
    // The user has explicitly signalled they're done with this card, so always
    // remove the run worktrees from disk. Branches with unmerged commits are
    // preserved (sweepAllRunsForThread handles the keep-vs-delete decision)
    // so the agent's work isn't silently destroyed.
    const thread = deps.store.threads.findByIssue(
      deps.config.owner,
      deps.config.repo,
      parsed.number,
    );
    if (thread) await sweepAllRunsForThread(deps, thread.id);
  }
  return decorated;
}

export async function addComment(
  deps: HandlerDeps,
  args: AddCommentArgs,
): Promise<Comment> {
  const parsed = parseArgs(addCommentSchema, args);
  return deps.source.addComment(parsed.number, parsed.body);
}

export async function postMessage(
  deps: HandlerDeps,
  args: PostMessageArgs,
): Promise<PostMessageResult> {
  const parsed = parseArgs(postMessageSchema, args);
  const dispatch = parsed.dispatch ?? true;

  const thread = deps.store.threads.getOrCreate({
    repoOwner: deps.config.owner,
    repoName: deps.config.repo,
    issueNumber: parsed.number,
  });

  // Resolve the chat session up front so the message + dispatched run
  // can both be tagged. If the caller didn't pass one we leave it
  // unset and the message lands without a session id — preserves the
  // pre-multi-session behaviour for callers that don't use the
  // TaskDetailModal session dropdown.
  let chatSessionId: number | undefined;
  if (parsed.chatSessionId !== undefined) {
    const session = deps.store.chatSessions.findById(parsed.chatSessionId);
    if (!session) {
      throw notFound(`chat session ${parsed.chatSessionId} not found`);
    }
    if (session.threadId !== thread.id) {
      throw notFound(
        `chat session ${parsed.chatSessionId} does not belong to thread ${thread.id}`,
      );
    }
    chatSessionId = parsed.chatSessionId;
  }

  const message = deps.store.messages.create({
    threadId: thread.id,
    role: 'user',
    body: parsed.body,
    ...(chatSessionId !== undefined ? { chatSessionId } : {}),
  });
  if (chatSessionId !== undefined) {
    deps.store.chatSessions.touch(chatSessionId);
  }

  let dispatchError: string | null = null;
  if (dispatch) {
    // Scope active/latest lookups to the session when one was supplied
    // so parallel sessions on the same issue thread can run
    // independently. Falls back to thread-wide lookups otherwise to
    // keep legacy issue replies behaving exactly as before.
    const active =
      chatSessionId !== undefined
        ? deps.store.agentRuns.findActiveForChatSession(chatSessionId)
        : deps.store.agentRuns.findActiveForThread(thread.id);
    const latest =
      active ??
      (chatSessionId !== undefined
        ? deps.store.agentRuns.findLatestForChatSession(chatSessionId)
        : deps.store.agentRuns.findLatestForThread(thread.id));
    const willResume =
      (active !== null && active.status === 'awaiting_input') ||
      (active === null &&
        latest !== null &&
        latest.sessionId !== null &&
        latest.worktreePath !== null);
    const willStart = active === null && !willResume;
    if (willResume || willStart) {
      try {
        const issue = await deps.source.getIssue(parsed.number);
        if (issue.labels.includes('type:autopilot')) {
          throw badRequest(
            'Autopilot tasks are managed by the orchestrator and cannot accept dispatched messages. Reply to its child tasks instead.',
          );
        }
        const taskPrompt = buildTaskSystemPrompt(issue);
        const appendSystemPrompt =
          parsed.appendSystemPrompt !== undefined
            ? `${taskPrompt}\n\n${parsed.appendSystemPrompt}`
            : taskPrompt;
        if (willResume && latest !== null) {
          await deps.supervisor.resume({
            runId: latest.id,
            prompt: parsed.body,
            appendSystemPrompt,
          });
        } else {
          await deps.supervisor.start({
            threadId: thread.id,
            issueNumber: parsed.number,
            prompt: parsed.body,
            ...(parsed.model !== undefined ? { model: parsed.model } : {}),
            ...(parsed.provider !== undefined ? { provider: parsed.provider } : {}),
            ...(parsed.repoId !== undefined ? { repoId: parsed.repoId } : {}),
            ...(chatSessionId !== undefined ? { chatSessionId } : {}),
            appendSystemPrompt,
          });
        }
      } catch (err) {
        dispatchError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  return {
    message,
    thread: buildThreadPayload(deps, thread.id),
    ...(dispatchError !== null ? { dispatchError } : {}),
  };
}

export async function listRuns(
  deps: HandlerDeps,
  args: ListRunsArgs,
): Promise<AgentRun[]> {
  const parsed = parseArgs(listRunsSchema, args);
  const thread = deps.store.threads.findByIssue(
    deps.config.owner,
    deps.config.repo,
    parsed.number,
  );
  if (!thread) return [];
  const runs = deps.store.agentRuns.listByThread(thread.id);
  runs.sort((a, b) => b.id - a.id);
  return runs;
}

export async function dispatch(
  deps: HandlerDeps,
  args: DispatchArgs,
): Promise<DispatchResult> {
  const parsed = parseArgs(dispatchSchema, args);
  const fromStatus = parsed.fromStatus ?? null;

  const issue = await deps.source.getIssue(parsed.number);
  if (issue.labels.includes('type:autopilot')) {
    throw badRequest(
      'Autopilot tasks are managed by the orchestrator and cannot be dispatched directly. Use the Autopilot launcher to start or stop them.',
    );
  }
  const thread = deps.store.threads.getOrCreate({
    repoOwner: deps.config.owner,
    repoName: deps.config.repo,
    issueNumber: parsed.number,
  });

  const active = deps.store.agentRuns.findActiveForThread(thread.id);
  if (active !== null) {
    throw alreadyActive(
      `agent run #${active.id} is already ${active.status}`,
      active,
    );
  }

  const priorRuns = deps.store.agentRuns.listByThread(thread.id);
  const kickoff = buildDispatchKickoff(
    { number: issue.number, title: issue.title, body: issue.body ?? '' },
    fromStatus,
    priorRuns.length > 0,
  );

  const message = deps.store.messages.create({
    threadId: thread.id,
    role: 'system',
    body: dispatchSummary(fromStatus, priorRuns.length > 0),
  });

  const run = await deps.supervisor.start({
    threadId: thread.id,
    issueNumber: parsed.number,
    prompt: kickoff,
    appendSystemPrompt: buildTaskSystemPrompt(issue),
    ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    ...(parsed.provider !== undefined ? { provider: parsed.provider } : {}),
    ...(parsed.repoId !== undefined ? { repoId: parsed.repoId } : {}),
  });
  return { run, message };
}

export function decorateIssue(
  issue: Issue,
  activeRun: IssueActiveRunPayload | null = null,
  sentryMeta: SentryMetaPayload | null = null,
  subIssueCount = 0,
): DecoratedIssue {
  // Live agent_runs row is the source of truth for "is this card being worked
  // on right now". Labels lag behind (they're only refreshed on certain code
  // paths and demoted at startup), so a fork/re-dispatch can leave a stale
  // 'idle' label on an issue that the supervisor is actively running. Override
  // here so the card always reflects reality when there's an active run.
  let agent = agentFromLabels(issue.labels);
  if (activeRun !== null) {
    if (activeRun.status === 'starting' || activeRun.status === 'running') {
      agent = 'running';
    } else if (activeRun.status === 'awaiting_input') {
      agent = 'blocked';
    }
  }
  return {
    ...issue,
    status: statusFromLabels(issue.labels),
    agent,
    activeRun,
    sentryMeta,
    ...(subIssueCount > 0 ? { subIssueCount } : {}),
  };
}

export function buildSentryMetaMap(deps: HandlerDeps): Map<number, SentryMetaPayload> {
  const out = new Map<number, SentryMetaPayload>();
  for (const [number, row] of deps.store.sentryImports.mapByLocalNumber()) {
    out.set(number, sentryImportToPayload(row));
  }
  return out;
}

export function lookupSentryMeta(
  deps: HandlerDeps,
  issueNumber: number,
): SentryMetaPayload | null {
  const row = deps.store.sentryImports.findByLocalNumber(issueNumber);
  return row ? sentryImportToPayload(row) : null;
}

function sentryImportToPayload(row: {
  sentryIssueId: string;
  status: 'imported' | 'analyzed' | 'applied' | 'upstream_resolved';
  count: number;
  permalink: string | null;
  culprit: string | null;
  errorType: string | null;
  errorValue: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  analyzedAt: string | null;
  suggestion: SentryMetaPayload['suggestion'];
}): SentryMetaPayload {
  return {
    sentryIssueId: row.sentryIssueId,
    status: row.status,
    count: row.count,
    permalink: row.permalink,
    culprit: row.culprit,
    errorType: row.errorType,
    errorValue: row.errorValue,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    analyzedAt: row.analyzedAt,
    suggestion: row.suggestion,
  };
}

export function buildActiveRunMap(
  deps: HandlerDeps,
): Map<number, IssueActiveRunPayload> {
  const out = new Map<number, IssueActiveRunPayload>();
  const active = deps.store.agentRuns.listActiveForRepo(
    deps.config.owner,
    deps.config.repo,
  );
  if (active.length === 0) return out;
  const runIds = active.map((r) => r.id);
  const latestTool = deps.store.events.findLatestToolUseByRun(runIds);
  const pending = deps.store.cards.findPendingByRuns(runIds);
  const checksByRun = deps.store.checks.findLatestByRunsAndKinds(runIds);
  for (const row of active) {
    const tool = latestTool.get(row.id);
    let toolName: string | null = null;
    let toolArg: string | null = null;
    if (tool && tool.type === 'tool_use') {
      const p = tool.payload as { name?: string; input?: unknown } | null;
      toolName = p?.name ?? null;
      const input = p?.input;
      if (typeof input === 'string') {
        toolArg = input;
      } else if (input !== null && typeof input === 'object') {
        try {
          toolArg = JSON.stringify(input);
        } catch {
          toolArg = null;
        }
      }
    }
    const card = pending.get(row.id);
    let decision: IssueActiveRunPayload['pendingDecision'] = null;
    if (card && card.type === 'decision') {
      const p = card.payload as
        | {
            question?: string;
            options?: Array<{ value?: string; label?: string }>;
          }
        | undefined;
      if (p && typeof p.question === 'string' && Array.isArray(p.options)) {
        const options = p.options
          .filter(
            (o): o is { value: string; label: string } =>
              typeof o?.value === 'string' && typeof o?.label === 'string',
          )
          .map((o) => ({ value: o.value, label: o.label }));
        if (options.length > 0) {
          decision = { cardId: card.id, question: p.question, options };
        }
      }
    }
    const checkMap = checksByRun.get(row.id);
    const checksPayload = checkMap
      ? {
          typecheck: (checkMap.get('typecheck')?.status ?? 'idle') as
            | 'pass'
            | 'fail'
            | 'running'
            | 'idle',
          tests: (checkMap.get('tests')?.status ?? 'idle') as
            | 'pass'
            | 'fail'
            | 'running'
            | 'idle',
          lint: (checkMap.get('lint')?.status ?? 'idle') as
            | 'pass'
            | 'fail'
            | 'running'
            | 'idle',
        }
      : null;
    out.set(row.issueNumber, {
      id: row.id,
      status: row.status,
      branch: row.branchName,
      model: row.model,
      startedAt: row.startedAt,
      currentTool: toolName,
      currentArg: toolArg,
      totalCostUsd: row.totalCostUsd,
      pendingDecision: decision,
      checks: checksPayload,
      previewUrl: row.previewUrl,
      previewState: row.previewState,
    });
  }
  return out;
}

export function buildThreadPayload(
  deps: HandlerDeps,
  threadId: number,
): ThreadPayload | null {
  const thread = deps.store.threads.findById(threadId);
  if (!thread) return null;
  const activeRun = deps.store.agentRuns.findActiveForThread(thread.id);
  const latestRun = activeRun ?? deps.store.agentRuns.findLatestForThread(thread.id);
  const messages: Message[] = deps.store.messages.list(thread.id);
  return {
    id: thread.id,
    createdAt: thread.createdAt,
    messages,
    activeRun,
    latestRun,
  };
}

export function buildTaskSystemPrompt(issue: {
  number: number;
  title: string;
  body?: string | null;
}): string {
  const body = issue.body && issue.body.trim().length > 0 ? issue.body : '(no description)';
  return `TASK_CONTEXT — this conversation is scoped to a single task in the kanbots project. Use it for every turn.

Task #${issue.number}: ${issue.title}

${body}

When the user says "this task", "this issue", "the ticket", "this ticket", or refers to "the task" without naming another, they always mean Task #${issue.number} above. Do not ask the user which task — proceed on Task #${issue.number}.`;
}

function buildDispatchKickoff(
  issue: { number: number; title: string; body: string },
  fromStatus: StatusKey | null,
  hasPriorRuns: boolean,
): string {
  // Cursor (and other stream-json adapters that don't parse ```kanbots-decision```)
  // used to dump the fence as plain text, mark the run complete, and leave the
  // card in Review with no clickable options. Autopilot already ships
  // proceed-directly; Dispatch matches that so drag/Dispatch actually codes.
  let context: string;
  if (fromStatus === 'review') {
    context =
      'This task came back from Review. Address review feedback if any; otherwise continue the previous direction and finish the acceptance criteria.';
  } else if (fromStatus === 'done') {
    context =
      'This task was Done and is In Progress again. Investigate what still needs work, then extend or fix until acceptance is met.';
  } else if (hasPriorRuns) {
    context =
      'Prior agent runs on this thread did not finish. Start fresh from the acceptance criteria below — ignore empty or decision-only prior branches.';
  } else {
    context =
      'First agent run for this task. Proceed from the description and acceptance criteria as written.';
  }

  const taskHeader = `Task #${issue.number}: ${issue.title}\n\n${issue.body || '(no description)'}`;

  return `${taskHeader}

---

CONTEXT: ${context}

Proceed directly — do not emit a kanbots-decision asking how to approach. Investigate the codebase, make the change, run any checks you have available (prefer ./scripts/verify.sh when present), commit on this branch, and finish when the task is complete. Only emit a kanbots-decision mid-run if a true blocker needs a human choice.

Do not leave long-running processes (npm run dev, tsx watch, servers, watchers) attached to this turn — they never exit and the run hangs as "running". Stop them before claiming done; use one-shot checks or the app Preview instead.`;
}

function dispatchSummary(
  fromStatus: StatusKey | null,
  hasPriorRuns: boolean,
): string {
  if (fromStatus === 'review') return 'Moved from Review back to In Progress.';
  if (fromStatus === 'done') return 'Moved from Done back to In Progress.';
  if (hasPriorRuns) return 'Moved to In Progress (prior runs exist).';
  return 'Moved to In Progress.';
}
