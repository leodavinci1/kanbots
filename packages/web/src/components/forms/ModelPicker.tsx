import { useEffect, useMemo } from 'react';
import { api } from '../../api.js';
import { useFetch } from '../../hooks/useFetch.js';
import type { ProviderId } from '../../types.js';

export interface ModelEntry {
  id: string;
  label: string;
}

// Mirror @kanbots/llm catalogue. Keep in sync.
export const MODEL_OPTIONS: Record<ProviderId, ModelEntry[]> = {
  'claude-code': [
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ],
  'codex-cli': [
    { id: 'default', label: 'Codex config default' },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
    { id: 'gpt-5.2', label: 'GPT-5.2' },
  ],
  'gemini-cli': [
    { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro' },
    { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' },
  ],
  'amp-cli': [{ id: 'default', label: 'Amp (default)' }],
  'cursor-cli': [
    { id: 'auto', label: 'Cursor (auto)' },
    { id: 'sonnet-4.6', label: 'Claude Sonnet 4.6 (Cursor)' },
    { id: 'gpt-5.4', label: 'GPT-5.4 (Cursor)' },
  ],
  'copilot-cli': [
    { id: 'gpt-5', label: 'GPT-5 (Copilot)' },
    { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6 (Copilot)' },
  ],
  'opencode-cli': [{ id: 'default', label: 'OpenCode (default)' }],
  'droid-cli': [
    { id: 'droid-1', label: 'Droid 1' },
    { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5 (Droid)' },
  ],
  'ccr-cli': [{ id: 'default', label: 'CCR (router default)' }],
  'qwen-cli': [{ id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus' }],
  acp: [{ id: 'default', label: 'ACP (configured agent)' }],
};

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  'claude-code': 'Claude Code',
  'codex-cli': 'Codex CLI',
  'gemini-cli': 'Gemini CLI',
  'amp-cli': 'Amp',
  'cursor-cli': 'Cursor Agent',
  'copilot-cli': 'GitHub Copilot',
  'opencode-cli': 'OpenCode',
  'droid-cli': 'Factory Droid',
  'ccr-cli': 'Claude Code Router',
  'qwen-cli': 'Qwen Code',
  acp: 'ACP',
};

const AGENT_RUN_PROVIDERS: ReadonlySet<ProviderId> = new Set([
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

export function isAgentRunProvider(provider: ProviderId): boolean {
  return AGENT_RUN_PROVIDERS.has(provider);
}

export function modelLabel(provider: ProviderId, model: string): string {
  return MODEL_OPTIONS[provider]?.find((entry) => entry.id === model)?.label ?? model;
}

export interface ModelPickerValue {
  provider: ProviderId;
  model: string;
}

export interface ModelPickerProps {
  value: ModelPickerValue | null;
  onChange: (next: ModelPickerValue) => void;
  className?: string;
  /**
   * If true, only providers that support agent runs are shown. All shipped
   * provider CLIs qualify today, so this is currently a no-op filter —
   * kept on the API for parity with chat-only futures.
   */
  agentRunsOnly?: boolean;
}

export function ModelPicker({ value, onChange, className, agentRunsOnly }: ModelPickerProps) {
  const { data: providers } = useFetch('providers', () => api.getProviders());

  const options = useMemo(() => {
    if (!providers) return [] as Array<{ provider: ProviderId; models: ModelEntry[] }>;
    return providers.providers
      .filter((p) => p.enabled && p.hasKey)
      .filter((p) => (agentRunsOnly ? isAgentRunProvider(p.id) : true))
      .map((p) => ({ provider: p.id, models: MODEL_OPTIONS[p.id] ?? [] }));
  }, [providers, agentRunsOnly]);

  // Auto-select first option if value is unset and options become available.
  useEffect(() => {
    if (value || options.length === 0) return;
    const first = options[0];
    if (!first || first.models.length === 0) return;
    const firstModel = first.models[0];
    if (firstModel) {
      onChange({ provider: first.provider, model: firstModel.id });
    }
  }, [value, options, onChange]);

  const selectedKey = value ? `${value.provider}:${value.model}` : '';

  return (
    <select
      className={className}
      value={selectedKey}
      onChange={(e) => {
        const [provider, model] = e.target.value.split(':') as [ProviderId, string];
        if (provider && model) onChange({ provider, model });
      }}
    >
      {options.length === 0 ? <option value="">(no providers configured)</option> : null}
      {options.map(({ provider, models }) => (
        <optgroup key={provider} label={PROVIDER_LABELS[provider]}>
          {models.map((m) => (
            <option key={`${provider}:${m.id}`} value={`${provider}:${m.id}`}>
              {m.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
