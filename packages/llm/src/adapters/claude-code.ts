import { existsSync } from 'node:fs';
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
 * Claude Code subscription adapter. Wraps the existing `startAgentRun` so the
 * supervisor's interactive flow keeps working unchanged. Credentials live in
 * `~/.claude/.credentials.json` (managed by the Claude Code OAuth flow in
 * packages/desktop/src/claude-auth.ts).
 *
 * `chat()` is not wired in v1 — the CLI is interactive-only. If we need a
 * one-shot path for composer/suggester later, it can be added by spawning
 * `claude -p --output-format json` with stdin.
 */
export const claudeCodeAdapter: ProviderAdapter = {
  id: 'claude-code',
  capabilities: {
    streaming: true,
    toolUse: true,
    parallelToolCalls: true,
    imageInput: true,
    resumeBySessionId: true,
    agentRuns: true,
  },

  async validate(creds: ProviderCredentials): Promise<ValidateResult> {
    if (creds.kind !== 'claude-code-oauth') {
      return { ok: false, error: 'expected claude-code-oauth credentials' };
    }
    if (!existsSync(creds.credentialsPath)) {
      return {
        ok: false,
        error: `Claude Code credentials not found at ${creds.credentialsPath}. Sign in to Claude Code first.`,
      };
    }
    return validateCliExecutable('Claude Code CLI', 'claude');
  },

  async chat(_req: ChatRequest, _creds: ProviderCredentials): Promise<ChatResponse> {
    throw new Error(
      'claude-code adapter does not support one-shot chat in v1. Use `startAgentRun` for interactive runs.',
    );
  },

  startAgentRun(opts: StartAgentRunOptions, _creds: ProviderCredentials): AgentRunHandle {
    return defaultStartAgentRun(opts);
  },
};
