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
 * Claude Code Router (CCR) adapter. Wraps the dispatcher's
 * `startAgentRun`, which routes to the ccr-cli adapter inside the
 * dispatcher when `provider: 'ccr-cli'` is set on the run options.
 *
 * CCR is a drop-in router that front-ends `claude` and lets users route
 * turns to alternate providers via local config. The capability shape
 * matches claude-code's because CCR preserves the same stream-json
 * envelope underneath.
 *
 * Auth: CCR delegates to whichever provider config the user has put in
 * `~/.claude-code-router/config.json`. The app does not store or inject
 * CCR credentials.
 *
 * One-shot `chat()` is unsupported: ccr is interactive-only here.
 */
export const ccrCliAdapter: ProviderAdapter = {
  id: 'ccr-cli',
  capabilities: {
    streaming: true,
    toolUse: true,
    parallelToolCalls: true,
    imageInput: false,
    resumeBySessionId: true,
    agentRuns: true,
  },

  async validate(_creds: ProviderCredentials): Promise<ValidateResult> {
    return validateCliExecutable('Claude Code Router CLI', 'ccr');
  },

  async chat(_req: ChatRequest, _creds: ProviderCredentials): Promise<ChatResponse> {
    throw new Error(
      'ccr-cli adapter does not support one-shot chat. Use `startAgentRun` for interactive runs.',
    );
  },

  startAgentRun(opts: StartAgentRunOptions, _creds: ProviderCredentials): AgentRunHandle {
    return defaultStartAgentRun({ ...opts, provider: 'ccr-cli' });
  },
};
