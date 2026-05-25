import type { StreamEvent } from '../stream-parser.js';

export interface BuildArgsInput {
  resumeFromSessionId?: string;
  allowedTools?: string;
  appendSystemPrompt?: string;
  model?: string;
  extraArgs?: readonly string[];
}

export type PromptDelivery = 'stdin' | 'argv';

export interface ComposePromptInput {
  systemPrompt?: string;
  prompt: string;
}

export interface AgentCliAdapter {
  command: string;
  promptDelivery: PromptDelivery;
  normalizeModel?(model: string | undefined): string | undefined;
  buildArgs(opts: BuildArgsInput): string[];
  prepareEnvironment?(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  parseLine(line: string): StreamEvent[];
  detectRateLimit?(stderrChunk: string): Extract<StreamEvent, { kind: 'rate_limit' }> | null;
  /**
   * Compose the final prompt string sent to the CLI. The worker calls this
   * (when the adapter implements it) and either pipes the result into stdin
   * or appends it to argv depending on `promptDelivery`. Adapters that have
   * a native flag for the system prompt (e.g. claude's `--append-system-prompt`)
   * leave this unset and ignore `systemPrompt` here. Adapters without one
   * (e.g. codex) prepend it with their preferred delimiter.
   */
  composePrompt?(input: ComposePromptInput): string;
}
