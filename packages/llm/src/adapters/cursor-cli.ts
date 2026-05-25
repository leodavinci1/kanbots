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
 * Cursor Agent CLI adapter. Wraps the dispatcher's `startAgentRun`, which
 * routes to the cursor-cli adapter inside the dispatcher when `provider:
 * 'cursor-cli'` is set on the run options.
 *
 * Auth: cursor-agent finds its own credentials. The CLI's own
 * `cursor-agent login` flow drives OAuth; `CURSOR_API_KEY` in the
 * environment is the alternate path. The app does not store or inject
 * cursor credentials.
 *
 * One-shot `chat()` is unsupported: cursor is interactive-only here.
 */
export const cursorCliAdapter: ProviderAdapter = {
  id: 'cursor-cli',
  capabilities: {
    streaming: true,
    toolUse: true,
    parallelToolCalls: false,
    imageInput: true,
    resumeBySessionId: true,
    agentRuns: true,
  },

  async validate(_creds: ProviderCredentials): Promise<ValidateResult> {
    return validateCliExecutable('Cursor Agent CLI', 'cursor-agent');
  },

  async chat(_req: ChatRequest, _creds: ProviderCredentials): Promise<ChatResponse> {
    throw new Error(
      'cursor-cli adapter does not support one-shot chat. Use `startAgentRun` for interactive runs.',
    );
  },

  startAgentRun(opts: StartAgentRunOptions, _creds: ProviderCredentials): AgentRunHandle {
    return defaultStartAgentRun({ ...opts, provider: 'cursor-cli' });
  },
};
