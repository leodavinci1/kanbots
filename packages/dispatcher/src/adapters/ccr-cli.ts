import { detectRateLimit, parseStreamLine, type StreamEvent } from '../stream-parser.js';
import { appendModelArg } from './model.js';
import type { AgentCliAdapter, BuildArgsInput } from './types.js';

/**
 * Claude Code Router (CCR) adapter. Spawns `ccr` — a drop-in router that
 * front-ends the official `claude` CLI and lets you route turns to
 * alternate providers via local config.
 *
 * Because CCR ultimately invokes `claude` under the hood (it preserves
 * the same stream-json envelope), this adapter is intentionally a thin
 * variant of the claude adapter: same flags, same parser. The only
 * difference is the binary name on PATH.
 *
 * Auth: CCR delegates to whichever provider config the user has put in
 * `~/.claude-code-router/config.json` (the OpenAI key, the Anthropic
 * subscription, etc.). The app does not store or inject CCR credentials.
 *
 * `--permission-mode bypassPermissions` keeps parity with the upstream
 * claude adapter; the dispatcher's worktree isolation provides the trust
 * envelope.
 */
export const ccrCliAdapter: AgentCliAdapter = {
  command: 'ccr',
  promptDelivery: 'stdin',

  buildArgs(opts: BuildArgsInput): string[] {
    // `code` is CCR's pass-through subcommand — it forwards the rest of
    // the argv to the underlying claude invocation. The flags below mirror
    // the claude-code adapter exactly.
    const args: string[] = [
      'code',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
    ];
    if (opts.resumeFromSessionId) {
      args.push('--resume', opts.resumeFromSessionId);
    }
    if (opts.allowedTools) {
      args.push('--tools', opts.allowedTools);
    }
    if (opts.appendSystemPrompt) {
      args.push('--append-system-prompt', opts.appendSystemPrompt);
    }
    appendModelArg(args, '--model', opts.model);
    if (opts.extraArgs && opts.extraArgs.length > 0) {
      args.push(...opts.extraArgs);
    }
    return args;
  },

  parseLine(line: string): StreamEvent[] {
    return parseStreamLine(line);
  },

  detectRateLimit(text: string) {
    return detectRateLimit(text);
  },
};
