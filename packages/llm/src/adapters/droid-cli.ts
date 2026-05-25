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
 * Factory Droid CLI adapter. Wraps the dispatcher's `startAgentRun`,
 * which routes to the droid-cli adapter inside the dispatcher when
 * `provider: 'droid-cli'` is set on the run options.
 *
 * Auth: droid finds its own credentials. Its login flow writes under
 * `~/.factory/`. The app does not store or inject droid credentials.
 *
 * One-shot `chat()` is unsupported: droid is interactive-only here.
 */
export const droidCliAdapter: ProviderAdapter = {
  id: 'droid-cli',
  capabilities: {
    streaming: true,
    toolUse: true,
    parallelToolCalls: false,
    imageInput: false,
    resumeBySessionId: true,
    agentRuns: true,
  },

  async validate(_creds: ProviderCredentials): Promise<ValidateResult> {
    return validateCliExecutable('Droid CLI', 'droid');
  },

  async chat(_req: ChatRequest, _creds: ProviderCredentials): Promise<ChatResponse> {
    throw new Error(
      'droid-cli adapter does not support one-shot chat. Use `startAgentRun` for interactive runs.',
    );
  },

  startAgentRun(opts: StartAgentRunOptions, _creds: ProviderCredentials): AgentRunHandle {
    return defaultStartAgentRun({ ...opts, provider: 'droid-cli' });
  },
};
