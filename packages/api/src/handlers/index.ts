import type {
  BridgeChannels,
  ChannelArgs,
  ChannelName,
  ChannelResult,
} from '../bridge.js';
import * as agentActions from './agent-actions.js';
import * as agentChecks from './agent-checks.js';
import * as agentCli from './agent-cli.js';
import * as agentEvents from './agent-events.js';
import * as agentPreview from './agent-preview.js';
import * as agentRuns from './agent-runs.js';
import * as analytics from './analytics.js';
import * as attachments from './attachments.js';
import * as autopilot from './autopilot.js';
import * as readyToGo from './ready-to-go.js';
import * as cardTemplates from './card-templates.js';
import * as cards from './cards.js';
import * as chat from './chat.js';
import * as composer from './composer.js';
import * as config from './config.js';
import * as cooldown from './cooldown.js';
import * as cost from './cost.js';
import * as decisions from './decisions.js';
import * as issueRelations from './issue-relations.js';
import * as issues from './issues.js';
import * as learnings from './learnings.js';
import * as prComments from './pr-comments.js';
import * as providers from './providers.js';
import type { ProvidersHandlerDeps } from './providers.js';
import * as reviewComments from './review-comments.js';
import * as sentry from './sentry.js';
import * as ship from './ship.js';
import type {
  ChatToolRuntime,
  CreateHandlersOptions,
  HandlerDeps,
  ProvidersRuntime,
  SentryRuntime,
  SubscriptionRegistry,
} from './types.js';
import * as workspace from './workspace.js';

export type {
  ChatToolRuntime,
  CreateHandlersOptions,
  HandlerDeps,
  ProvidersRuntime,
  SentryRuntime,
  SubscriptionRegistry,
};
export type { ProvidersHandlerDeps };
export type {
  Config,
  DraftIssueFn,
  SentryAnalyzerFn,
  SuggestFeatureFn,
} from './types.js';
export type { RunCheckImpl } from './agent-checks.js';
export type { StartPreviewImpl } from './agent-preview.js';

export type Handlers = {
  [C in ChannelName]: (
    args: ChannelArgs<C>,
  ) => Promise<ChannelResult<C>>;
};

export type { BridgeChannels, ChannelArgs, ChannelName, ChannelResult };

