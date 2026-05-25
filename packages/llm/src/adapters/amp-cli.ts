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
 * Sourcegraph Amp CLI adapter. Wraps the dispatcher's `startAgentRun`,
 * which routes to the amp-cli adapter inside the dispatcher when
 * `provider: 'amp-cli'` is set on the run options.
 *
 * Auth: amp finds its own credentials. `amp /login` writes to
 * `~/.config/amp/`; `AMP_API_KEY` in the environment is also honored.
 * The app does not store or inject amp credentials.
 *
 * One-shot `chat()` is unsupported: amp is interactive-only here.
 */
export const ampCliAdapter: ProviderAdapter = {
  id: 'amp-cli',
  capabilities: {
    streaming: true,
    toolUse: true,
    parallelToolCalls: true,
    imageInput: false,
    resumeBySessionId: false,
    agentRuns: true,
  },

  async validate(_creds: ProviderCredentials): Promise<ValidateResult> {
    return validateCliExecutable('Amp CLI', 'amp');
  },

  async chat(_req: ChatRequest, _creds: ProviderCredentials): Promise<ChatResponse> {
    throw new Error(
      'amp-cli adapter does not support one-shot chat. Use `startAgentRun` for interactive runs.',
    );
  },

  startAgentRun(opts: StartAgentRunOptions, _creds: ProviderCredentials): AgentRunHandle {
    return defaultStartAgentRun({ ...opts, provider: 'amp-cli' });
  },
};
