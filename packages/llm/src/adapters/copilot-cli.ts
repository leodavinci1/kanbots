import {
  startAgentRun as defaultStartAgentRun,
  type AgentRunHandle,
  type StartAgentRunOptions,
} from '@kanbots/dispatcher';
import { validateCliExecutable } from '../cli-validation.js';
import type {
  ChatRequest,
  ChatResponse,
  ProviderAdapter,
  ProviderCredentials,
  ValidateResult,
} from '../types.js';

/**
 * GitHub Copilot CLI adapter. Wraps the dispatcher's `startAgentRun`,
 * which routes to the copilot-cli adapter inside the dispatcher when
 * `provider: 'copilot-cli'` is set on the run options.
 *
 * Auth: copilot finds its own credentials. Sign in via `gh auth login`
 * + Copilot plan, or via the CLI's own auth flow under `~/.copilot/`.
 * The app does not store or inject copilot credentials.
 *
 * One-shot `chat()` is unsupported: copilot is interactive-only here.
 */
export const copilotCliAdapter: ProviderAdapter = {
  id: 'copilot-cli',
  capabilities: {
    streaming: true,
    toolUse: true,
    parallelToolCalls: false,
    imageInput: false,
    resumeBySessionId: false,
    agentRuns: true,
  },

  async validate(_creds: ProviderCredentials): Promise<ValidateResult> {
    return validateCliExecutable('GitHub Copilot CLI launcher', 'npx');
  },

  async chat(_req: ChatRequest, _creds: ProviderCredentials): Promise<ChatResponse> {
    throw new Error(
      'copilot-cli adapter does not support one-shot chat. Use `startAgentRun` for interactive runs.',
    );
  },

  startAgentRun(opts: StartAgentRunOptions, _creds: ProviderCredentials): AgentRunHandle {
    return defaultStartAgentRun({ ...opts, provider: 'copilot-cli' });
  },
};
