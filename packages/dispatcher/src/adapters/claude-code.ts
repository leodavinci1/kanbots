import { detectRateLimit, parseStreamLine, type StreamEvent } from '../stream-parser.js';
import { appendModelArg } from './model.js';
import type { AgentCliAdapter, BuildArgsInput } from './types.js';

const CLAUDE_CODE_SUBSCRIPTION_ENV_BLOCKLIST = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
] as const;

export function prepareClaudeCodeSubscriptionEnvironment(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of CLAUDE_CODE_SUBSCRIPTION_ENV_BLOCKLIST) {
    delete next[key];
  }
  return next;
}

export const claudeCodeAdapter: AgentCliAdapter = {
  command: 'claude',
  promptDelivery: 'stdin',
  buildArgs(opts: BuildArgsInput): string[] {
    const args = [
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
  prepareEnvironment: prepareClaudeCodeSubscriptionEnvironment,
  parseLine(line: string): StreamEvent[] {
    return parseStreamLine(line);
  },
  detectRateLimit(text: string) {
    return detectRateLimit(text);
  },
};