export function createHandlers(opts: CreateHandlersOptions): Handlers {
  const { deps } = opts;
  const map: Handlers = {
    'config:get': () => config.getConfig(deps),
    'issues:list': (args) => issues.list(deps, args),
    'issues:list-archived': () => issues.listArchived(deps),
    'issues:get': (args) => issues.get(deps, args),
    'issues:create': (args) => issues.create(deps, args),
    'issues:patch': (args) => issues.patch(deps, args),
    'issues:add-comment': (args) => issues.addComment(deps, args),
    'issues:post-message': (args) => issues.postMessage(deps, args),
    'issues:list-runs': (args) => issues.listRuns(deps, args),
    'issues:dispatch': (args) => issues.dispatch(deps, args),
    'issues:start-agent': (args) => agentActions.startAgent(deps, args),
    'issues:archive': (args) => agentActions.archive(deps, args),
    'issues:unarchive': (args) => agentActions.unarchive(deps, args),
    'issues:approve': (args) => agentActions.approve(deps, args),
    'issues:request-changes': (args) => agentActions.requestChanges(deps, args),
    'issues:split': (args) => agentActions.split(deps, args),
    'issues:reviewer': (args) => agentActions.reviewer(deps, args),
    'issue-relations:list-children': (args) => issueRelations.listChildren(deps, args),
    'issue-relations:list-parents': (args) => issueRelations.listParents(deps, args),
    'issue-relations:add': (args) => issueRelations.add(deps, args),
    'issue-relations:remove': (args) => issueRelations.remove(deps, args),
    'ship:status': (args) => ship.status(deps, args),
    'ship:commit': (args) => ship.commit(deps, args),
    'ship:merge': (args) => ship.merge(deps, args),
    'ship:create-pr': (args) => ship.createPR(deps, args),
    'agent-runs:get': (args) => agentRuns.get(deps, args),
    'agent-runs:stop': (args) => agentRuns.stop(deps, args),
    'agent-runs:diff': (args) => agentRuns.diff(deps, args),
    'agent-runs:stats': (args) => agentRuns.stats(deps, args),
    'agent-runs:reveal-worktree': (args) => agentRuns.revealWorktree(deps, args),
    'agent-runs:checks:list': (args) => agentChecks.list(deps, args),
    'agent-runs:checks:run': (args) => agentChecks.runChecks(deps, args),
    'agent-runs:checks:commands': () => agentChecks.commands(deps),
    'agent-cli:slash-commands': (args) => agentCli.slashCommands(deps, args),
    'agent-runs:preview:get': (args) => agentPreview.getPreview(deps, args),
    'agent-runs:preview:start': (args) =>
      agentPreview.startRunPreview(deps, args),
    'agent-runs:preview:stop': (args) => agentPreview.stopRunPreview(deps, args),
    'agent-runs:fork': (args) => agentRuns.fork(deps, args),
    'agent-runs:promote-commit': (args) => agentRuns.promoteCommit(deps, args),
    'agent-runs:promote-pr': (args) => agentRuns.promotePr(deps, args),
    'agent-runs:draft-pr-description': (args) =>
      agentRuns.draftPrDescription(deps, args),
    'agent-runs:hunks:list': (args) => agentRuns.listHunks(deps, args),
    'agent-runs:events:subscribe': (args) => agentEvents.subscribe(opts, args),
    'agent-runs:events:unsubscribe': (args) =>
      agentEvents.unsubscribe(opts, args),
    'cards:resolve': (args) => cards.resolve(deps, args),
    'cards:dismiss': (args) => cards.dismiss(deps, args),
    'card-templates:list': () => cardTemplates.list(deps),
    'card-templates:create': (args) => cardTemplates.create(deps, args),
    'card-templates:update': (args) => cardTemplates.update(deps, args),
    'card-templates:delete': (args) => cardTemplates.remove(deps, args),
    'card-templates:reorder': (args) => cardTemplates.reorder(deps, args),
    'card-templates:instantiate': (args) => cardTemplates.instantiate(deps, args),
    'decisions:pending': () => decisions.pending(deps),
    'cost:today': () => cost.today(deps),
    'cost:usage': () => cost.usage(deps),
    'cost:breakdown': () => cost.breakdown(deps),
    'cooldown:get': () => cooldown.get(deps),
    'workspace:get': () => workspace.getWorkspace(deps),
    'workspace:get-budgets': () => workspace.getBudgets(deps),
    'workspace:set-budgets': (args) => workspace.setBudgets(deps, args),
    'workspace:get-house-rules': () => workspace.getHouseRules(deps),
    'workspace:set-house-rules': (args) => workspace.setHouseRules(deps, args),
    'workspace:get-scripts': () => workspace.getScripts(deps),
    'workspace:set-scripts': (args) => workspace.setScripts(deps, args),
    'workspace:run-script': (args) => workspace.runScript(deps, args),
    'workspace:get-acp-command': () => workspace.getAcpCommand(deps),
    'workspace:set-acp-command': (args) => workspace.setAcpCommand(deps, args),
    'workspace:repos-list': () => workspace.listRepos(deps),
    'workspace:repos-add': (args) => workspace.addRepo(deps, args),
    'workspace:repos-remove': (args) => workspace.removeRepo(deps, args),
    'workspace:repos-set-primary': (args) => workspace.setPrimaryRepo(deps, args),
    'workspace:repos-set-target-branch': (args) =>
      workspace.setRepoTargetBranch(deps, args),
    'workspace:repos-set-display-name': (args) =>
      workspace.setRepoDisplayName(deps, args),
    'workspace:repo-status': (args) => workspace.repoStatus(deps, args),
    'workspace:open-repo-in-ide': (args) => workspace.openRepoInIde(deps, args),
    'pr-comments:list': (args) => prComments.list(deps, args),
    'pr-comments:reply': (args) => prComments.reply(deps, args),
    'review-comments:list': (args) => reviewComments.list(deps, args),
    'review-comments:list-for-file': (args) => reviewComments.listForFile(deps, args),
    'review-comments:add': (args) => reviewComments.add(deps, args),
    'review-comments:remove': (args) => reviewComments.remove(deps, args),
    'review-comments:consume-pending': (args) =>
      reviewComments.consumePending(deps, args),
    'folders:list': () => workspace.listFolders(deps),
    'folders:add': (args) => workspace.addFolder(deps, args),
    'composer:draft': (args) => composer.draft(deps, args),
    'composer:suggest': (args) => composer.suggest(deps, args),
    'attachments:upload': (args) => attachments.upload(deps, args),
    'autopilot:start': (args) => autopilot.start(deps, args),
    'autopilot:stop': (args) => autopilot.stop(deps, args),
    'autopilot:list-active': () => autopilot.listActive(deps),
    'autopilot:get-by-issue': (args) => autopilot.getByIssue(deps, args),
    'sentry:get-config': () => sentry.getConfig(deps),
    'sentry:save-config': (args) => sentry.saveConfig(deps, args),
    'sentry:test-connection': (args) => sentry.testConnection(deps, args),
    'sentry:sync-now': () => sentry.syncNow(deps),
    'sentry:analyze': (args) => sentry.analyze(deps, args),
    'sentry:apply-suggestion': (args) => sentry.applySuggestion(deps, args),
    'providers:get': () => providers.getConfig(deps),
    'providers:save': (args) => providers.save(deps, args),
    'providers:test-connection': (args) => providers.testConnection(deps, args),
    'providers:set-defaults': (args) => providers.setDefaults(deps, args),
    'chat:list': () => chat.list(deps),
    'chat:create': (args) => chat.create(deps, args),
    'chat:get': (args) => chat.get(deps, args),
    'chat:rename': (args) => chat.rename(deps, args),
    'chat:delete': (args) => chat.deleteConversation(deps, args),
    'chat:post-message': (args) => chat.postMessage(deps, args),
    'chat:stop-run': (args) => chat.stopRun(deps, args),
    'chat:sessions:list': (args) => chat.listSessions(deps, args),
    'chat:sessions:create': (args) => chat.createSession(deps, args),
    'chat:sessions:rename': (args) => chat.renameSession(deps, args),
    'chat:sessions:delete': (args) => chat.deleteSession(deps, args),
    'chat:sessions:set-active': (args) => chat.setActiveSession(deps, args),
    'chat:thread-sessions:list': (args) => chat.listThreadSessions(deps, args),
    'chat:thread-sessions:create': (args) => chat.createThreadSession(deps, args),
    'chat:thread-sessions:rename': (args) => chat.renameThreadSession(deps, args),
    'chat:thread-sessions:delete': (args) => chat.deleteThreadSession(deps, args),
    'learnings:list': (args) => learnings.list(deps, args),
    'learnings:delete': (args) => learnings.deleteLearning(deps, args),
    'learnings:update': (args) => learnings.update(deps, args),
    'learnings:pin': (args) => learnings.pin(deps, args),
    'analytics:rollup': (args) => analytics.rollup(deps, args),
    'analytics:time-series': (args) => analytics.timeSeries(deps, args),
    'analytics:frontier': (args) => analytics.frontier(deps, args),
    'analytics:recent-activity': (args) => analytics.recentActivity(deps, args),
    'ready-to-go:start': (args) => Promise.resolve(readyToGo.readyToGoStart({ readyToGo: deps.readyToGo }, args)),
    'ready-to-go:stop': () => Promise.resolve(readyToGo.readyToGoStop({ readyToGo: deps.readyToGo })),
    'ready-to-go:status': () => Promise.resolve(readyToGo.readyToGoGetStatus({ readyToGo: deps.readyToGo })),
  };
  return map;
}

