export const PACKAGE_NAME = '@kanbots/llm';

export {
  MODELS,
  findModel,
  modelsForProvider,
  recommendedModel,
} from './catalogue.js';

export { claudeCodeAdapter } from './adapters/claude-code.js';
export { codexCliAdapter } from './adapters/codex-cli.js';

export { chat, getAdapter, listAdapters, validateProvider } from './manager.js';

export { discoverSlashCommands } from './slashCommands.js';

export type {
  AgentRunHandle,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ModelEntry,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderCredentials,
  ProviderId,
  StartAgentRunOptions,
  StreamEvent,
  ValidateResult,
} from './types.js';

export type {
  AgentKey,
  SlashCommand,
  SlashCommandSource,
} from './slashCommands.js';
