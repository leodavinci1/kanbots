import { detectRateLimit, parseStreamLine, type StreamEvent } from '../stream-parser.js';
import { appendModelArg } from './model.js';
import type { AgentCliAdapter, BuildArgsInput, ComposePromptInput } from './types.js';

/**
 * Sourcegraph Amp CLI adapter. Spawns `amp` and parses its stream-JSON
 * output.
 *
 * Amp emits an Anthropic-compatible stream-json envelope (the same shape
 * claude-code produces), so the parser is shared with claude. The CLI
 * accepts the prompt over stdin.
 *
 * Auth: amp finds its own credentials (`amp /login` writes to
 * `~/.config/amp/`; `AMP_API_KEY` is honored in the environment too).
 * The app does not store or inject amp credentials.
 *
 * `--dangerously-allow-all` is the permissive flag and is on by default —
 * parity with claude's `--permission-mode bypassPermissions` and codex's
 * `--dangerously-bypass-approvals-and-sandbox`. The dispatcher already
 * isolates each run in a worktree, so this is the same trust envelope.
 *
 * Session resume is not supported in v1: amp's session model differs from
 * claude's and would need separate plumbing. The worker will throw if
 * `resumeFromSessionId` is set.
 */

const SYSTEM_PROMPT_DELIMITER = '\n\n---\n\n';

export const ampCliAdapter: AgentCliAdapter = {
  command: 'amp',
  promptDelivery: 'stdin',

  buildArgs(opts: BuildArgsInput): string[] {
    const args: string[] = ['--execute', '--stream-json', '--dangerously-allow-all'];
    appendModelArg(args, '--model', opts.model);
    if (opts.extraArgs && opts.extraArgs.length > 0) {
      args.push(...opts.extraArgs);
    }
    // appendSystemPrompt is folded in by composePrompt because amp doesn't
    // expose a dedicated flag for it. allowedTools is similarly N/A: amp
    // gates its tool surface with --dangerously-allow-all instead.
    return args;
  },

  composePrompt(input: ComposePromptInput): string {
    if (!input.systemPrompt || input.systemPrompt.length === 0) {
      return input.prompt;
    }
    return `${input.systemPrompt}${SYSTEM_PROMPT_DELIMITER}${input.prompt}`;
  },

  parseLine(line: string): StreamEvent[] {
    // Amp's stream envelope matches Anthropic's, so the claude parser
    // handles assistant/user/result/system frames directly. Any divergence
    // would surface as parse_error events for follow-up.
    return parseStreamLine(line);
  },

  detectRateLimit(text: string) {
    return detectRateLimit(text);
  },
};
