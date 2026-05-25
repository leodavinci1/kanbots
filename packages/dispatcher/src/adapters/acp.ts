import { parseAcpLine } from './acp-protocol.js';
import { parseShellLikeCommand } from '../cli-command.js';
import { detectRateLimit as detectRateLimitFromText, type StreamEvent } from '../stream-parser.js';
import { appendModelArg } from './model.js';
import type { AgentCliAdapter, BuildArgsInput, ComposePromptInput } from './types.js';

/**
 * Generic Agent Client Protocol (ACP) transport adapter.
 *
 * ACP is a JSON-RPC 2.0 contract over stdio that several agents speak
 * natively (Gemini's `--experimental-acp`, Copilot's `--acp`, Qwen's
 * `--acp`, Cursor's experimental ACP build, ...). Rather than maintaining
 * a bespoke parser per agent, kanbots offers `acp` as a meta-provider:
 * pick `acp` and configure which ACP-capable binary to spawn.
 *
 * Invocation resolution order (highest priority first):
 *   1. Workspace config (`.kanbots/config.json` → `acpCommand`). Set by the
 *      desktop layer via `setAcpWorkspaceCommand` before spawning so the
 *      adapter sees the current workspace's choice without reaching for
 *      the filesystem from inside the dispatcher.
 *   2. `KANBOTS_ACP_COMMAND` environment variable.
 *   3. The documented default `gemini --experimental-acp --yolo`, which is
 *      the most widely-tested ACP server today.
 *
 * Each layer is parsed as a shell-style command: the first token is the
 * binary, the remaining tokens are the args.
 *
 * `KANBOTS_ACP_ARGS` may optionally provide extra args appended after the
 * resolved invocation.
 *
 * Deferred:
 *   - Auto-detect Gemini/Cursor ACP capability and prefer ACP transparently.
 *   - Full bidirectional JSON-RPC client (currently we receive-only via
 *     parseAcpLine; the agent drives the conversation).
 *   - Per-tool approval round-trips via `request_permission` — today the
 *     ACP server's permissive default is assumed.
 */

const SYSTEM_PROMPT_DELIMITER = '\n\n---\n\n';

const DEFAULT_ACP_COMMAND = 'gemini';
const DEFAULT_ACP_ARGS: readonly string[] = ['--experimental-acp', '--yolo'];

let workspaceAcpCommand: string | null = null;

/**
 * Inject the workspace's saved ACP command. The desktop layer reads
 * `.kanbots/config.json → acpCommand` and forwards it here before each
 * dispatch so the adapter doesn't need filesystem access. Pass `null` to
 * clear the override and fall back to the env var / default.
 */
export function setAcpWorkspaceCommand(command: string | null): void {
  if (command === null) {
    workspaceAcpCommand = null;
    return;
  }
  const trimmed = command.trim();
  workspaceAcpCommand = trimmed.length > 0 ? trimmed : null;
}

function resolveAcpInvocation(): { command: string; args: readonly string[] } {
  if (workspaceAcpCommand !== null) {
    const parsed = parseShellLikeCommand(workspaceAcpCommand);
    if (parsed !== null) return parsed;
  }
  const env = process.env.KANBOTS_ACP_COMMAND?.trim();
  if (env && env.length > 0) {
    const parsed = parseShellLikeCommand(env);
    if (parsed !== null) return parsed;
  }
  return { command: DEFAULT_ACP_COMMAND, args: DEFAULT_ACP_ARGS };
}

export const acpAdapter: AgentCliAdapter = {
  // Resolved lazily so workspace/env changes take effect without a restart.
  // `startAgentRun` reads `adapter.command` once per spawn, so we expose a
  // getter that snapshots the current invocation at that moment.
  get command(): string {
    return resolveAcpInvocation().command;
  },
  promptDelivery: 'stdin',

  buildArgs(opts: BuildArgsInput): string[] {
    const args: string[] = [...resolveAcpInvocation().args];
    // ACP servers typically read model selection from their own config
    // because the JSON-RPC handshake doesn't have a model field. We
    // forward `--model` blindly — every CLI we know that speaks ACP also
    // accepts a top-level `--model` flag, so this works for Gemini/Cursor/
    // Qwen/Copilot without per-binary special-casing.
    appendModelArg(args, '--model', opts.model);
    const extraEnv = process.env.KANBOTS_ACP_ARGS?.trim();
    if (extraEnv && extraEnv.length > 0) {
      args.push(...extraEnv.split(/\s+/));
    }
    if (opts.extraArgs && opts.extraArgs.length > 0) {
      args.push(...opts.extraArgs);
    }
    return args;
  },

  composePrompt(input: ComposePromptInput): string {
    if (!input.systemPrompt || input.systemPrompt.length === 0) {
      return input.prompt;
    }
    return `${input.systemPrompt}${SYSTEM_PROMPT_DELIMITER}${input.prompt}`;
  },

  parseLine(line: string): StreamEvent[] {
    return parseAcpLine(line);
  },

  detectRateLimit(text: string) {
    return detectRateLimitFromText(text);
  },
};
