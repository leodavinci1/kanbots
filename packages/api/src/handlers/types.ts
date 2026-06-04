import type { IssueSource } from '@kanbots/core';
import type { AgentRunProvider } from '@kanbots/dispatcher';
import type { Store } from '@kanbots/local-store';
import type { AgentSupervisor } from '../agent-runs/supervisor.js';
import type { AutopilotManager } from '../autopilot/orchestrator.js';
import type { ReadyToGoManager } from '../ready-to-go/manager.js';
import type {
  Config,
  DraftIssueFn,
  DraftPrDescriptionFn,
  EventSubscribeResult,
  PlannerEvent,
  SentryAnalyzerFn,
  SuggestFeatureFn,
} from '../bridge.js';

export type {
  Config,
  DraftIssueFn,
  DraftPrDescriptionFn,
  EventSubscribeResult,
  PlannerEvent,
  SentryAnalyzerFn,
  SuggestFeatureFn,
};

export interface SentryRuntime {
  encryptToken(plaintext: string): { buffer: Buffer; encryption: 'safe' | 'plain' };
  decryptToken(buffer: Buffer | null, encryption: 'safe' | 'plain'): string | null;
  envTokenOverride(): string | null;
  safeStorageAvailable(): boolean;
  syncNow(): Promise<{ imported: number; updated: number; totalSeen: number; lastSyncedAt: string }>;
  restartPoller(): void;
}

export interface ProvidersRuntime {
  safeStorageAvailable(): boolean;
  /** True if Claude Code CLI OAuth credentials are present on disk. */
  hasClaudeCodeCredentials(): boolean;
}

export interface ChatToolRuntime {
  /**
   * Returns the extra args + env vars to pass to the underlying agent CLI so
   * the chat agent has the kanbots MCP server wired in. The shape of those
   * args is provider-specific (claude takes `--mcp-config <file>`; codex
   * takes repeated `-c mcp_servers.<name>.* = ...` overrides), so callers
   * must pass the provider that will actually be spawned.
   */
  prepareForRun(input: { provider: AgentRunProvider }): Promise<{
    extraArgs: string[];
    env: Record<string, string>;
    /** Called once the run terminates so the token can be revoked. */
    cleanup: () => void;
  }>;
}

export interface WorkspaceBudgetsAccessor {
  get(): { runCostBudgetUsd: number | null; sessionCostBudgetUsd: number | null };
  set(input: {
    runCostBudgetUsd: number | null;
    sessionCostBudgetUsd: number | null;
  }): Promise<void> | void;
}

export interface WorkspaceHouseRulesAccessor {
  get(): { houseRules: string | null };
  set(input: { houseRules: string | null }): Promise<void> | void;
}

export interface WorkspaceAcpCommandAccessor {
  get(): { acpCommand: string | null };
  set(input: { acpCommand: string | null }): Promise<void> | void;
}

export interface HandlerDeps {
  source: IssueSource;
  store: Store;
  config: Config;
  supervisor: AgentSupervisor;
  draftIssue: DraftIssueFn;
  suggestIssue: SuggestFeatureFn;
  /**
   * Optional. When wired, the renderer can pre-fill an AI-drafted PR title
   * and body from a run's diff via `agent-runs:draft-pr-description`. If
   * the runtime doesn't supply this, the channel returns a BadRequest so
   * the renderer can fall back to a manual title/body.
   */
  draftPrDescription?: DraftPrDescriptionFn;
  autopilot: AutopilotManager;
  readyToGo: ReadyToGoManager;
  analyzeSentryError: SentryAnalyzerFn;
  sentry: SentryRuntime;
  providers: ProvidersRuntime;
  budgets?: WorkspaceBudgetsAccessor;
  houseRules?: WorkspaceHouseRulesAccessor;
  acpCommand?: WorkspaceAcpCommandAccessor;
  revealPath?: (path: string) => Promise<void>;
  chatTools?: ChatToolRuntime;
  /**
   * Optional sink for live planner activity from `composer:suggest`. The IPC
   * layer wires this up to broadcast events back to the renderer that
   * triggered the suggest call so the UI can show ideation progress.
   */
  onSuggestEvent?: (event: PlannerEvent) => void;
  /**
   * Optional sink for cloud-side promotion records — per `sync-07`. The
   * local app drives `promoteCommit`/`promotePr`; if the supervising
   * thread/run originated from a cloud workspace, the IPC layer wires
   * a callback that POSTs to
   * `/api/v1/orgs/:slug/projects/:p/runs/:id/promotions` so the cloud
   * board surfaces the PR/merge sticker. Best-effort — failures log
   * and don't break the local promotion.
   */
  cloudPromote?: (input: CloudPromoteInput) => Promise<void> | void;
}

/**
 * Inputs the IPC layer hands to `cloudPromote`. We don't expose the
 * cloud client itself in `HandlerDeps` because the api package is
 * meant to be transport-agnostic (the CLI/desktop wires up the right
 * implementation). The IPC layer holds the org/project slug for the
 * current cloud workspace and supplies them here.
 */
export interface CloudPromoteInput {
  localRunId: number;
  kind: 'commit' | 'pr' | 'discard';
  sourceBranch?: string;
  targetBranch?: string;
  commitSha?: string;
  prProvider?: string;
  prUrl?: string;
  prNumber?: number;
  abandonedReason?: string;
}

export interface SubscriptionRegisterArgs {
  runId: number;
  sinceSeq?: number;
  /** Set by the IPC bridge to scope the subscription to a renderer window
   *  for cleanup on window destroy. Renderers don't (and can't) set it. */
  ownerId?: number;
}

export interface SubscriptionRegistry {
  register(args: SubscriptionRegisterArgs): EventSubscribeResult;
  unregister(subscriptionId: string): void;
}

export interface CreateHandlersOptions {
  deps: HandlerDeps;
  subscriptions: SubscriptionRegistry;
}
