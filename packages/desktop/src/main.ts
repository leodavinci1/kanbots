import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from 'electron';
import {
  createAutopilotManager,
  createChatHandlers,
  createCurator,
  createHandlers,
  createSupervisor,
  dispatchChatTool,
  reconcileIssueLabels,
  startToolBridge,
  type AgentRunEventPayload,
  type AgentSupervisor,
  type AutopilotManager,
  type ChatHandlers,
  type ChatToolRuntime,
  type DraftIssueFn,
  type DraftPrDescriptionFn,
  type Handlers,
  type SentryAnalyzerFn,
  type SentryRuntime,
  type SuggestFeatureFn,
  type ToolBridge,
} from '@kanbots/api';
import { GitHubClient, resolveGitHubToken, type IssueSource } from '@kanbots/core';
import {
  createComposer,
  createPrDescriptionDrafter,
  createSentryAnalyzer,
  createSuggester,
} from '@kanbots/dispatcher';
import {
  describeKanbotsDir,
  ensureGitignoreEntry,
  ensureKanbotsDir,
  findGitRoot,
  LocalIssueSource,
  openStore,
  readWorkspaceConfig,
  resolveGitUserName,
  writeWorkspaceConfig,
  type Store,
  type WorkspaceConfig,
} from '@kanbots/local-store';
import { cancelClaudeLogin, isClaudeAuthenticated, startClaudeLogin } from './claude-auth.js';
import {
  cancelCodexLogin,
  CODEX_AUTH_PATH,
  isCodexAuthenticated,
  startCodexLogin,
} from './codex-auth.js';
import {
  cancelGeminiLogin,
  GEMINI_AUTH_PATH,
  isGeminiAuthenticated,
  startGeminiLogin,
} from './gemini-auth.js';
import {
  AMP_AUTH_PATH,
  AMP_SETTINGS_PATH,
  cancelAmpLogin,
  isAmpAuthenticated,
  startAmpLogin,
} from './amp-auth.js';
import {
  cancelCursorLogin,
  CURSOR_AUTH_PATH,
  CURSOR_CONFIG_DIR,
  isCursorAuthenticated,
  startCursorLogin,
} from './cursor-auth.js';
import {
  cancelCopilotLogin,
  COPILOT_AUTH_PATH,
  COPILOT_CONFIG_DIR,
  COPILOT_GH_HOSTS_PATH,
  isCopilotAuthenticated,
  startCopilotLogin,
} from './copilot-auth.js';
import {
  cancelOpencodeLogin,
  isOpencodeAuthenticated,
  OPENCODE_AUTH_PATH,
  OPENCODE_CONFIG_DIR,
  startOpencodeLogin,
} from './opencode-auth.js';
import {
  cancelDroidLogin,
  DROID_AUTH_PATH,
  DROID_CONFIG_DIR,
  DROID_MCP_PATH,
  isDroidAuthenticated,
  startDroidLogin,
} from './droid-auth.js';
import {
  cancelCcrLogin,
  CCR_CONFIG_DIR,
  CCR_CONFIG_PATH,
  isCcrAuthenticated,
  startCcrLogin,
} from './ccr-auth.js';
import {
  cancelQwenLogin,
  isQwenAuthenticated,
  QWEN_CONFIG_DIR,
  QWEN_INSTALL_PATH,
  QWEN_SETTINGS_PATH,
  startQwenLogin,
} from './qwen-auth.js';
import {
  cancelCloudLogin,
  clearCloudAuth,
  CloudAuthRequiredError,
  dismissCloudPrompt,
  getCloudStatus,
  getCloudToken,
  pollCloudLogin,
  startCloudLogin,
  type CloudPollResult,
  type CloudStatus,
} from './cloud-auth.js';
import {
  clearCloudProjectBinding,
  getCloudProjectBinding,
  setCloudProjectBinding,
  type CloudProjectBinding,
} from './cloud-bindings.js';
import {
  createCloudClient,
  type AgentRunListResponse,
  type AgentRunSummary,
  type AttachmentListResponse,
  type CardSummary,
  type CommentListResponse,
  type CommentSummary,
  type CreateAgentRunRequest,
  type CreateCardRequest,
  type CreateOrgRequest,
  type CreateOrgResponse,
  type CreateProjectRequest,
  type ListCardsQuery,
  type OrgListResponse,
  type ProjectListResponse,
  type ProjectSummary,
  type UpdateCardRequest,
  type UserMe,
} from '@kanbots/cloud-client';
import { watchDbFile, type DbWatcher } from './db-watcher.js';
import { createSubscriptionRegistry, type OwnedSubscriptionRegistry } from './ipc/subscriptions.js';
import {
  CHANNEL_PREFIX,
  registerHandlers,
  SUBSCRIBE_CHANNEL,
  UNSUBSCRIBE_CHANNEL,
} from './ipc/register.js';
import { toIpcError } from './ipc/errors.js';
import { closeProvidersStoreForShutdown, registerProvidersIpc } from './providers-ipc.js';
import { hydrateProcessEnvFromLoginShell } from './shell-env.js';
import { registerCloudComposerHandlers } from './cloud-composer.js';
import { startCloudRun, type CloudRunHandle } from './cloud-run-dispatcher.js';
import { broadcastWorkspaceTouched, registerWorkspaceTreeIpc } from './workspace-tree-ipc.js';
import { SentryPoller } from './sentry-poller.js';
import {
  decryptToken,
  encryptToken,
  envTokenOverride,
  safeStorageAvailable,
} from './sentry-token.js';
import { hasClaudeCodeCredentials } from './providers-key.js';
import type {
  ActiveCloudWorkspaceInfo,
  ActiveWorkspaceInfo,
  BootstrapPayload,
  RecentCloudWorkspace,
  RecentWorkspace,
} from './types.js';
import type { AgentRun, AgentRunStatus } from '@kanbots/local-store';

interface ActiveWorkspace {
  repoPath: string;
  config: WorkspaceConfig;
  store: Store;
  source: IssueSource;
  supervisor: AgentSupervisor;
  autopilot: AutopilotManager;
  draftIssue: DraftIssueFn;
  suggestIssue: SuggestFeatureFn;
  draftPrDescription: DraftPrDescriptionFn;
  analyzeSentryError: SentryAnalyzerFn;
  sentryPoller: SentryPoller;
  subscriptions: OwnedSubscriptionRegistry;
  unregisterHandlers: () => void;
  ownerId: number;
  detachOwnerCleanup: () => void;
  cooldownUnsub: () => void;
  dbWatcher: DbWatcher;
  toolBridge: ToolBridge | null;
  toolBridgeRuntimeDir: string | null;
}

process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason);
});

let activeWorkspace: ActiveWorkspace | null = null;
/**
 * Free-floating cloud workspace (no git repo). Mutually exclusive
 * with `activeWorkspace` — opening one closes the other so the
 * renderer always sees exactly one active workspace.
 */
let activeCloudWorkspace: ActiveCloudWorkspaceInfo | null = null;
let cloudComposerUnregister: (() => void) | null = null;
const activeCloudRuns = new Map<string, CloudRunHandle>();
/**
 * In-flight cloud run-event SSE streams keyed by subscription id.
 * Renderer holds the matching ids; calling -stream-stop aborts.
 */
const cloudRunStreamControllers = new Map<string, AbortController>();
let mainWindow: BrowserWindow | null = null;
const chatWindows = new Set<BrowserWindow>();

/**
 * Per-device chat store + supervisor. Lives at `userData/device-chats.db`
 * so chat history survives workspace switches and works in cloud-only
 * mode. Lazily initialized on first chat IPC; the cwd resolver below
 * picks whichever workspace is currently active (local repo, cloud-bound
 * local repo, or the userData fallback).
 */
let deviceChatStore: Store | null = null;
let deviceChatSupervisor: AgentSupervisor | null = null;
let deviceChatSubscriptions: OwnedSubscriptionRegistry | null = null;

const DEFAULT_CLOUD_BASE_URL = process.env['KANBOTS_CLOUD_BASE_URL'] ?? 'https://app.kanbots.dev';

/**
 * Process-wide cloud client. The base URL and token are resolved
 * lazily on each call so login/logout/endpoint changes propagate
 * without restarting the app.
 */
const cloudClient = createCloudClient({
  getToken: getCloudToken,
  getBaseUrl: async () => {
    const status = await getCloudStatus();
    return status.baseUrl ?? DEFAULT_CLOUD_BASE_URL;
  },
  // Forward a Vercel deployment-protection bypass token when one is set in
  // the environment. Lets developers point at protected preview/branch
  // deploys (e.g. staging) without disabling protection. Unset by default.
  getBypassToken: async () => process.env['KANBOTS_CLOUD_BYPASS_TOKEN'] ?? null,
});

