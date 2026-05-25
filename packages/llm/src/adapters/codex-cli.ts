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
 * Codex CLI adapter (OpenAI). Wraps the dispatcher's `startAgentRun`, which
 * routes to the codex-cli adapter inside the dispatcher when `provider:
 * 'codex-cli'` is set on the run options.
 *
 * Auth: codex finds its own credentials (env `OPENAI_API_KEY` or
 * `~/.codex/auth.json` from `codex login`). The app does not store or
 * inject codex credentials.
 *
 * One-shot `chat()` is unsupported: codex is interactive-only.
 */
export const codexCliAdapter: ProviderAdapter = {
  id: 'codex-cli',
  capabilities: {
    streaming: true,
    toolUse: true,
    parallelToolCalls: false,
    imageInput: true,
    resumeBySessionId: true,
    agentRuns: true,
  },

  async validate(_creds: ProviderCredentials): Promise<ValidateResult> {
    return validateCliExecutable('Codex CLI', 'codex');
  },

  async chat(_req: ChatRequest, _creds: ProviderCredentials): Promise<ChatResponse> {
    throw new Error(
      'codex-cli adapter does not support one-shot chat. Use `startAgentRun` for interactive runs.',
    );
  },

  startAgentRun(opts: StartAgentRunOptions, _creds: ProviderCredentials): AgentRunHandle {
    return defaultStartAgentRun({ ...opts, provider: 'codex-cli' });
  },
};
