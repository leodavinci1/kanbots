import { acpAdapter } from './adapters/acp.js';
import { ampCliAdapter } from './adapters/amp-cli.js';
import { ccrCliAdapter } from './adapters/ccr-cli.js';
import { claudeCodeAdapter } from './adapters/claude-code.js';
import { codexCliAdapter } from './adapters/codex-cli.js';
import { copilotCliAdapter } from './adapters/copilot-cli.js';
import { cursorCliAdapter } from './adapters/cursor-cli.js';
import { droidCliAdapter } from './adapters/droid-cli.js';
import { geminiCliAdapter } from './adapters/gemini-cli.js';
import { opencodeCliAdapter } from './adapters/opencode-cli.js';
import { qwenCliAdapter } from './adapters/qwen-cli.js';
import type {
  ChatRequest,
  ChatResponse,
  ProviderAdapter,
  ProviderCredentials,
  ProviderId,
  ProviderValidationContext,
  ValidateResult,
} from './types.js';

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  'claude-code': claudeCodeAdapter,
  'codex-cli': codexCliAdapter,
  'gemini-cli': geminiCliAdapter,
  'amp-cli': ampCliAdapter,
  'cursor-cli': cursorCliAdapter,
  'copilot-cli': copilotCliAdapter,
  'opencode-cli': opencodeCliAdapter,
  'droid-cli': droidCliAdapter,
  'ccr-cli': ccrCliAdapter,
  'qwen-cli': qwenCliAdapter,
  acp: acpAdapter,
};

export function getAdapter(id: ProviderId): ProviderAdapter {
  const adapter = ADAPTERS[id];
  if (!adapter) throw new Error(`unknown provider: ${id}`);
  return adapter;
}

export function listAdapters(): ProviderAdapter[] {
  return Object.values(ADAPTERS);
}

export async function validateProvider(
  id: ProviderId,
  creds: ProviderCredentials,
  context?: ProviderValidationContext,
): Promise<ValidateResult> {
  return getAdapter(id).validate(creds, context);
}

export async function chat(
  id: ProviderId,
  req: ChatRequest,
  creds: ProviderCredentials,
): Promise<ChatResponse> {
  return getAdapter(id).chat(req, creds);
}