function appIconOption(): { icon: string } | Record<string, never> {
  const candidate = join(__dirname, 'icon.png');
  return existsSync(candidate) ? { icon: candidate } : {};
}

function findWebContentsForOwner(ownerId: number | undefined): Electron.WebContents | null {
  if (ownerId === undefined) {
    return mainWindow?.webContents ?? null;
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.id === ownerId) return win.webContents;
  }
  return mainWindow?.webContents ?? null;
}

const RECENTS_LIMIT = 20;

function recentsPath(): string {
  return join(app.getPath('userData'), 'workspaces.json');
}

async function readRecents(): Promise<RecentWorkspace[]> {
  try {
    const raw = await readFile(recentsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as { recents?: RecentWorkspace[] };
    return Array.isArray(parsed.recents) ? parsed.recents : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [];
  }
}

async function writeRecents(list: RecentWorkspace[]): Promise<void> {
  const path = recentsPath();
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify({ recents: list }, null, 2), 'utf-8');
}

async function recordRecent(repoPath: string, displayName: string): Promise<void> {
  const list = await readRecents();
  const filtered = list.filter((r) => r.repoPath !== repoPath);
  filtered.unshift({
    repoPath,
    displayName,
    lastOpenedAt: new Date().toISOString(),
  });
  await writeRecents(filtered.slice(0, RECENTS_LIMIT));
}

async function pruneMissingRecents(): Promise<RecentWorkspace[]> {
  const list = await readRecents();
  const present = list.filter((r) => existsSync(r.repoPath));
  if (present.length !== list.length) await writeRecents(present);
  return present;
}

function cloudRecentsPath(): string {
  return join(app.getPath('userData'), 'cloud-workspaces.json');
}

async function readCloudRecents(): Promise<RecentCloudWorkspace[]> {
  try {
    const raw = await readFile(cloudRecentsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as { recents?: RecentCloudWorkspace[] };
    return Array.isArray(parsed.recents) ? parsed.recents : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [];
  }
}

async function writeCloudRecents(list: RecentCloudWorkspace[]): Promise<void> {
  const path = cloudRecentsPath();
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify({ recents: list }, null, 2), 'utf-8');
}

async function recordCloudRecent(entry: Omit<RecentCloudWorkspace, 'lastOpenedAt'>): Promise<void> {
  const list = await readCloudRecents();
  const filtered = list.filter(
    (r) => !(r.orgSlug === entry.orgSlug && r.projectSlug === entry.projectSlug),
  );
  filtered.unshift({ ...entry, lastOpenedAt: new Date().toISOString() });
  await writeCloudRecents(filtered.slice(0, RECENTS_LIMIT));
}

function stripHouseRules(config: WorkspaceConfig): WorkspaceConfig {
  const { houseRules: _omit, ...rest } = config;
  return rest as WorkspaceConfig;
}

function stripAcpCommand(config: WorkspaceConfig): WorkspaceConfig {
  const { acpCommand: _omit, ...rest } = config;
  return rest as WorkspaceConfig;
}

async function ensureLocalWorkspace(repoPath: string): Promise<WorkspaceConfig> {
  const existing = await readWorkspaceConfig(repoPath);
  if (existing) return existing;
  const authorLogin = await resolveGitUserName(repoPath);
  const config: WorkspaceConfig = {
    mode: 'local',
    name: basename(repoPath),
    authorLogin,
  };
  await writeWorkspaceConfig(repoPath, config);
  return config;
}

function broadcastIssueChange(): void {
  const sender = mainWindow?.webContents;
  if (!sender || sender.isDestroyed()) return;
  sender.send('issues:changed', {});
}

function forwardAgentRunEvent(payload: AgentRunEventPayload, ownerId: number | undefined): void {
  const target = findWebContentsForOwner(ownerId);
  if (target && !target.isDestroyed()) {
    target.send('agent-runs:events:data', payload);
  }
  if (payload.kind === 'status') broadcastIssueChange();
}

function wrapNotifyingSource(source: IssueSource): IssueSource {
  const wrapped: IssueSource = {
    listIssues: (opts) => source.listIssues(opts),
    getIssue: (n) => source.getIssue(n),
    listComments: (n) => source.listComments(n),
    addComment: (n, body) => source.addComment(n, body),
    createIssue: async (input) => {
      const r = await source.createIssue(input);
      broadcastIssueChange();
      return r;
    },
    updateIssue: async (n, patch) => {
      const r = await source.updateIssue(n, patch);
      broadcastIssueChange();
      return r;
    },
  };
  if (source.openDraftPR) {
    wrapped.openDraftPR = source.openDraftPR.bind(source);
  }
  return wrapped;
}

function wrapNotifyingSupervisor(supervisor: AgentSupervisor): AgentSupervisor {
  return {
    ...supervisor,
    start: async (input) => {
      const r = await supervisor.start(input);
      broadcastIssueChange();
      return r;
    },
    resume: async (input) => {
      const r = await supervisor.resume(input);
      broadcastIssueChange();
      return r;
    },
    stop: async (id) => {
      const r = await supervisor.stop(id);
      broadcastIssueChange();
      return r;
    },
  };
}

async function buildSource(config: WorkspaceConfig, store: Store): Promise<IssueSource> {
  if (config.mode === 'github') {
    const token = await resolveGitHubToken();
    return new GitHubClient({
      owner: config.owner,
      repo: config.repo,
      token,
      cache: store.httpCache,
    });
  }
  return new LocalIssueSource({
    repo: store.localIssues,
    authorLogin: config.authorLogin,
  });
}

async function closeActiveWorkspace(): Promise<void> {
  // Free-floating cloud workspace has no local resources, so closing
  // is just clearing the state. Done first so renderer never sees
  // both kinds set at once.
  closeActiveCloudWorkspace();
  // Chat windows are bound to the workspace's SQLite db; close them before
  // ripping the workspace down so the renderer stops sending IPC into
  // handlers that are about to disappear.
  if (chatWindows.size > 0) {
    closeAllChatWindows();
  }
  if (!activeWorkspace) return;
  try {
    activeWorkspace.cooldownUnsub();
  } catch {
    // ignore
  }
  try {
    activeWorkspace.detachOwnerCleanup();
  } catch {
    // ignore
  }
  try {
    activeWorkspace.sentryPoller.stop();
  } catch {
    // ignore
  }
  try {
    await activeWorkspace.autopilot.stopAllForShutdown();
  } catch {
    // ignore
  }
  try {
    activeWorkspace.subscriptions.closeAllForOwner(activeWorkspace.ownerId);
  } catch {
    // ignore
  }
  try {
    activeWorkspace.unregisterHandlers();
  } catch {
    // ignore
  }
  try {
    activeWorkspace.dbWatcher.stop();
  } catch {
    // ignore
  }
  if (activeWorkspace.toolBridge) {
    try {
      await activeWorkspace.toolBridge.close();
    } catch {
      // ignore
    }
  }
  try {
    activeWorkspace.store.close();
  } catch {
    // ignore
  }
  activeWorkspace = null;
}