export type ProvidersHandlers = Pick<
  Handlers,
  'providers:get' | 'providers:save' | 'providers:test-connection' | 'providers:set-defaults'
>;

/**
 * Build the four provider IPC handlers against a narrow `ProvidersHandlerDeps`.
 * Used by the desktop app to register provider channels at app startup against
 * an app-level (not workspace-level) SQLite store, because provider config is
 * per-user, not per-project.
 */
export function createProvidersHandlers(deps: ProvidersHandlerDeps): ProvidersHandlers {
  return {
    'providers:get': () => providers.getConfig(deps),
    'providers:save': (args) => providers.save(deps, args),
    'providers:test-connection': (args) => providers.testConnection(deps, args),
    'providers:set-defaults': (args) => providers.setDefaults(deps, args),
  };
}

export type ChatHandlers = Pick<
  Handlers,
  | 'chat:list'
  | 'chat:create'
  | 'chat:get'
  | 'chat:rename'
  | 'chat:delete'
  | 'chat:post-message'
  | 'chat:stop-run'
  | 'chat:sessions:list'
  | 'chat:sessions:create'
  | 'chat:sessions:rename'
  | 'chat:sessions:delete'
  | 'chat:sessions:set-active'
>;

export interface ChatHandlerDeps {
  store: HandlerDeps['store'];
  supervisor: HandlerDeps['supervisor'];
  chatTools?: ChatToolRuntime;
}

/**
 * Build the chat IPC handlers against a narrow `ChatHandlerDeps`. Registered
 * by the desktop app at startup against a per-device chat store at
 * `userData/device-chats.db`, so chat works in both local-workspace and
 * cloud-only modes and history is shared across workspaces on the device.
 */
export function createChatHandlers(deps: ChatHandlerDeps): ChatHandlers {
  // chat.* handlers only touch deps.store / deps.supervisor / deps.chatTools.
  // Cast keeps the call sites identical to the full-Handlers path without
  // forcing the caller to synthesize the unused source/autopilot/sentry deps.
  const fullDeps = deps as unknown as HandlerDeps;
  return {
    'chat:list': () => chat.list(fullDeps),
    'chat:create': (args) => chat.create(fullDeps, args),
    'chat:get': (args) => chat.get(fullDeps, args),
    'chat:rename': (args) => chat.rename(fullDeps, args),
    'chat:delete': (args) => chat.deleteConversation(fullDeps, args),
    'chat:post-message': (args) => chat.postMessage(fullDeps, args),
    'chat:stop-run': (args) => chat.stopRun(fullDeps, args),
    'chat:sessions:list': (args) => chat.listSessions(fullDeps, args),
    'chat:sessions:create': (args) => chat.createSession(fullDeps, args),
    'chat:sessions:rename': (args) => chat.renameSession(fullDeps, args),
    'chat:sessions:delete': (args) => chat.deleteSession(fullDeps, args),
    'chat:sessions:set-active': (args) => chat.setActiveSession(fullDeps, args),
  };
}
