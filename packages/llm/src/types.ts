import type { ProviderId } from '@kanbots/local-store';
import type { AgentRunHandle, StartAgentRunOptions, StreamEvent } from '@kanbots/dispatcher';

export type { ProviderId };

export interface ProviderCapabilities {
  /** Streams events as they arrive (all current providers do). */
  streaming: boolean;
  /** Supports tool/function calling. */
  toolUse: boolean;
  /** Supports parallel tool calls in a single turn. */
  parallelToolCalls: boolean;
  /** Supports image input on chat messages. */
  imageInput: boolean;
  /** Supports resuming a session by id (Claude Code CLI only in v1). */
  resumeBySessionId: boolean;
  /**
   * v1 flag: this provider can be used to run an autonomous agent loop
   * (i.e. tool calls execute and feed back). Currently only `claude-code`.
   * Other providers expose chat-only access.
   */
  agentRuns: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
}

export interface ChatResponse {
  text: string;
  tokenUsage: { input: number; output: number } | null;
}

export interface ValidateResult {
  ok: boolean;
  error?: string;
  /** Optional model list returned during validation. */
  models?: string[];
}

export interface ProviderAdapter {
  id: ProviderId;
  capabilities: ProviderCapabilities;
  /**
   * Validate that credentials work. Cheap call (e.g. /models).
   */
  validate(
    creds: ProviderCredentials,
    context?: ProviderValidationContext,
  ): Promise<ValidateResult>;
  /**
   * One-shot chat call. Used by composer/suggester-style helpers and the
   * Settings "Test connection" flow.
   */
  chat(req: ChatRequest, creds: ProviderCredentials): Promise<ChatResponse>;
  /**
   * Start an interactive agent run. Only the `claude-code` adapter supports
   * this in v1; others throw.
   */
  startAgentRun?(opts: StartAgentRunOptions, creds: ProviderCredentials): AgentRunHandle;
}

export type ProviderCredentials =
  | { kind: 'api-key'; apiKey: string }
  | { kind: 'claude-code-oauth'; credentialsPath: string };

export interface ProviderValidationContext {
  acpCommand?: string | null;
}

export interface ModelEntry {
  provider: ProviderId;
  id: string;
  label: string;
  contextWindow: number;
  toolUse: boolean;
  recommended?: boolean;
}

export type { StreamEvent, AgentRunHandle, StartAgentRunOptions };
