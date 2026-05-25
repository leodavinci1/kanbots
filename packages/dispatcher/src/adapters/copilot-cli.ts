import { parseAcpLine } from './acp-protocol.js';
import { detectRateLimit as detectRateLimitFromText, type StreamEvent } from '../stream-parser.js';
import { appendModelArg } from './model.js';
import type { AgentCliAdapter, BuildArgsInput, ComposePromptInput } from './types.js';

/**
 * GitHub Copilot CLI adapter. Spawns the official Copilot CLI (via
 * `npx -y @github/copilot`) with `--acp` and parses its JSON-RPC 2.0
 * stream via the shared ACP protocol helpers.
 *
 * Auth: copilot finds its own credentials. The CLI's own `gh auth` /
 * `copilot` login flow writes under `~/.copilot/`. The app does not
 * store or inject copilot credentials.
 *
 * `--allow-all-tools` is the permissive flag and is on by default —
 * parity with claude's `--permission-mode bypassPermissions` and codex's
 * `--dangerously-bypass-approvals-and-sandbox`. The dispatcher already
 * isolates each run in a worktree, so this is the same trust envelope.
 *
 * Copilot speaks the Agent Client Protocol (JSON-RPC 2.0 over stdio).
 * Tool calls and assistant chunks arrive as `session/update` notifications;
 * the protocol's `initialize` and `prompt` handshake is handled by the
 * generic ACP transport that ships alongside this adapter. Since the
 * dispatcher's worker spawns this adapter directly, we parse the wire
 * format inline using `parseAcpLine` rather than maintaining a full
 * JSON-RPC peer here — the worker treats us like any other line-delimited
 * stream parser.
 */

const SYSTEM_PROMPT_DELIMITER = '\n\n---\n\n';

export const copilotCliAdapter: AgentCliAdapter = {
  // Spawning via npx keeps the install footprint zero — copilot is a
  // Node CLI that's invoked with `npx -y @github/copilot` per the
  // upstream docs. Users who pin a global install (`npm i -g @github/copilot`)
  // get the same entry point.
  command: 'npx',
  promptDelivery: 'stdin',

  buildArgs(opts: BuildArgsInput): string[] {
    // Pinning a specific package keeps the experience stable across
    // npm registry updates; users can override via extraArgs.
    const args: string[] = ['-y', '@github/copilot', '--acp', '--allow-all-tools'];
    appendModelArg(args, '--model', opts.model);
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
