export const PACKAGE_NAME = '@kanbots/dispatcher';

export {
  ComposerError,
  createComposer,
  createPrDescriptionDrafter,
  createSuggester,
  type BacklogEntry,
  type CreateComposerOptions,
  type CreatePrDescriptionDrafterOptions,
  type CreateSuggesterOptions,
  type DraftedIssue,
  type DraftIssueFn,
  type DraftIssueInput,
  type DraftPrDescriptionFn,
  type DraftPrDescriptionInput,
  type SpawnFn,
  type SuggestFeatureFn,
  type SuggestFeatureInput,
  type SuggestionEntryStatus,
  type PlannerEvent,
  type OnPlannerEvent,
} from './composer.js';

export {
  createSentryAnalyzer,
  type CreateSentryAnalyzerOptions,
  type SentryAnalyzerBreadcrumb,
  type SentryAnalyzerFn,
  type SentryAnalyzerInput,
  type SentryAnalyzerStackFrame,
  type SentryAnalyzerSuggestion,
} from './sentry-analyzer.js';

export { parseStreamLine, makeLineSplitter, type StreamEvent } from './stream-parser.js';

export {
  MODEL_PRICING,
  computeCostUsd,
  getModelPricing,
  type ModelPricing,
  type TokenUsage,
} from './pricing.js';

export {
  startAgentRun,
  DEFAULT_GRACEFUL_TIMEOUT_MS,
  UnsupportedProviderForAgentRunError,
  type AgentRunHandle,
  type AgentRunProvider,
  type RunResult,
  type RunSummary,
  type StartAgentRunOptions,
  type StopOptions,
  type StopEscalation,
} from './worker.js';

export { setAcpWorkspaceCommand } from './adapters/acp.js';

export {
  createWorktree,
  removeWorktree,
  defaultWorktreePath,
  defaultBranchName,
  type CreateWorktreeInput,
  type RemoveWorktreeInput,
  type Worktree,
} from './worktree.js';

export {
  stampWorktreeIdentity,
  type StampWorktreeIdentityInput,
  type StampWorktreeIdentityResult,
} from './worktree-identity.js';

export {
  defaultCheckCommand,
  resolveCheckCommand,
  runCheck,
  type CheckCommand,
  type CheckCommandOverrides,
  type CheckResult,
  type RunCheckOptions,
} from './checks.js';

export {
  inspectToolUse,
  type ContainmentEscape,
  type InspectToolUseInput,
  type InspectToolUseResult,
} from './containment.js';

export {
  startPreview,
  type PreviewHandle,
  type StartPreviewOptions,
  type PreviewState as DispatcherPreviewState,
} from './preview.js';

export {
  startPreviewProxy,
  type PreviewProxyHandle,
  type StartPreviewProxyOptions,
} from './preview-proxy.js';

export { createCliEnvironment, mergePathValues, resolveCommandOnPath } from './cli-env.js';
export { parseShellLikeCommand, type ParsedCommand } from './cli-command.js';
