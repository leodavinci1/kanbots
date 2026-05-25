import { existsSync } from 'node:fs';
import { validateProvider, type ProviderCredentials } from '@kanbots/llm';
import type { ProviderId, Store } from '@kanbots/local-store';
import { z } from 'zod';
import type {
  ProviderSaveInput,
  ProviderSettingsInput,
  ProviderTestConnectionResult,
  ProvidersPayload,
} from '../bridge.js';
import { badRequest, parseArgs } from './errors.js';
import type { ProvidersRuntime, WorkspaceAcpCommandAccessor } from './types.js';

/**
 * Narrow deps for provider handlers. Provider config is user-level (one
 * Claude Code OAuth, one codex CLI auth per machine), so the handlers don't
 * need a full workspace `HandlerDeps`. The wider `HandlerDeps` shape is
 * assignable to this because of structural typing — existing call sites
 * still compile unchanged.
 */
export interface ProvidersHandlerDeps {
  store: Pick<Store, 'providers' | 'providerSettings'>;
  providers: ProvidersRuntime;
  acpCommand?: Pick<WorkspaceAcpCommandAccessor, 'get'>;
}

const PROVIDER_ID_SCHEMA = z.enum([
  'claude-code',
  'codex-cli',
  'gemini-cli',
  'amp-cli',
  'cursor-cli',
  'copilot-cli',
  'opencode-cli',
  'droid-cli',
  'ccr-cli',
  'qwen-cli',
  'acp',
]);

const saveSchema = z
  .object({
    id: PROVIDER_ID_SCHEMA,
    enabled: z.boolean().optional(),
    defaultModel: z.string().min(1).max(120).nullable().optional(),
    apiKey: z.string().min(1).max(2_000).nullable().optional(),
  })
  .strict();

const testSchema = z
  .object({
    id: PROVIDER_ID_SCHEMA,
    apiKey: z.string().min(1).max(2_000).optional(),
  })
  .strict();

const setDefaultsSchema = z
  .object({
    defaultProvider: PROVIDER_ID_SCHEMA.nullable().optional(),
    defaultModel: z.string().min(1).max(120).nullable().optional(),
  })
  .strict();

export async function getConfig(deps: ProvidersHandlerDeps): Promise<ProvidersPayload> {
  return readPayload(deps);
}

export async function save(
  deps: ProvidersHandlerDeps,
  args: ProviderSaveInput,
): Promise<ProvidersPayload> {
  const parsed = parseArgs(saveSchema, args);
  const id = parsed.id as ProviderId;

  // All supported providers manage their own credentials externally.
  // The app never stores API keys — each CLI either drives its own OAuth
  // (`claude-code`, `codex-cli`, etc.) or reads a well-known env var.
  if (parsed.apiKey !== undefined && parsed.apiKey !== null && parsed.apiKey !== '') {
    throw badRequest(`${id} does not accept an API key here. ${apiKeyHintFor(id)}`);
  }

  const patch: Parameters<typeof deps.store.providers.update>[1] = {};
  if (parsed.enabled !== undefined) patch.enabled = parsed.enabled;
  if (parsed.defaultModel !== undefined) patch.defaultModel = parsed.defaultModel;
  deps.store.providers.update(id, patch);
  return readPayload(deps);
}

export async function testConnection(
  deps: ProvidersHandlerDeps,
  args: { id: ProviderId; apiKey?: string },
): Promise<ProviderTestConnectionResult> {
  const parsed = parseArgs(testSchema, args);
  const id = parsed.id as ProviderId;

  let creds: ProviderCredentials;
  if (id === 'claude-code') {
    creds = {
      kind: 'claude-code-oauth',
      credentialsPath: claudeCodeCredentialsPath(),
    };
  } else {
    creds = { kind: 'api-key', apiKey: '' };
  }

  const result = await validateProvider(id, creds, {
    acpCommand: id === 'acp' ? readWorkspaceAcpCommand(deps) : null,
  });
  deps.store.providers.update(id, {
    lastValidatedAt: new Date().toISOString(),
    lastError: result.ok ? null : (result.error ?? 'unknown error'),
  });
  return {
    ok: result.ok,
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.models !== undefined ? { models: result.models } : {}),
  };
}

