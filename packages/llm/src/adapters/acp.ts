import {
  parseShellLikeCommand,
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
  ProviderValidationContext,
  ValidateResult,
} from '../types.js';

/**
 * ACP (Agent Client Protocol) meta-provider.
 *
 * ACP is the JSON-RPC 2.0 contract Zed defined for agents — several CLIs
 * speak it natively (Gemini's `--experimental-acp`, Copilot's `--acp`,
 * Qwen's `--acp`, ...). Rather than duplicating the parser across each
 * agent, kanbots exposes `acp` as a meta-provider: pick it as the
 * provider for a run and the dispatcher invokes whichever ACP-capable
 * binary the user has configured (default: `gemini --experimental-acp`,
 * overridable via the workspace `acp_command` setting / the
 * `KANBOTS_ACP_COMMAND` env var).
 *
 * Auth: ACP delegates to whichever agent is actually spawned. The app
 * does not store or inject ACP credentials.
 */
export const acpAdapter: ProviderAdapter = {
  id: 'acp',
  capabilities: {
    streaming: true,
    toolUse: true,
    parallelToolCalls: true,
    imageInput: false,
    resumeBySessionId: false,
    agentRuns: true,
  },

  async validate(
    _creds: ProviderCredentials,
    context?: ProviderValidationContext,
  ): Promise<ValidateResult> {
    const raw = resolveAcpValidationCommand(context);
    const parsed = parseShellLikeCommand(raw);
    if (parsed === null) {
      return { ok: false, error: 'ACP command is empty.' };
    }
    return validateCliExecutable('ACP agent CLI', parsed.command);
  },

  async chat(_req: ChatRequest, _creds: ProviderCredentials): Promise<ChatResponse> {
    throw new Error(
      'acp adapter does not support one-shot chat. Use `startAgentRun` for interactive runs.',
    );
  },

  startAgentRun(opts: StartAgentRunOptions, _creds: ProviderCredentials): AgentRunHandle {
    return defaultStartAgentRun({ ...opts, provider: 'acp' });
  },
};

function resolveAcpValidationCommand(context?: ProviderValidationContext): string {
  const workspaceCommand = context?.acpCommand?.trim();
  if (workspaceCommand && workspaceCommand.length > 0) return workspaceCommand;

  const envCommand = process.env.KANBOTS_ACP_COMMAND?.trim();
  if (envCommand && envCommand.length > 0) return envCommand;

  return 'gemini';
}
