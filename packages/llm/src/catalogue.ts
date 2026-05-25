import type { ModelEntry, ProviderId } from './types.js';

/**
 * Static model catalogue shipped with the app. Update when providers ship new
 * flagship models. The Settings UI reads this to populate per-provider model
 * dropdowns; the model picker reads it to render grouped options.
 */
export const MODELS: ModelEntry[] = [
  // Claude Code subscription
  {
    provider: 'claude-code',
    id: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    contextWindow: 1_000_000,
    toolUse: true,
    recommended: true,
  },
  {
    provider: 'claude-code',
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    contextWindow: 1_000_000,
    toolUse: true,
  },
  {
    provider: 'claude-code',
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    contextWindow: 200_000,
    toolUse: true,
  },
  // Codex CLI (OpenAI agentic CLI)
  {
    provider: 'codex-cli',
    id: 'default',
    label: 'Codex config default',
    contextWindow: 272_000,
    toolUse: true,
    recommended: true,
  },
  {
    provider: 'codex-cli',
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    contextWindow: 272_000,
    toolUse: true,
  },
  {
    provider: 'codex-cli',
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    contextWindow: 272_000,
    toolUse: true,
  },
  {
    provider: 'codex-cli',
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 mini',
    contextWindow: 272_000,
    toolUse: true,
  },
  {
    provider: 'codex-cli',
    id: 'gpt-5.3-codex',
    label: 'GPT-5.3 Codex',
    contextWindow: 272_000,
    toolUse: true,
  },
  {
    provider: 'codex-cli',
    id: 'gpt-5.2',
    label: 'GPT-5.2',
    contextWindow: 272_000,
    toolUse: true,
  },
  // Google Gemini CLI
  {
    provider: 'gemini-cli',
    id: 'gemini-3-pro-preview',
    label: 'Gemini 3 Pro',
    contextWindow: 1_000_000,
    toolUse: true,
    recommended: true,
  },
  {
    provider: 'gemini-cli',
    id: 'gemini-3-flash-preview',
    label: 'Gemini 3 Flash',
    contextWindow: 1_000_000,
    toolUse: true,
  },
  // Sourcegraph Amp CLI. Amp routes to its own configured backend; the
  // `default` id is a placeholder for "let amp pick" until the CLI exposes
  // a stable model selector.
  {
    provider: 'amp-cli',
    id: 'default',
    label: 'Amp (default)',
    contextWindow: 200_000,
    toolUse: true,
    recommended: true,
  },
  // Cursor Agent CLI. `auto` lets cursor pick the strongest model
  // available on the user's plan; the explicit ids are the most
  // commonly-recommended cursor families. Cursor's model namespace
  // evolves quickly — keep this list curated rather than exhaustive.
  {
    provider: 'cursor-cli',
    id: 'auto',
    label: 'Cursor (auto)',
    contextWindow: 200_000,
    toolUse: true,
    recommended: true,
  },
  {
    provider: 'cursor-cli',
    id: 'sonnet-4.6',
    label: 'Claude Sonnet 4.6 (Cursor)',
    contextWindow: 200_000,
    toolUse: true,
  },
  {
    provider: 'cursor-cli',
    id: 'gpt-5.4',
    label: 'GPT-5.4 (Cursor)',
    contextWindow: 400_000,
    toolUse: true,
  },
  // GitHub Copilot CLI. The `gpt-5` id maps to Copilot's flagship
  // routing alias; users can override per run if their plan exposes a
  // wider list.
  {
    provider: 'copilot-cli',
    id: 'gpt-5',
    label: 'GPT-5 (Copilot)',
    contextWindow: 256_000,
    toolUse: true,
    recommended: true,
  },
  {
    provider: 'copilot-cli',
    id: 'claude-sonnet-4.6',
    label: 'Claude Sonnet 4.6 (Copilot)',
    contextWindow: 200_000,
    toolUse: true,
  },
  // SST OpenCode. OpenCode routes to whichever providers the user
  // configured in `~/.config/opencode/` — `default` lets opencode pick;
  // explicit ids let the user pin a specific upstream.
  {
    provider: 'opencode-cli',
    id: 'default',
    label: 'OpenCode (default)',
    contextWindow: 200_000,
    toolUse: true,
    recommended: true,
  },
  // Factory Droid. `droid-1` is the headline model alias; explicit
  // upstream ids are also accepted.
  {
    provider: 'droid-cli',
    id: 'droid-1',
    label: 'Droid 1',
    contextWindow: 200_000,
    toolUse: true,
    recommended: true,
  },
  {
    provider: 'droid-cli',
    id: 'claude-sonnet-4-5-20250929',
    label: 'Claude Sonnet 4.5 (Droid)',
    contextWindow: 200_000,
    toolUse: true,
  },
  // Claude Code Router. CCR routes to whichever provider the user
  // configured in `~/.claude-code-router/config.json`; `default` defers
  // entirely to the router config.
  {
    provider: 'ccr-cli',
    id: 'default',
    label: 'CCR (router default)',
    contextWindow: 200_000,
    toolUse: true,
    recommended: true,
  },
  // Qwen Code. The CLI accepts upstream Qwen model ids; `qwen3-coder-plus`
  // is the current flagship coding variant.
  {
    provider: 'qwen-cli',
    id: 'qwen3-coder-plus',
    label: 'Qwen3 Coder Plus',
    contextWindow: 1_000_000,
    toolUse: true,
    recommended: true,
  },
  // ACP meta-provider. Model selection is delegated to the underlying
  // ACP server — the catalogue exposes a single `default` entry so the
  // model picker has something to show; the user configures the actual
  // model in the ACP server's own settings (or via the workspace
  // `acp_command` override).
  {
    provider: 'acp',
    id: 'default',
    label: 'ACP (configured agent)',
    contextWindow: 200_000,
    toolUse: true,
    recommended: true,
  },
];

export function modelsForProvider(provider: ProviderId): ModelEntry[] {
  return MODELS.filter((m) => m.provider === provider);
}

export function recommendedModel(provider: ProviderId): ModelEntry | null {
  return (
    MODELS.find((m) => m.provider === provider && m.recommended) ??
    MODELS.find((m) => m.provider === provider) ??
    null
  );
}

export function findModel(provider: ProviderId, id: string): ModelEntry | null {
  return MODELS.find((m) => m.provider === provider && m.id === id) ?? null;
}