export async function setDefaults(
  deps: ProvidersHandlerDeps,
  args: ProviderSettingsInput,
): Promise<ProvidersPayload> {
  const parsed = parseArgs(setDefaultsSchema, args);
  const patch: Parameters<typeof deps.store.providerSettings.update>[0] = {};
  if (parsed.defaultProvider !== undefined) {
    patch.defaultProvider = (parsed.defaultProvider as ProviderId | null) ?? null;
  }
  if (parsed.defaultModel !== undefined) patch.defaultModel = parsed.defaultModel;
  deps.store.providerSettings.update(patch);
  return readPayload(deps);
}

function readPayload(deps: ProvidersHandlerDeps): ProvidersPayload {
  const rows = deps.store.providers.list();
  const settings = deps.store.providerSettings.get();

  const providers = rows.map((row) => ({
    id: row.id,
    enabled: row.enabled,
    hasKey: detectProviderCredentials(row.id, deps),
    defaultModel: row.defaultModel,
    keyEncryption: row.keyEncryption,
    lastValidatedAt: row.lastValidatedAt,
    lastError: row.lastError,
  }));

  // `hasKey` reflects detected CLI credentials (~/.claude/.credentials.json,
  // ~/.codex/auth.json, or OPENAI_API_KEY). If either CLI is signed in we
  // treat the app as configured even when the provider row hasn't been
  // explicitly toggled on — the supervisor falls back to claude-code and the
  // overlay is just there to nudge first-time users.
  const anyConfigured = providers.some((p) => p.hasKey);

  return {
    providers,
    settings: {
      defaultProvider: settings.defaultProvider,
      defaultModel: settings.defaultModel,
    },
    safeStorageAvailable: deps.providers.safeStorageAvailable(),
    anyConfigured,
  };
}

function hasCodexCliCredentials(): boolean {
  // codex finds its own auth — `codex login` writes ~/.codex/auth.json,
  // or OPENAI_API_KEY can be set in the ambient environment.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && existsSync(`${home}/.codex/auth.json`)) return true;
  if (process.env.OPENAI_API_KEY) return true;
  return false;
}

function hasGeminiCliCredentials(): boolean {
  // gemini finds its own auth — `gemini /login` writes
  // ~/.gemini/oauth_creds.json; GEMINI_API_KEY in the ambient environment
  // is the alternate path.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && existsSync(`${home}/.gemini/oauth_creds.json`)) return true;
  if (process.env.GEMINI_API_KEY) return true;
  return false;
}

function hasAmpCliCredentials(): boolean {
  // amp finds its own auth — `amp /login` writes under ~/.config/amp/;
  // AMP_API_KEY in the ambient environment is the alternate path.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && existsSync(`${home}/.config/amp/settings.json`)) return true;
  if (home && existsSync(`${home}/.config/amp/auth.json`)) return true;
  if (process.env.AMP_API_KEY) return true;
  return false;
}

function hasCursorCliCredentials(): boolean {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && existsSync(`${home}/.cursor/config.json`)) return true;
  if (home && existsSync(`${home}/.cursor`)) return true;
  if (process.env.CURSOR_API_KEY) return true;
  return false;
}

function hasCopilotCliCredentials(): boolean {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && existsSync(`${home}/.copilot/config.json`)) return true;
  if (home && existsSync(`${home}/.copilot`)) return true;
  if (home && existsSync(`${home}/.config/gh/hosts.yml`)) return true;
  if (process.env.GITHUB_TOKEN) return true;
  return false;
}

function hasOpencodeCliCredentials(): boolean {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && existsSync(`${home}/.local/share/opencode/auth.json`)) return true;
  if (home && existsSync(`${home}/.config/opencode`)) return true;
  if (process.env.OPENCODE_AUTH_TOKEN) return true;
  if (process.env.ANTHROPIC_API_KEY) return true;
  if (process.env.OPENAI_API_KEY) return true;
  return false;
}

function hasDroidCliCredentials(): boolean {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && existsSync(`${home}/.factory/config.json`)) return true;
  if (home && existsSync(`${home}/.factory/mcp.json`)) return true;
  if (home && existsSync(`${home}/.factory`)) return true;
  if (process.env.FACTORY_API_KEY) return true;
  return false;
}