async function openWorkspaceInternal(repoPath: string): Promise<ActiveWorkspaceInfo> {
  const gitRoot = await findGitRoot(repoPath);
  if (!gitRoot) {
    throw new Error(
      `${repoPath} is not inside a git repository. Run \`git init\` there and try again.`,
    );
  }

  await ensureKanbotsDir(gitRoot);
  let config = await ensureLocalWorkspace(gitRoot);

  await closeActiveWorkspace();

  const kdir = describeKanbotsDir(gitRoot);
  const store = openStore({ path: kdir.dbPath });

  // Catch external db writes (other process, direct sqlite3 edits) — the
  // notify-wrappers below only cover writes that go through our handlers.
  const dbWatcher = watchDbFile(kdir.dbPath, broadcastIssueChange);

  let source: IssueSource;
  try {
    source = wrapNotifyingSource(await buildSource(config, store));
  } catch (err) {
    dbWatcher.stop();
    store.close();
    throw err;
  }

  const sentryPoller = new SentryPoller({
    store,
    source: source,
    broadcast: broadcastIssueChange,
  });
  const sentryRuntime: SentryRuntime = {
    encryptToken,
    decryptToken,
    envTokenOverride,
    safeStorageAvailable,
    syncNow: () => sentryPoller.runOnce(),
    restartPoller: () => sentryPoller.restart(),
  };

  const providersRuntime = {
    safeStorageAvailable,
    hasClaudeCodeCredentials,
  };

  const containmentEnv = process.env.KANBOTS_CONTAINMENT_MODE;
  const containmentMode: 'off' | 'warn' | 'pause' =
    containmentEnv === 'off' || containmentEnv === 'pause' ? containmentEnv : 'warn';

  const budgetsState = {
    runCostBudgetUsd: config.defaults?.runCostBudgetUsd ?? null,
    sessionCostBudgetUsd: config.defaults?.sessionCostBudgetUsd ?? null,
  };

  const houseRulesState = {
    houseRules: config.houseRules ?? null,
  };

  const acpCommandState = {
    acpCommand: config.acpCommand ?? null,
  };

  // Curator runs after every successful agent run on this workspace, distilling
  // events into durable learnings. Cheap by default (Haiku, per-day budget cap)
  // and gracefully no-ops when the run signal isn't `completed_clean`/`promoted`.
  const curator = createCurator({ store, cwd: gitRoot });

  const rawSupervisor = await createSupervisor({
    store,
    repoPath: gitRoot,
    containmentMode,
    defaultRunCostBudgetUsd: () => budgetsState.runCostBudgetUsd,
    houseRules: () => houseRulesState.houseRules,
    acpCommand: () => acpCommandState.acpCommand,
    onRunStatusChange: async (run) => {
      try {
        await maybeNotifyRunStatus(run, store, source);
      } catch {
        // best-effort: never let notification failures break the supervisor
      }
    },
    onRunComplete: async (run) => {
      // Two best-effort tasks fan out from a successful run:
      //   1. Mirror the run's outcome onto the issue's labels (status:review,
      //      agent:idle).
      //   2. Dispatch the memory-ledger curator so this run feeds future ones.
      // Both run in parallel; failures of either are logged-and-swallowed.
      const labelTask = (async () => {
        const thread = store.threads.findById(run.threadId);
        if (!thread) return;
        const issue = await source.getIssue(thread.issueNumber);
        if (issue.labels.includes('archived')) return;
        const labels = issue.labels.filter(
          (l) => !l.startsWith('status:') && !l.startsWith('agent:'),
        );
        labels.push('status:review', 'agent:idle');
        await source.updateIssue(thread.issueNumber, { labels });
      })().catch(() => {
        // label errors must not crash the supervisor hook
      });
      const curatorTask = curator(run).catch(() => {
        // curator failures must not crash the supervisor hook
      });
      await Promise.allSettled([labelTask, curatorTask]);
    },
  });
  const supervisor = wrapNotifyingSupervisor(rawSupervisor);
  const draftIssue = createComposer({ cwd: gitRoot });
  const suggestIssue = createSuggester({ cwd: gitRoot });
  const draftPrDescription = createPrDescriptionDrafter({ cwd: gitRoot });
  const analyzeSentryError = createSentryAnalyzer({ cwd: gitRoot });

  // Demote any in-progress / agent-running labels left over from a previous
  // session. The supervisor sweep above marked stale runs failed; this
  // mirrors that on the issue side so the board doesn't show ghost work.
  const reconcileOwner = config.mode === 'github' ? config.owner : 'local';
  const reconcileRepo = config.mode === 'github' ? config.repo : config.name;
  await reconcileIssueLabels(source, store, reconcileOwner, reconcileRepo).catch(() => {
    // best-effort
  });

  // Preview-proxy injection assets are copied next to the compiled main.cjs
  // at build time (see desktop/tsup.config.ts onSuccess). Hand the absolute
  // path to the api layer so the dispatcher can serve them at runtime even
  // though it's bundled into this process.
  const previewAssetsDir = join(__dirname, 'assets');

  const apiConfig =
    config.mode === 'github'
      ? {
          mode: 'github' as const,
          owner: config.owner,
          repo: config.repo,
          repoPath: gitRoot,
          containmentMode,
          previewAssetsDir,
        }
      : {
          mode: 'local' as const,
          owner: 'local',
          repo: config.name,
          repoPath: gitRoot,
          authorLogin: config.authorLogin,
          containmentMode,
          previewAssetsDir,
        };

  const cooldownUnsub = supervisor.subscribeCooldown((state) => {
    const sender = mainWindow?.webContents;
    if (!sender || sender.isDestroyed()) return;
    sender.send('cooldown:changed', state);
  });

  const subscriptions = createSubscriptionRegistry({
    supervisor,
    forward: forwardAgentRunEvent,
  });
  const autopilot = createAutopilotManager({
    store,
    source,
    supervisor,
    suggestIssue,
    repoPath: gitRoot,
    repoConfig: { owner: apiConfig.owner, repo: apiConfig.repo },
    defaultSessionCostBudgetUsd: () => budgetsState.sessionCostBudgetUsd,
    onSessionChange: () => broadcastIssueChange(),
  });
  // The tool-bridge dispatches MCP calls into the same handlers map the
  // IPC bridge serves. Handlers don't exist yet (they reference the bridge
  // via chatTools), so we capture a late-bound slot the bridge consults at
  // request time.
  const handlersHolder: { handlers: Handlers | null } = { handlers: null };
  let toolBridge: ToolBridge | null = null;
  let toolBridgeRuntimeDir: string | null = null;
  let chatTools: ChatToolRuntime | undefined;
  try {
    toolBridge = await startToolBridge({
      handlers: {} as Handlers,
      dispatch: (name, args) => {
        const h = handlersHolder.handlers;
        if (!h) throw new Error('handlers not yet ready');
        return dispatchChatTool(name, args, h);
      },
    });
    toolBridgeRuntimeDir = join(kdir.root, 'mcp-runtime');
    await mkdir(toolBridgeRuntimeDir, { recursive: true });
    const mcpServerEntry = resolveMcpServerEntry();
    if (mcpServerEntry) {
      chatTools = buildChatToolRuntime({
        toolBridge,
        runtimeDir: toolBridgeRuntimeDir,
        mcpServerEntry,
      });
    }
  } catch (err) {
    console.error('[main] tool-bridge bootstrap failed:', err);
    toolBridge = null;
    chatTools = undefined;
  }

  const handlers = createHandlers({
    deps: {
      source,
      store,
      config: apiConfig,
      supervisor,
      draftIssue,
      suggestIssue,
      draftPrDescription,
      autopilot,
      analyzeSentryError,
      sentry: sentryRuntime,
      providers: providersRuntime,
      ...(chatTools ? { chatTools } : {}),
      budgets: {
        get: () => ({
          runCostBudgetUsd: budgetsState.runCostBudgetUsd,
          sessionCostBudgetUsd: budgetsState.sessionCostBudgetUsd,
        }),
        set: async (input) => {
          budgetsState.runCostBudgetUsd = input.runCostBudgetUsd;
          budgetsState.sessionCostBudgetUsd = input.sessionCostBudgetUsd;
          const defaults = {
            runCostBudgetUsd: input.runCostBudgetUsd,
            sessionCostBudgetUsd: input.sessionCostBudgetUsd,
          };
          const next: WorkspaceConfig =
            config.mode === 'github' ? { ...config, defaults } : { ...config, defaults };
          await writeWorkspaceConfig(gitRoot, next);
          config = next;
          if (activeWorkspace && activeWorkspace.repoPath === gitRoot) {
            activeWorkspace.config = next;
          }
        },
      },
      houseRules: {
        get: () => ({ houseRules: houseRulesState.houseRules }),
        set: async (input) => {
          houseRulesState.houseRules = input.houseRules;
          const next: WorkspaceConfig =
            input.houseRules === null
              ? stripHouseRules(config)
              : { ...config, houseRules: input.houseRules };
          await writeWorkspaceConfig(gitRoot, next);
          config = next;
          if (activeWorkspace && activeWorkspace.repoPath === gitRoot) {
            activeWorkspace.config = next;
          }
        },
      },
      acpCommand: {
        get: () => ({ acpCommand: acpCommandState.acpCommand }),
        set: async (input) => {
          acpCommandState.acpCommand = input.acpCommand;
          const next: WorkspaceConfig =
            input.acpCommand === null
              ? stripAcpCommand(config)
              : { ...config, acpCommand: input.acpCommand };
          await writeWorkspaceConfig(gitRoot, next);
          config = next;
          if (activeWorkspace && activeWorkspace.repoPath === gitRoot) {
            activeWorkspace.config = next;
          }
        },
      },
      revealPath: async (path) => {
        const error = await shell.openPath(path);
        if (error) throw new Error(error);
      },
      onSuggestEvent: (event) => {
        const sender = mainWindow?.webContents;
        if (!sender || sender.isDestroyed()) return;
        sender.send('composer:suggest:event', event);
      },
    },
    subscriptions,
  });
  const unregisterHandlers = registerHandlers(handlers, subscriptions, {
    registerEventStreams: false,
  });
  handlersHolder.handlers = handlers;

  // Tie subscriptions to the renderer that opened them. When the webContents
  // is destroyed (window closed, render process gone) we drop everything to
  // avoid pinning supervisor listeners forever.
  const ownerId = mainWindow?.webContents.id ?? -1;
  const detachOwnerCleanup = (() => {
    const sender = mainWindow?.webContents;
    if (!sender) return () => {};
    const handler = (): void => {
      subscriptions.closeAllForOwner(ownerId);
      deviceChatSubscriptions?.closeAllForOwner(ownerId);
    };
    sender.on('destroyed', handler);
    return () => {
      try {
        sender.removeListener('destroyed', handler);
      } catch {
        // sender already gone
      }
    };
  })();

  activeWorkspace = {
    repoPath: gitRoot,
    config,
    store,
    source,
    supervisor,
    autopilot,
    draftIssue,
    suggestIssue,
    draftPrDescription,
    analyzeSentryError,
    sentryPoller,
    subscriptions,
    unregisterHandlers,
    ownerId,
    detachOwnerCleanup,
    cooldownUnsub,
    dbWatcher,
    toolBridge,
    toolBridgeRuntimeDir,
  };

  sentryPoller.start();

  await ensureGitignoreEntry(gitRoot, '.kanbots/').catch(() => {
    // best-effort
  });

  const displayName = config.mode === 'local' ? config.name : `${config.owner}/${config.repo}`;
  await recordRecent(gitRoot, displayName);

  return { repoPath: gitRoot, config };
}

