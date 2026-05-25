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
 * SST OpenCode CLI adapter. Wraps the dispatcher's `startAgentRun`, which
 * routes to the opencode-cli adapter inside the dispatcher when
 * `provider: 'opencode-cli'` is set on the run options.
 *
 * Auth: opencode finds its own credentials. Its login flow configures
 * providers under `~/.local/share/opencode/`. The app does not store or
 * inject opencode credentials.
 *
 * One-shot `chat()` is unsupported: opencode is interactive-only here.
 */
export const opencodeCliAdapter: ProviderAdapter = {
  id: 'opencode-cli',
  capabilities: {
    streaming: true,
    toolUse: true,
    parallelToolCalls: true,
    imageInput: false,
    resumeBySessionId: true,
    agentRuns: true,
  },

  async validate(_creds: ProviderCredentials): Promise<ValidateResult> {
    return validateCliExecutable('OpenCode CLI', 'opencode');
  },

  async chat(_req: ChatRequest, _creds: ProviderCredentials): Promise<ChatResponse> {
    throw new Error(
      'opencode-cli adapter does not support one-shot chat. Use `startAgentRun` for interactive runs.',
    );
  },

  startAgentRun(opts: StartAgentRunOptions, _creds: ProviderCredentials): AgentRunHandle {
    return defaultStartAgentRun({ ...opts, provider: 'opencode-cli' });
  },
};