function hasCcrCliCredentials(): boolean {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && existsSync(`${home}/.claude-code-router/config.json`)) return true;
  if (home && existsSync(`${home}/.claude-code-router`)) return true;
  if (process.env.ANTHROPIC_API_KEY) return true;
  if (process.env.OPENAI_API_KEY) return true;
  return false;
}

function hasQwenCliCredentials(): boolean {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home && existsSync(`${home}/.qwen/settings.json`)) return true;
  if (home && existsSync(`${home}/.qwen/installation_id`)) return true;
  if (home && existsSync(`${home}/.qwen`)) return true;
  if (process.env.DASHSCOPE_API_KEY) return true;
  if (process.env.QWEN_API_KEY) return true;
  return false;
}

function hasAcpCredentials(deps: ProvidersHandlerDeps): boolean {
  // The ACP meta-provider delegates to whichever binary is configured.
  // Treat a workspace override the same way dispatch does: it wins over env
  // and proves the row is intentionally configured.
  if (readWorkspaceAcpCommand(deps) !== null) return true;
  // Treat the presence of an override env var as a positive signal; if
  // none is set, fall through to the default gemini path so the row
  // surfaces as "configured" whenever Gemini is signed in.
  if (process.env.KANBOTS_ACP_COMMAND && process.env.KANBOTS_ACP_COMMAND.trim().length > 0) {
    return true;
  }
  return hasGeminiCliCredentials();
}

function apiKeyHintFor(id: ProviderId): string {
  switch (id) {
    case 'claude-code':
      return 'Sign in via the desktop app.';
    case 'codex-cli':
      return 'Use `codex login` or set OPENAI_API_KEY in your environment.';
    case 'gemini-cli':
      return 'Run `gemini /login` or set GEMINI_API_KEY in your environment.';
    case 'amp-cli':
      return 'Run `amp /login` or set AMP_API_KEY in your environment.';
    case 'cursor-cli':
      return 'Run `cursor-agent login` or set CURSOR_API_KEY in your environment.';
    case 'copilot-cli':
      return 'Run `gh auth login` or sign in via the Copilot CLI.';
    case 'opencode-cli':
      return 'Run `opencode auth` to configure providers.';
    case 'droid-cli':
      return 'Run `droid login` to sign in to Factory.';
    case 'ccr-cli':
      return 'Configure `~/.claude-code-router/config.json` with your provider key.';
    case 'qwen-cli':
      return 'Run `qwen-code login` or set DASHSCOPE_API_KEY in your environment.';
    case 'acp':
      return 'ACP delegates to a configured agent — set `KANBOTS_ACP_COMMAND` or use the default.';
    default: {
      const exhaustive: never = id;
      throw new Error(`unknown provider id: ${String(exhaustive)}`);
    }
  }
}

function detectProviderCredentials(id: ProviderId, deps: ProvidersHandlerDeps): boolean {
  switch (id) {
    case 'claude-code':
      return deps.providers.hasClaudeCodeCredentials();
    case 'codex-cli':
      return hasCodexCliCredentials();
    case 'gemini-cli':
      return hasGeminiCliCredentials();
    case 'amp-cli':
      return hasAmpCliCredentials();
    case 'cursor-cli':
      return hasCursorCliCredentials();
    case 'copilot-cli':
      return hasCopilotCliCredentials();
    case 'opencode-cli':
      return hasOpencodeCliCredentials();
    case 'droid-cli':
      return hasDroidCliCredentials();
    case 'ccr-cli':
      return hasCcrCliCredentials();
    case 'qwen-cli':
      return hasQwenCliCredentials();
    case 'acp':
      return hasAcpCredentials(deps);
    default: {
      const exhaustive: never = id;
      throw new Error(`unknown provider id: ${String(exhaustive)}`);
    }
  }
}

function readWorkspaceAcpCommand(deps: ProvidersHandlerDeps): string | null {
  const value = deps.acpCommand?.get().acpCommand ?? null;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function claudeCodeCredentialsPath(): string {
  // Mirror packages/desktop/src/claude-auth.ts (CLAUDE_CREDENTIALS_PATH).
  // We can't import from desktop here, but the path is stable.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  return `${home}/.claude/.credentials.json`;
}