const NOTIFY_STATUSES = new Set<AgentRunStatus>([
  'awaiting_input',
  'failed',
  'complete',
  'stopped',
]);

function notificationBody(status: AgentRunStatus): string {
  switch (status) {
    case 'awaiting_input':
      return 'Decision needed';
    case 'failed':
      return 'Run failed';
    case 'complete':
      return 'Run complete';
    case 'stopped':
      return 'Run stopped';
    default:
      return status;
  }
}

async function maybeNotifyRunStatus(
  run: AgentRun,
  store: Store,
  source: IssueSource,
): Promise<void> {
  if (!NOTIFY_STATUSES.has(run.status)) return;
  if (!Notification.isSupported()) return;
  if (activeWorkspace?.config.notifyOnRunComplete === false) return;
  // Suppress when the user is already looking at the app — they don't need
  // an OS-level pop-up to tell them what's already on screen.
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) return;

  const thread = store.threads.findById(run.threadId);
  if (!thread) return;
  let title = `Issue #${thread.issueNumber}`;
  try {
    const issue = await source.getIssue(thread.issueNumber);
    title = `#${thread.issueNumber} ${issue.title}`;
  } catch {
    // fall back to the issue number
  }

  const silent = run.status === 'complete' || run.status === 'stopped';
  const notif = new Notification({
    title,
    body: notificationBody(run.status),
    silent,
  });
  notif.on('click', () => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('kanbots:navigate-task', {
        issueNumber: thread.issueNumber,
        runId: run.id,
      });
    }
  });
  notif.show();
}

function activeWorkspaceInfo(): ActiveWorkspaceInfo | null {
  if (!activeWorkspace) return null;
  return { repoPath: activeWorkspace.repoPath, config: activeWorkspace.config };
}

/**
 * Open a free-floating cloud workspace. Closes any active local
 * workspace first (mutually exclusive). Verifies the project exists
 * by hitting the cloud API; if not, returns an error so the picker
 * can re-render.
 */
async function openCloudWorkspaceInternal(
  orgSlug: string,
  projectSlug: string,
): Promise<ActiveCloudWorkspaceInfo> {
  const orgList = await cloudClient.orgs.list({ limit: 100 });
  const org = orgList.data.find((o) => o.slug === orgSlug);
  if (org === undefined) throw new Error(`org '${orgSlug}' not found or you no longer have access`);

  const projectList = await cloudClient.projects.list(orgSlug);
  const project = projectList.data.find((p) => p.slug === projectSlug);
  if (project === undefined) {
    throw new Error(`project '${projectSlug}' not found in '${orgSlug}'`);
  }

  await closeActiveWorkspace();

  const binding = await getCloudProjectBinding(orgSlug, projectSlug);
  const info: ActiveCloudWorkspaceInfo = {
    orgSlug,
    orgDisplayName: org.display_name,
    projectSlug,
    projectDisplayName: project.display_name,
    localRepoPath: binding?.localRepoPath ?? null,
  };
  activeCloudWorkspace = info;
  await recordCloudRecent({
    orgSlug,
    orgDisplayName: org.display_name,
    projectSlug,
    projectDisplayName: project.display_name,
  });

  // Composer (suggest-a-feature) runs the local Claude/Codex CLI but needs
  // the cloud backlog as context. Register while the cloud workspace is
  // open; tear down on close so a future cloud or local workspace can
  // re-register the same channel without conflict.
  cloudComposerUnregister = registerCloudComposerHandlers({
    cloudClient,
    getActiveCloudWorkspace: () => activeCloudWorkspace,
    onSuggestEvent: (event) => {
      const sender = mainWindow?.webContents;
      if (!sender || sender.isDestroyed()) return;
      sender.send('composer:suggest:event', event);
    },
  });

  return info;
}

function closeActiveCloudWorkspace(): void {
  activeCloudWorkspace = null;
  if (cloudComposerUnregister !== null) {
    try {
      cloudComposerUnregister();
    } catch {
      // best-effort
    }
    cloudComposerUnregister = null;
  }
}

function deviceChatDbPath(): string {
  return join(app.getPath('userData'), 'device-chats.db');
}

/**
 * Working directory used for chat agent runs, resolved at dispatch time
 * so a chat started in cloud-only mode picks up the bound local repo as
 * soon as the user opens one. Falls back to userData when nothing's
 * bound — the agent CLI still launches; only filesystem tools have a
 * meaningful scope to act on.
 */
function resolveChatCwd(): string {
  if (activeWorkspace !== null) return activeWorkspace.repoPath;
  if (activeCloudWorkspace !== null && activeCloudWorkspace.localRepoPath !== null) {
    return activeCloudWorkspace.localRepoPath;
  }
  return app.getPath('userData');
}

async function ensureDeviceChat(): Promise<{
  store: Store;
  supervisor: AgentSupervisor;
  subscriptions: OwnedSubscriptionRegistry;
}> {
  if (
    deviceChatStore !== null &&
    deviceChatSupervisor !== null &&
    deviceChatSubscriptions !== null
  ) {
    return {
      store: deviceChatStore,
      supervisor: deviceChatSupervisor,
      subscriptions: deviceChatSubscriptions,
    };
  }
  const store = openStore({ path: deviceChatDbPath() });
  const supervisor = await createSupervisor({
    store,
    repoPath: resolveChatCwd,
  });
  const subscriptions = createSubscriptionRegistry({
    supervisor,
    forward: forwardAgentRunEvent,
  });
  deviceChatStore = store;
  deviceChatSupervisor = supervisor;
  deviceChatSubscriptions = subscriptions;
  return { store, supervisor, subscriptions };
}

