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
 * Qwen Code CLI adapter. Wraps the dispatcher's `startAgentRun`, which
 * routes to the qwen-cli adapter inside the dispatcher when `provider:
 * 'qwen-cli'` is set on the run options.
 *
 * Auth: qwen-code finds its own credentials. Its login flow writes
 * under `~/.qwen/`. The app does not store or inject qwen credentials.
 *
 * One-shot `chat()` is unsupported: qwen is interactive-only here.
 */
export const qwenCliAdapter: ProviderAdapter = {
  id: 'qwen-cli',
  capabilities: {
    streaming: true,
    toolUse: true,
    parallelToolCalls: false,
    imageInput: true,
    resumeBySessionId: false,
    agentRuns: true,
  },

  async validate(_creds: ProviderCredentials): Promise<ValidateResult> {
    return validateCliExecutable('Qwen Code CLI', 'qwen-code');
  },

  async chat(_req: ChatRequest, _creds: ProviderCredentials): Promise<ChatResponse> {
    throw new Error(
      'qwen-cli adapter does not support one-shot chat. Use `startAgentRun` for interactive runs.',
    );
  },

  startAgentRun(opts: StartAgentRunOptions, _creds: ProviderCredentials): AgentRunHandle {
    return defaultStartAgentRun({ ...opts, provider: 'qwen-cli' });
  },
};