function registerDeviceChatIpc(): void {
  let handlers: ChatHandlers | null = null;
  async function getHandlers(): Promise<ChatHandlers> {
    if (handlers !== null) return handlers;
    const { store, supervisor } = await ensureDeviceChat();
    handlers = createChatHandlers({ store, supervisor });
    return handlers;
  }
  const channels: Array<keyof ChatHandlers> = [
    'chat:list',
    'chat:create',
    'chat:get',
    'chat:rename',
    'chat:delete',
    'chat:post-message',
    'chat:stop-run',
    'chat:sessions:list',
    'chat:sessions:create',
    'chat:sessions:rename',
    'chat:sessions:delete',
    'chat:sessions:set-active',
  ];
  for (const channel of channels) {
    ipcMain.handle(`kanbots:invoke:${channel}`, async (_event, args: unknown) => {
      try {
        const map = await getHandlers();
        // The Handlers map types args per-channel; the IPC bridge passes them
        // through opaquely so the runtime cast is safe.
        const fn = map[channel] as (a: unknown) => Promise<unknown>;
        return await fn(args);
      } catch (err) {
        throw new Error(
          JSON.stringify({
            code: err instanceof Error && err.name ? err.name : 'Error',
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    });
  }
}

interface AgentEventSubscribeArgs {
  runId: number;
  sinceSeq?: number;
  scope?: 'workspace' | 'chat';
}

interface AgentEventUnsubscribeArgs {
  subscriptionId: string;
}

function registerAgentRunEventStreamIpc(): void {
  ipcMain.handle(`${CHANNEL_PREFIX}${SUBSCRIBE_CHANNEL}`, async (event, args: unknown) => {
    try {
      const input = args as AgentEventSubscribeArgs;
      const subscriptions =
        input.scope === 'chat'
          ? (await ensureDeviceChat()).subscriptions
          : activeWorkspace?.subscriptions;
      if (!subscriptions) throw new Error('No active workspace is open.');
      return subscriptions.register({
        runId: input.runId,
        ownerId: event.sender.id,
        ...(input.sinceSeq !== undefined ? { sinceSeq: input.sinceSeq } : {}),
      });
    } catch (err) {
      throw new Error(JSON.stringify(toIpcError(err)));
    }
  });

  ipcMain.handle(`${CHANNEL_PREFIX}${UNSUBSCRIBE_CHANNEL}`, async (_event, args: unknown) => {
    try {
      const input = args as AgentEventUnsubscribeArgs;
      activeWorkspace?.subscriptions.unregister(input.subscriptionId);
      deviceChatSubscriptions?.unregister(input.subscriptionId);
      return undefined;
    } catch (err) {
      throw new Error(JSON.stringify(toIpcError(err)));
    }
  });
}

// Local-first launch: cloud sign-in is OPTIONAL. By default every IPC
// channel works without a cloud session. Only operations that actually
// hit the Kanbots Cloud backend (or open a cloud-only workspace) need a
// valid session — those opt in via CLOUD_REQUIRED_CHANNELS below.
//
// The sign-in flow itself, status probes, and prompt-dismiss must stay
// reachable without auth (a not-signed-in user has to be able to sign
// in), so they are intentionally NOT listed here.
const CLOUD_REQUIRED_CHANNELS: ReadonlySet<string> = new Set([
  // Cloud REST operations — every one of these makes an authenticated
  // request to app.kanbots.dev, so they cannot run without a session.
  'kanbots:cloud:users-me',
  'kanbots:cloud:orgs-list',
  'kanbots:cloud:orgs-create',
  'kanbots:cloud:projects-list',
  'kanbots:cloud:projects-create',
  'kanbots:cloud:cards-list',
  'kanbots:cloud:cards-create',
  'kanbots:cloud:cards-get',
  'kanbots:cloud:cards-update',
  'kanbots:cloud:cards-archive',
  'kanbots:cloud:cards-unarchive',
  'kanbots:cloud:comments-list',
  'kanbots:cloud:comments-add',
  'kanbots:cloud:attachments-list',
  'kanbots:cloud:runs-list-for-card',
  'kanbots:cloud:runs-create',
  'kanbots:cloud:runs-get',
  'kanbots:cloud:start-agent-run',
  'kanbots:cloud:runs-stream-start',
  'kanbots:cloud:runs-stream-stop',
  'kanbots:cloud:runs-stop',
  'kanbots:cloud:cost-today',
  'kanbots:cloud:project-binding-get',
  'kanbots:cloud:project-binding-set',
  'kanbots:cloud:project-binding-clear',
  // Cloud workspace lifecycle — opening or listing remote workspaces.
  'kanbots:open-cloud-workspace',
  'kanbots:close-cloud-workspace',
  'kanbots:recent-cloud-workspaces',
]);

function registerIpc(): void {
  // Wrap ipcMain.handle so that channels in CLOUD_REQUIRED_CHANNELS
  // reject when there is no active cloud session. Local workspace and
  // app-level channels (the default) are pass-through so the app boots
  // and operates fully offline.
  const origHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = ((channel: string, listener: Parameters<typeof ipcMain.handle>[1]) => {
    if (!CLOUD_REQUIRED_CHANNELS.has(channel)) {
      origHandle(channel, listener);
      return;
    }
    origHandle(channel, async (event, ...args: unknown[]) => {
      const status = await getCloudStatus();
      if (!status.authed) throw new CloudAuthRequiredError();
      return (listener as (...a: unknown[]) => unknown)(event, ...args);
    });
  }) as typeof ipcMain.handle;

  // Provider config (Claude Code / Codex CLI defaults) is per-user, so its
  // handlers live at app scope, not workspace scope — survives cloud and
  // local workspace transitions. Wrapped by the cloud-auth gate above.
  registerProvidersIpc({
    getAcpCommand: () => activeWorkspace?.config.acpCommand ?? null,
  });

  // Workspace file tree + git-status IPC. Read source of truth lazily
  // at call time so the same handlers serve both cloud-mode (bound
  // local repo) and local-mode (current git workspace).
  registerWorkspaceTreeIpc({
    getCurrentRepoRoot: () => {
      if (activeCloudWorkspace !== null && activeCloudWorkspace.localRepoPath !== null) {
        return activeCloudWorkspace.localRepoPath;
      }
      if (activeWorkspace !== null) return activeWorkspace.repoPath;
      return null;
    },
  });

  // Chat IPCs are per-device (live at userData/device-chats.db) so chat
  // history persists across workspace switches and works in cloud-only
  // mode. Registered at app scope; the workspace-scoped registerHandlers
  // skips `chat:*` (see ipc/register.ts).
  registerDeviceChatIpc();
  registerAgentRunEventStreamIpc();

  ipcMain.handle('kanbots:bootstrap', async (): Promise<BootstrapPayload> => {
    const [recents, cloudRecents, claudeAuthed, cloudStatus] = await Promise.all([
      pruneMissingRecents(),
      readCloudRecents(),
      isClaudeAuthenticated(),
      getCloudStatus(),
    ]);
    // Cheap file/env probes — running each CLI's full status command would
    // shell out and can take seconds. The deeper checks still run via the
    // dedicated `kanbots:<agent>-auth-status` channels and via the providers
    // handler once the renderer queries it.
    const codexAuthed = existsSync(CODEX_AUTH_PATH) || Boolean(process.env.OPENAI_API_KEY);
    const geminiAuthed = existsSync(GEMINI_AUTH_PATH) || Boolean(process.env.GEMINI_API_KEY);
    const ampAuthed =
      existsSync(AMP_SETTINGS_PATH) ||
      existsSync(AMP_AUTH_PATH) ||
      Boolean(process.env.AMP_API_KEY);
    const cursorAuthed =
      existsSync(CURSOR_AUTH_PATH) ||
      existsSync(CURSOR_CONFIG_DIR) ||
      Boolean(process.env.CURSOR_API_KEY);
    const copilotAuthed =
      existsSync(COPILOT_AUTH_PATH) ||
      existsSync(COPILOT_CONFIG_DIR) ||
      existsSync(COPILOT_GH_HOSTS_PATH) ||
      Boolean(process.env.GITHUB_TOKEN);
    const opencodeAuthed =
      existsSync(OPENCODE_AUTH_PATH) ||
      existsSync(OPENCODE_CONFIG_DIR) ||
      Boolean(process.env.OPENCODE_AUTH_TOKEN) ||
      Boolean(process.env.ANTHROPIC_API_KEY) ||
      Boolean(process.env.OPENAI_API_KEY);
    const droidAuthed =
      existsSync(DROID_AUTH_PATH) ||
      existsSync(DROID_MCP_PATH) ||
      existsSync(DROID_CONFIG_DIR) ||
      Boolean(process.env.FACTORY_API_KEY);
    const ccrAuthed =
      existsSync(CCR_CONFIG_PATH) ||
      existsSync(CCR_CONFIG_DIR) ||
      Boolean(process.env.ANTHROPIC_API_KEY) ||
      Boolean(process.env.OPENAI_API_KEY);
    const qwenAuthed =
      existsSync(QWEN_SETTINGS_PATH) ||
      existsSync(QWEN_INSTALL_PATH) ||
      existsSync(QWEN_CONFIG_DIR) ||
      Boolean(process.env.DASHSCOPE_API_KEY) ||
      Boolean(process.env.QWEN_API_KEY);
    return {
      workspace: activeWorkspaceInfo(),
      cloudWorkspace: activeCloudWorkspace,
      recents,
      cloudRecents,
      claudeAuthed,
      codexAuthed,
      geminiAuthed,
      ampAuthed,
      cursorAuthed,
      copilotAuthed,
      opencodeAuthed,
      droidAuthed,
      ccrAuthed,
      qwenAuthed,
      cloudAuthed: cloudStatus.authed,
      cloudPromptDismissed: cloudStatus.promptDismissed,
    };
  });

  ipcMain.handle('kanbots:claude-auth-status', async (): Promise<{ authed: boolean }> => {
    return { authed: await isClaudeAuthenticated() };
  });

  ipcMain.handle(
    'kanbots:claude-login-start',
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      return startClaudeLogin();
    },
  );

  ipcMain.handle('kanbots:claude-login-cancel', async (): Promise<void> => {
    cancelClaudeLogin();
  });

  ipcMain.handle('kanbots:codex-auth-status', async (): Promise<{ authed: boolean }> => {
    return { authed: await isCodexAuthenticated() };
  });

  ipcMain.handle(
    'kanbots:codex-login-start',
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      return startCodexLogin();
    },
  );

  ipcMain.handle('kanbots:codex-login-cancel', async (): Promise<void> => {
    cancelCodexLogin();
  });

  ipcMain.handle('kanbots:gemini-auth-status', async (): Promise<{ authed: boolean }> => {
    return { authed: await isGeminiAuthenticated() };
  });

  ipcMain.handle(
    'kanbots:gemini-login-start',
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      return startGeminiLogin();
    },
  );

  ipcMain.handle('kanbots:gemini-login-cancel', async (): Promise<void> => {
    cancelGeminiLogin();
  });

  ipcMain.handle('kanbots:amp-auth-status', async (): Promise<{ authed: boolean }> => {
    return { authed: await isAmpAuthenticated() };
  });

  ipcMain.handle(
    'kanbots:amp-login-start',
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      return startAmpLogin();
    },
  );

  ipcMain.handle('kanbots:amp-login-cancel', async (): Promise<void> => {
    cancelAmpLogin();
  });

  ipcMain.handle('kanbots:cursor-auth-status', async (): Promise<{ authed: boolean }> => {
    return { authed: await isCursorAuthenticated() };
  });

  ipcMain.handle(
    'kanbots:cursor-login-start',
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      return startCursorLogin();
    },
  );

  ipcMain.handle('kanbots:cursor-login-cancel', async (): Promise<void> => {
    cancelCursorLogin();
  });

  ipcMain.handle('kanbots:copilot-auth-status', async (): Promise<{ authed: boolean }> => {
    return { authed: await isCopilotAuthenticated() };
  });

  ipcMain.handle(
    'kanbots:copilot-login-start',
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      return startCopilotLogin();
    },
  );

  ipcMain.handle('kanbots:copilot-login-cancel', async (): Promise<void> => {
    cancelCopilotLogin();
  });

  ipcMain.handle('kanbots:opencode-auth-status', async (): Promise<{ authed: boolean }> => {
    return { authed: await isOpencodeAuthenticated() };
  });

  ipcMain.handle(
    'kanbots:opencode-login-start',
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      return startOpencodeLogin();
    },
  );

  ipcMain.handle('kanbots:opencode-login-cancel', async (): Promise<void> => {
    cancelOpencodeLogin();
  });

  ipcMain.handle('kanbots:droid-auth-status', async (): Promise<{ authed: boolean }> => {
    return { authed: await isDroidAuthenticated() };
  });

  ipcMain.handle(
    'kanbots:droid-login-start',
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      return startDroidLogin();
    },
  );

  ipcMain.handle('kanbots:droid-login-cancel', async (): Promise<void> => {
    cancelDroidLogin();
  });

  ipcMain.handle('kanbots:ccr-auth-status', async (): Promise<{ authed: boolean }> => {
    return { authed: await isCcrAuthenticated() };
  });

  ipcMain.handle(
    'kanbots:ccr-login-start',
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      return startCcrLogin();
    },
  );

  ipcMain.handle('kanbots:ccr-login-cancel', async (): Promise<void> => {
    cancelCcrLogin();
  });

  ipcMain.handle('kanbots:qwen-auth-status', async (): Promise<{ authed: boolean }> => {
    return { authed: await isQwenAuthenticated() };
  });

  ipcMain.handle(
    'kanbots:qwen-login-start',
    async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      return startQwenLogin();
    },
  );

  ipcMain.handle('kanbots:qwen-login-cancel', async (): Promise<void> => {
    cancelQwenLogin();
  });

  ipcMain.handle('kanbots:cloud-auth-status', async (): Promise<CloudStatus> => {
    return getCloudStatus();
  });

  ipcMain.handle(
    'kanbots:cloud-login-start',
    async (
      _event,
      opts?: { baseUrl?: string },
    ): Promise<
      | {
          ok: true;
          userCode: string;
          verificationUri: string;
          verificationUriComplete: string;
          expiresAt: number;
          intervalMs: number;
        }
      | { ok: false; error: string }
    > => {
      return startCloudLogin(opts);
    },
  );

  ipcMain.handle('kanbots:cloud-login-poll', async (): Promise<CloudPollResult> => {
    return pollCloudLogin();
  });

  ipcMain.handle('kanbots:cloud-login-cancel', async (): Promise<void> => {
    cancelCloudLogin();
  });

  ipcMain.handle('kanbots:cloud-logout', async (): Promise<void> => {
    await clearCloudAuth();
  });

  ipcMain.handle('kanbots:cloud-prompt-dismiss', async (): Promise<void> => {
    await dismissCloudPrompt();
  });

  ipcMain.handle('kanbots:cloud:users-me', async (): Promise<UserMe> => {
    return cloudClient.users.me();
  });

  ipcMain.handle(
    'kanbots:cloud:orgs-list',
    async (_event, opts?: { cursor?: string; limit?: number }): Promise<OrgListResponse> => {
      return cloudClient.orgs.list(opts);
    },
  );

  ipcMain.handle(
    'kanbots:cloud:orgs-create',
    async (_event, body: CreateOrgRequest): Promise<CreateOrgResponse> => {
      return cloudClient.orgs.create(body);
    },
  );

  ipcMain.handle(
    'kanbots:cloud:projects-list',
    async (_event, orgSlug: string): Promise<ProjectListResponse> => {
      return cloudClient.projects.list(orgSlug);
    },
  );

  ipcMain.handle(
    'kanbots:cloud:projects-create',
    async (
      _event,
      args: { orgSlug: string; body: CreateProjectRequest },
    ): Promise<ProjectSummary> => {
      return cloudClient.projects.create(args.orgSlug, args.body);
    },
  );

  ipcMain.handle(
    'kanbots:cloud:cards-list',
    async (_event, args: { orgSlug: string; projectSlug: string; query?: ListCardsQuery }) => {
      return cloudClient.cards.list(args.orgSlug, args.projectSlug, args.query);
    },
  );

  ipcMain.handle(
    'kanbots:cloud:cards-create',
    async (_event, args: { orgSlug: string; projectSlug: string; body: CreateCardRequest }) => {
      return cloudClient.cards.create(args.orgSlug, args.projectSlug, args.body);
    },
  );

  ipcMain.handle(
    'kanbots:cloud:cards-get',
    async (_event, args: { orgSlug: string; projectSlug: string; number: number }) => {
      return cloudClient.cards.get(args.orgSlug, args.projectSlug, args.number);
    },
  );

  ipcMain.handle(
    'kanbots:open-cloud-workspace',
    async (
      _event,
      args: { orgSlug: string; projectSlug: string },
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await openCloudWorkspaceInternal(args.orgSlug, args.projectSlug);
        if (mainWindow) mainWindow.webContents.reloadIgnoringCache();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle('kanbots:close-cloud-workspace', async (): Promise<void> => {
    closeActiveCloudWorkspace();
    if (mainWindow) mainWindow.webContents.reloadIgnoringCache();
  });

  ipcMain.handle('kanbots:recent-cloud-workspaces', async (): Promise<RecentCloudWorkspace[]> => {
    return readCloudRecents();
  });

  ipcMain.handle(
    'kanbots:cloud:cost-today',
    async (_event, orgSlug: string): Promise<{ totalUsd: number; since: string }> => {
      return cloudClient.billing.costToday(orgSlug);
    },
  );

  ipcMain.handle(
    'kanbots:cloud:project-binding-get',
    async (
      _event,
      args: { orgSlug: string; projectSlug: string },
    ): Promise<CloudProjectBinding | null> => {
      return getCloudProjectBinding(args.orgSlug, args.projectSlug);
    },
  );

  ipcMain.handle(
    'kanbots:cloud:project-binding-set',
    async (
      _event,
      args: { orgSlug: string; projectSlug: string; localRepoPath: string },
    ): Promise<CloudProjectBinding> => {
      const result = await setCloudProjectBinding(
        args.orgSlug,
        args.projectSlug,
        args.localRepoPath,
      );
      // Reflect on the active cloud workspace so the renderer's
      // header updates without a full bootstrap reload.
      if (
        activeCloudWorkspace !== null &&
        activeCloudWorkspace.orgSlug === args.orgSlug &&
        activeCloudWorkspace.projectSlug === args.projectSlug
      ) {
        activeCloudWorkspace = {
          ...activeCloudWorkspace,
          localRepoPath: result.localRepoPath,
        };
      }
      return result;
    },
  );

  ipcMain.handle(
    'kanbots:cloud:project-binding-clear',
    async (_event, args: { orgSlug: string; projectSlug: string }): Promise<void> => {
      await clearCloudProjectBinding(args.orgSlug, args.projectSlug);
      if (
        activeCloudWorkspace !== null &&
        activeCloudWorkspace.orgSlug === args.orgSlug &&
        activeCloudWorkspace.projectSlug === args.projectSlug
      ) {
        activeCloudWorkspace = { ...activeCloudWorkspace, localRepoPath: null };
      }
    },
  );

  ipcMain.handle(
    'kanbots:cloud:cards-update',
    async (
      _event,
      args: {
        orgSlug: string;
        projectSlug: string;
        number: number;
        body: UpdateCardRequest;
        ifMatch?: string;
      },
    ): Promise<CardSummary> => {
      const opts = args.ifMatch !== undefined ? { ifMatch: args.ifMatch } : undefined;
      return cloudClient.cards.update(args.orgSlug, args.projectSlug, args.number, args.body, opts);
    },
  );

  ipcMain.handle(
    'kanbots:cloud:cards-archive',
    async (
      _event,
      args: { orgSlug: string; projectSlug: string; number: number },
    ): Promise<void> => {
      await cloudClient.cards.archive(args.orgSlug, args.projectSlug, args.number);
    },
  );

  ipcMain.handle(
    'kanbots:cloud:cards-unarchive',
    async (
      _event,
      args: { orgSlug: string; projectSlug: string; number: number },
    ): Promise<CardSummary> => {
      return cloudClient.cards.unarchive(args.orgSlug, args.projectSlug, args.number);
    },
  );

  ipcMain.handle(
    'kanbots:cloud:comments-list',
    async (
      _event,
      args: { orgSlug: string; projectSlug: string; number: number },
    ): Promise<CommentListResponse> => {
      return cloudClient.comments.list(args.orgSlug, args.projectSlug, args.number);
    },
  );

  ipcMain.handle(
    'kanbots:cloud:comments-add',
    async (
      _event,
      args: { orgSlug: string; projectSlug: string; number: number; body: string },
    ): Promise<CommentSummary> => {
      return cloudClient.comments.add(args.orgSlug, args.projectSlug, args.number, args.body);
    },
  );

  ipcMain.handle(
    'kanbots:cloud:attachments-list',
    async (
      _event,
      args: { orgSlug: string; projectSlug: string; number: number },
    ): Promise<AttachmentListResponse> => {
      return cloudClient.attachments.list(args.orgSlug, args.projectSlug, args.number);
    },
  );

  ipcMain.handle(
    'kanbots:cloud:runs-list-for-card',
    async (
      _event,
      args: { orgSlug: string; projectSlug: string; number: number },
    ): Promise<AgentRunListResponse> => {
      return cloudClient.runs.listForCard(args.orgSlug, args.projectSlug, args.number);
    },
  );

  ipcMain.handle(
    'kanbots:cloud:runs-create',
    async (
      _event,
      args: {
        orgSlug: string;
        projectSlug: string;
        number: number;
        body: CreateAgentRunRequest;
      },
    ): Promise<AgentRunSummary> => {
      return cloudClient.runs.create(args.orgSlug, args.projectSlug, args.number, args.body);
    },
  );

  ipcMain.handle(
    'kanbots:cloud:runs-get',
    async (
      _event,
      args: { orgSlug: string; projectSlug: string; runId: string },
    ): Promise<AgentRunSummary> => {
      return cloudClient.runs.get(args.orgSlug, args.projectSlug, args.runId);
    },
  );

  ipcMain.handle(
    'kanbots:cloud:start-agent-run',
    async (
      _event,
      args: {
        orgSlug: string;
        projectSlug: string;
        number: number;
        prompt: string;
        appendSystemPrompt?: string;
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
      },
    ): Promise<{ runId: string }> => {
      if (activeCloudWorkspace === null) {
        throw new Error('No active cloud workspace.');
      }
      if (
        activeCloudWorkspace.orgSlug !== args.orgSlug ||
        activeCloudWorkspace.projectSlug !== args.projectSlug
      ) {
        throw new Error('Cloud workspace mismatch — reopen the project and try again.');
      }
      if (activeCloudWorkspace.localRepoPath === null) {
        throw new Error(
          'This cloud project is not bound to a local repository. Open Cloud Settings → Bind local repo, then try again.',
        );
      }
      const handle = await startCloudRun({
        cloudClient,
        orgSlug: args.orgSlug,
        projectSlug: args.projectSlug,
        cardNumber: args.number,
        prompt: args.prompt,
        ...(args.appendSystemPrompt !== undefined
          ? { appendSystemPrompt: args.appendSystemPrompt }
          : {}),
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.provider !== undefined ? { provider: args.provider } : {}),
        cwd: activeCloudWorkspace.localRepoPath,
        onFileTouched: (payload) => broadcastWorkspaceTouched(payload),
      });
      activeCloudRuns.set(handle.runId, handle);
      // Reap the handle once the run finishes so the map doesn't grow
      // unbounded across a long-lived desktop session.
      void handle.done.finally(() => {
        activeCloudRuns.delete(handle.runId);
      });
      return { runId: handle.runId };
    },
  );

  ipcMain.handle(
    'kanbots:cloud:runs-stream-start',
    async (
      event,
      args: {
        orgSlug: string;
        projectSlug: string;
        runId: string;
        lastEventId?: string;
      },
    ): Promise<{ subscriptionId: string }> => {
      const subscriptionId = randomUUID();
      const controller = new AbortController();
      cloudRunStreamControllers.set(subscriptionId, controller);
      const sender = event.sender;

      void (async () => {
        try {
          const iter = cloudClient.runs.stream(args.orgSlug, args.projectSlug, args.runId, {
            ...(args.lastEventId !== undefined ? { lastEventId: args.lastEventId } : {}),
            signal: controller.signal,
          });
          for await (const ev of iter) {
            if (sender.isDestroyed()) break;
            // sync-09: stop_signal is the downstream cancel channel.
            // When the cloud injects one (via the new
            // `/runs/:id/stop` endpoint or autopilot timeout), the
            // local handle.stop() kills the in-progress CLI so it
            // doesn't keep eating tokens for a run nobody is watching.
            //
            // sync-01: decision_answer is delivered the same way after
            // the user answers in the cloud UI. The handle's
            // continueWithDecision spawns a follow-up CLI invocation
            // in the same worktree whose prompt is the answer text.
            // (Implementation is staged — for now we just surface a
            // tagged renderer event so the UI can prompt the user.)
            try {
              if (typeof ev.event === 'string') {
                if (ev.event === 'stop_signal') {
                  const localHandle = activeCloudRuns.get(args.runId);
                  if (localHandle !== undefined) localHandle.stop();
                }
                // The decision_answer fan-out is intentionally a
                // renderer-side concern today: the user clicks
                // "Continue from answer" and the UI invokes
                // `kanbots:cloud:start-agent-run` with the answer as
                // prompt. We just forward the event verbatim so the
                // renderer can light the affordance.
              }
            } catch {
              // Listener crash mustn't tear down the SSE pump.
            }
            sender.send('kanbots:cloud:run-event', {
              subscriptionId,
              event: ev,
            });
          }
          if (!sender.isDestroyed()) {
            sender.send('kanbots:cloud:run-event', {
              subscriptionId,
              done: true,
            });
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          if (sender.isDestroyed()) return;
          sender.send('kanbots:cloud:run-event', {
            subscriptionId,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          cloudRunStreamControllers.delete(subscriptionId);
        }
      })();

      return { subscriptionId };
    },
  );

  ipcMain.handle(
    'kanbots:cloud:runs-stream-stop',
    async (_event, subscriptionId: string): Promise<void> => {
      const controller = cloudRunStreamControllers.get(subscriptionId);
      if (controller !== undefined) {
        controller.abort();
        cloudRunStreamControllers.delete(subscriptionId);
      }
    },
  );

  // sync-09: renderer-initiated stop. Aborts the locally-running CLI if
  // the run is one of ours (in `activeCloudRuns`); always also POSTs
  // to the cloud's stop endpoint so the run row transitions to
  // `stopped` for cross-device consistency.
  ipcMain.handle(
    'kanbots:cloud:runs-stop',
    async (
      _event,
      args: { orgSlug: string; projectSlug: string; runId: string; reason?: string },
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const local = activeCloudRuns.get(args.runId);
      if (local !== undefined) local.stop();
      try {
        await cloudClient.runs.stop(args.orgSlug, args.projectSlug, args.runId, {
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle('kanbots:pick-folder', async (): Promise<string | null> => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open kanbots workspace',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle(
    'kanbots:open-workspace',
    async (_event, repoPath: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await openWorkspaceInternal(repoPath);
        if (mainWindow) mainWindow.webContents.reloadIgnoringCache();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle('kanbots:close-workspace', async (): Promise<void> => {
    await closeActiveWorkspace();
    if (mainWindow) mainWindow.webContents.reloadIgnoringCache();
  });

  ipcMain.handle('kanbots:recent-workspaces', async (): Promise<RecentWorkspace[]> => {
    return pruneMissingRecents();
  });

  ipcMain.handle('kanbots:window-minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.handle('kanbots:window-toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.handle('kanbots:window-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.close();
      return;
    }
    mainWindow?.close();
  });

  ipcMain.handle(
    'kanbots:open-chat',
    async (
      _event,
      conversationId: number | null,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await createChatWindow(conversationId ?? null);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    'kanbots:set-notify-on-run-complete',
    async (_event, enabled: boolean): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!activeWorkspace) {
        return { ok: false, error: 'no active workspace' };
      }
      try {
        const next: WorkspaceConfig = {
          ...activeWorkspace.config,
          notifyOnRunComplete: enabled,
        };
        await writeWorkspaceConfig(activeWorkspace.repoPath, next);
        activeWorkspace.config = next;
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}

/**
 * In dev mode, mirror the renderer's console output to the main process
 * stdout/stderr so `pnpm desktop:dev` shows React errors (including the
 * ErrorBoundary's `console.error(...)`) without the user having to open
 * DevTools. Off in packaged builds — the renderer's console is private
 * to DevTools there.
 *
 * Levels: Electron uses 0=verbose, 1=info, 2=warning, 3=error.
 */
function forwardRendererConsole(win: BrowserWindow, tag: 'main' | 'chat'): void {
  const isDev = Boolean(process.env.KANBOTS_RENDERER_URL) || process.env.NODE_ENV === 'development';
  if (!isDev) return;
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const prefix = `[renderer:${tag}]`;
    const where = sourceId ? ` (${sourceId.split('/').pop()}:${line})` : '';
    const text = `${prefix} ${message}${where}`;
    if (level === 3) process.stderr.write(text + '\n');
    else process.stdout.write(text + '\n');
  });
  // Renderer crashes (whole process exits) and unresponsive states are not
  // covered by `console-message` — surface them too so dev knows when the
  // renderer falls over silently.
  win.webContents.on('render-process-gone', (_event, details) => {
    process.stderr.write(
      `[renderer:${tag}] render-process-gone reason=${details.reason} exitCode=${details.exitCode}\n`,
    );
  });
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    process.stderr.write(
      `[renderer:${tag}] preload-error path=${preloadPath} message=${error.message}\n`,
    );
  });
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'kanbots',
    ...appIconOption(),
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;
  win.on('closed', () => {
    mainWindow = null;
  });

  forwardRendererConsole(win, 'main');

  if (process.env.KANBOTS_OPEN_DEVTOOLS) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  const devUrl = process.env.KANBOTS_RENDERER_URL;
  if (devUrl) {
    await win.loadURL(devUrl);
  } else {
    // Renderer is copied into dist/web/ during build; layout: dist/main.cjs → dist/web/index.html.
    await win.loadFile(join(__dirname, 'web', 'index.html'));
  }
}

async function createChatWindow(conversationId: number | null): Promise<BrowserWindow> {
  // Chat windows use the OS-native frame/title bar so they behave like
  // a normal application window (move, resize, minimize, maximize from
  // the OS). The main board window keeps its custom chrome.
  const win = new BrowserWindow({
    width: 880,
    height: 760,
    title: 'kanbots chat',
    ...appIconOption(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  chatWindows.add(win);
  // Cache the webContents id at creation time — by the time `closed`
  // fires the webContents is already destroyed, so `win.webContents.id`
  // throws "Object has been destroyed" (Electron quirk).
  const ownerWebContentsId = win.webContents.id;
  win.on('closed', () => {
    chatWindows.delete(win);
    activeWorkspace?.subscriptions.closeAllForOwner(ownerWebContentsId);
    deviceChatSubscriptions?.closeAllForOwner(ownerWebContentsId);
  });

  forwardRendererConsole(win, 'chat');

  if (process.env.KANBOTS_OPEN_DEVTOOLS) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  // The chat UI lives in the same renderer bundle but mounts a different
  // root view when the URL hash starts with #/chat. Pass the optional
  // conversation id so the window opens straight to it.
  const hash = `#/chat${conversationId !== null ? `/${conversationId}` : ''}`;
  const devUrl = process.env.KANBOTS_RENDERER_URL;
  if (devUrl) {
    await win.loadURL(`${devUrl}${hash}`);
  } else {
    await win.loadFile(join(__dirname, 'web', 'index.html'), { hash });
  }
  return win;
}

function closeAllChatWindows(): void {
  for (const win of [...chatWindows]) {
    try {
      win.close();
    } catch {
      // ignore — closed handler will sweep
    }
  }
  chatWindows.clear();
}

function resolveMcpServerEntry(): string | null {
  // The MCP server ships from `@kanbots/mcp/server`. We resolve the entry
  // through the standard module loader so it works in both dev (pnpm
  // symlinks → packages/mcp/dist/server.js) and a packaged Electron app
  // where node_modules sits beside the desktop bundle.
  try {
    const req = createRequire(__filename);
    const entry = req.resolve('@kanbots/mcp/server');
    return entry;
  } catch {
    return null;
  }
}

function buildChatToolRuntime(args: {
  toolBridge: ToolBridge;
  runtimeDir: string;
  mcpServerEntry: string;
}): ChatToolRuntime {
  const { toolBridge, runtimeDir, mcpServerEntry } = args;
  return {
    prepareForRun: async ({ provider }) => {
      const token = toolBridge.issueToken();
      const env = {
        KANBOTS_TOOL_BRIDGE_URL: toolBridge.baseUrl(),
        KANBOTS_TOOL_BRIDGE_TOKEN: token,
      };
      const mcpServer = {
        command: process.execPath,
        args: [mcpServerEntry],
        env,
      };
      let extraArgs: string[];
      if (provider === 'codex-cli') {
        extraArgs = buildCodexMcpArgs('kanbots', mcpServer);
      } else {
        const configPath = join(runtimeDir, `mcp-${randomUUID().slice(0, 8)}.json`);
        const config = { mcpServers: { kanbots: mcpServer } };
        await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
        extraArgs = ['--mcp-config', configPath];
      }
      return {
        extraArgs,
        env,
        cleanup: () => {
          toolBridge.revokeToken(token);
          // The MCP config file is small; don't bother unlinking — it's
          // inside .kanbots/mcp-runtime which is gitignored and gets
          // garbage-collected on workspace close (the dir is deleted by
          // the workspace bootstrap on next open if you wire it).
        },
      };
    },
  };
}

// codex's `-c key=value` parses the value as TOML, falling back to a raw
// literal if TOML parsing fails. We always emit quoted basic strings + TOML
// arrays so the parser doesn't have to guess.
function buildCodexMcpArgs(
  serverName: string,
  spec: { command: string; args: string[]; env: Record<string, string> },
): string[] {
  const out: string[] = [];
  const base = `mcp_servers.${serverName}`;
  out.push('-c', `${base}.command=${tomlString(spec.command)}`);
  out.push('-c', `${base}.args=[${spec.args.map(tomlString).join(', ')}]`);
  for (const [key, value] of Object.entries(spec.env)) {
    out.push('-c', `${base}.env.${key}=${tomlString(value)}`);
  }
  return out;
}

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

void app.whenReady().then(async () => {
  void hydrateProcessEnvFromLoginShell();
  Menu.setApplicationMenu(null);
  registerIpc();
  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on('window-all-closed', async () => {
  // The chat windows have their own lifecycle and may still be running;
  // BrowserWindow.getAllWindows() is empty here only when the user has
  // explicitly closed every window. Drop the workspace so processes don't
  // outlive the UI.
  await closeActiveWorkspace();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  closeAllChatWindows();
  await closeActiveWorkspace();
  closeProvidersStoreForShutdown();
});
