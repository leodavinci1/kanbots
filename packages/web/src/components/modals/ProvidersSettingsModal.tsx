import { useEffect, useMemo, useState, type ChangeEvent, type MouseEvent } from 'react';
import { api } from '../../api.js';
import { getBridge } from '../../desktop-bridge.js';
import type {
  ProviderConfigPayload,
  ProviderId,
  ProviderTestConnectionResult,
  ProvidersPayload,
} from '../../types.js';

export interface ProvidersSettingsModalProps {
  onClose: () => void;
}

interface ProviderSpec {
  id: ProviderId;
  name: string;
  description: string;
  /** Auth is handled outside the app — Claude Code OAuth or `codex login`. */
  externalAuth: true;
  signupUrl: string;
  /** Label for the in-app sign-in button. */
  signInLabel: string;
  /** Fallback hint shown alongside the sign-in button. */
  authHint: string;
}

const SPECS: ProviderSpec[] = [
  {
    id: 'claude-code',
    name: 'Claude Code subscription',
    description: 'Use your Claude Code account session. Best for agentic runs.',
    externalAuth: true,
    signupUrl: 'https://claude.com/claude-code',
    signInLabel: 'Sign in with Claude Code',
    authHint: 'Opens claude.com in your browser to complete OAuth.',
  },
  {
    id: 'codex-cli',
    name: 'Codex CLI (OpenAI)',
    description:
      'Run agent tasks through OpenAI’s codex CLI. Requires `codex` on PATH. Issue drafting and Sentry analysis still run on Claude.',
    externalAuth: true,
    signupUrl: 'https://github.com/openai/codex',
    signInLabel: 'Sign in with codex',
    authHint:
      'Spawns `codex login` and opens auth.openai.com in your browser. You can also set OPENAI_API_KEY in your environment.',
  },
  {
    id: 'gemini-cli',
    name: 'Google Gemini CLI',
    description:
      'Run agent tasks through Google’s gemini CLI. Requires `gemini` on PATH (install via `npm i -g @google/gemini-cli`).',
    externalAuth: true,
    signupUrl: 'https://github.com/google-gemini/gemini-cli',
    signInLabel: 'Open sign-in instructions',
    authHint:
      'Run `gemini /login` in your terminal to authorize. You can also set GEMINI_API_KEY in your environment.',
  },
  {
    id: 'amp-cli',
    name: 'Sourcegraph Amp',
    description:
      'Run agent tasks through Sourcegraph’s amp CLI. Requires `amp` on PATH (install via `npm i -g @sourcegraph/amp`).',
    externalAuth: true,
    signupUrl: 'https://ampcode.com',
    signInLabel: 'Open sign-in instructions',
    authHint:
      'Run `amp /login` in your terminal to authorize. You can also set AMP_API_KEY in your environment.',
  },
  {
    id: 'cursor-cli',
    name: 'Cursor Agent',
    description:
      'Run agent tasks through Cursor’s `cursor-agent` CLI. Requires `cursor-agent` on PATH (install via `curl https://cursor.com/install -fsS | bash`).',
    externalAuth: true,
    signupUrl: 'https://cursor.com',
    signInLabel: 'Open sign-in instructions',
    authHint:
      'Run `cursor-agent login` in your terminal to authorize. You can also set CURSOR_API_KEY in your environment.',
  },
  {
    id: 'copilot-cli',
    name: 'GitHub Copilot',
    description:
      'Run agent tasks through the GitHub Copilot CLI. Requires Node on PATH (the dispatcher invokes it via `npx -y @github/copilot`).',
    externalAuth: true,
    signupUrl: 'https://github.com/features/copilot',
    signInLabel: 'Open sign-in instructions',
    authHint:
      'Run `gh auth login` (with a Copilot-enabled GitHub account) to authorize. Sets up ~/.config/gh/hosts.yml.',
  },
  {
    id: 'opencode-cli',
    name: 'SST OpenCode',
    description:
      'Run agent tasks through SST’s opencode CLI. Requires `opencode` on PATH (install via `npm i -g opencode-ai`).',
    externalAuth: true,
    signupUrl: 'https://opencode.ai',
    signInLabel: 'Open sign-in instructions',
    authHint:
      'Run `opencode auth` in your terminal to configure providers. You can also set provider keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) in your environment.',
  },
  {
    id: 'droid-cli',
    name: 'Factory Droid',
    description:
      'Run agent tasks through Factory’s droid CLI. Requires `droid` on PATH (install via `curl -fsSL https://app.factory.ai/cli | sh`).',
    externalAuth: true,
    signupUrl: 'https://factory.ai',
    signInLabel: 'Open sign-in instructions',
    authHint:
      'Run `droid login` in your terminal to authorize. You can also set FACTORY_API_KEY in your environment.',
  },
  {
    id: 'ccr-cli',
    name: 'Claude Code Router',
    description:
      'Route Claude Code turns through alternate providers via CCR. Requires `ccr` on PATH (install via `npm i -g @musistudio/claude-code-router`).',
    externalAuth: true,
    signupUrl: 'https://github.com/musistudio/claude-code-router',
    signInLabel: 'Open sign-in instructions',
    authHint:
      'Edit `~/.claude-code-router/config.json` to configure which upstream provider CCR should route to.',
  },
  {
    id: 'qwen-cli',
    name: 'Qwen Code',
    description:
      'Run agent tasks through Alibaba’s qwen-code CLI. Requires `qwen-code` on PATH (install via `npm i -g @qwen-code/qwen-code`).',
    externalAuth: true,
    signupUrl: 'https://github.com/QwenLM/qwen-code',
    signInLabel: 'Open sign-in instructions',
    authHint:
      'Run `qwen-code login` in your terminal to authorize. You can also set DASHSCOPE_API_KEY or QWEN_API_KEY in your environment.',
  },
  {
    id: 'acp',
    name: 'ACP (Agent Client Protocol)',
    description:
      'Experimental transport for any agent that speaks Zed’s Agent Client Protocol. Configure the binary below (default: `gemini --experimental-acp --yolo`).',
    externalAuth: true,
    signupUrl: 'https://github.com/zed-industries/agent-client-protocol',
    signInLabel: 'Open sign-in instructions',
    authHint:
      'ACP delegates to whichever agent is configured. Sign that agent in via its own CLI, then set the ACP command below (or use the default Gemini path).',
  },
];

// Mirror @kanbots/llm catalogue. Keep in sync.
const MODELS_BY_PROVIDER: Record<ProviderId, Array<{ id: string; label: string }>> = {
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

type BridgeLoginResult = { ok: true } | { ok: false; error: string };

function runLoginForProvider(
  bridge: NonNullable<Window['kanbots']>,
  id: ProviderId,
): Promise<BridgeLoginResult> {
  switch (id) {
    case 'claude-code':
      return bridge.claudeLoginStart();
    case 'codex-cli':
      return bridge.codexLoginStart();
    case 'gemini-cli':
      return bridge.geminiLoginStart();
    case 'amp-cli':
      return bridge.ampLoginStart();
    case 'cursor-cli':
      return bridge.cursorLoginStart();
    case 'copilot-cli':
      return bridge.copilotLoginStart();
    case 'opencode-cli':
      return bridge.opencodeLoginStart();
    case 'droid-cli':
      return bridge.droidLoginStart();
    case 'ccr-cli':
      return bridge.ccrLoginStart();
    case 'qwen-cli':
      return bridge.qwenLoginStart();
    case 'acp':
      // ACP has no first-class login of its own — surface a static
      // instruction rather than reaching for a bridge method that
      // doesn't exist. The hint directs the user to configure the
      // ACP command from this same panel.
      return Promise.resolve({
        ok: false,
        error:
          'ACP delegates to whichever agent is configured. Sign that agent in via its own CLI, then set the ACP command below.',
      });
    default: {
      const exhaustive: never = id;
      throw new Error(`unknown provider id: ${String(exhaustive)}`);
    }
  }
}

function cancelLoginForProvider(bridge: NonNullable<Window['kanbots']>, id: ProviderId): void {
  switch (id) {
    case 'claude-code':
      void bridge.claudeLoginCancel();
      return;
    case 'codex-cli':
      void bridge.codexLoginCancel();
      return;
    case 'gemini-cli':
      void bridge.geminiLoginCancel();
      return;
    case 'amp-cli':
      void bridge.ampLoginCancel();
      return;
    case 'cursor-cli':
      void bridge.cursorLoginCancel();
      return;
    case 'copilot-cli':
      void bridge.copilotLoginCancel();
      return;
    case 'opencode-cli':
      void bridge.opencodeLoginCancel();
      return;
    case 'droid-cli':
      void bridge.droidLoginCancel();
      return;
    case 'ccr-cli':
      void bridge.ccrLoginCancel();
      return;
    case 'qwen-cli':
      void bridge.qwenLoginCancel();
      return;
    case 'acp':
      // No-op — ACP has no in-app login flow to cancel.
      return;
    default: {
      const exhaustive: never = id;
      throw new Error(`unknown provider id: ${String(exhaustive)}`);
    }
  }
}

function signedInLabelFor(id: ProviderId): string {
  switch (id) {
    case 'claude-code':
      return '✓ Signed in to Claude Code.';
    case 'codex-cli':
      return '✓ codex credentials detected.';
    case 'gemini-cli':
      return '✓ gemini credentials detected.';
    case 'amp-cli':
      return '✓ amp credentials detected.';
    case 'cursor-cli':
      return '✓ cursor-agent credentials detected.';
    case 'copilot-cli':
      return '✓ Copilot credentials detected.';
    case 'opencode-cli':
      return '✓ opencode credentials detected.';
    case 'droid-cli':
      return '✓ droid credentials detected.';
    case 'ccr-cli':
      return '✓ Claude Code Router configured.';
    case 'qwen-cli':
      return '✓ qwen-code credentials detected.';
    case 'acp':
      return '✓ ACP configured.';
    default: {
      const exhaustive: never = id;
      throw new Error(`unknown provider id: ${String(exhaustive)}`);
    }
  }
}

export function ProvidersSettingsModal({ onClose }: ProvidersSettingsModalProps) {
  const [payload, setPayload] = useState<ProvidersPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setPayload(await api.getProviders());
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function stopInner(e: MouseEvent<HTMLDivElement>): void {
    e.stopPropagation();
  }

  async function handleSetDefaults(input: {
    defaultProvider?: ProviderId | null;
    defaultModel?: string | null;
  }): Promise<void> {
    try {
      const next = await api.setProviderDefaults(input);
      setPayload(next);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  const configuredProviders = useMemo(
    () => (payload?.providers ?? []).filter((p) => p.enabled && p.hasKey),
    [payload],
  );

  return (
    <div className="kb-modal-scrim" onMouseDown={onClose} role="dialog" aria-modal="true">
      <div className="kb-modal kb-modal-providers sm" onMouseDown={stopInner}>
        <div className="kb-modal-head">
          <h2>AI providers</h2>
          <span className="grow" />
          <button
            type="button"
            className="x-btn"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </button>
        </div>

        <div className="kb-modal-body kb-providers-body">
          {loading ? <div>Loading…</div> : null}
          {error ? (
            <div className="kb-sentry-error" role="alert">
              {error.message}
            </div>
          ) : null}

          {payload ? (
            <>
              {!payload.anyConfigured ? (
                <div className="kb-sentry-warn" role="status">
                  <strong>No providers configured.</strong> Sign in to any of the supported agent
                  CLIs below (Claude Code, Codex, Gemini, Amp, Cursor, Copilot, OpenCode, Droid,
                  CCR, Qwen) to enable agent runs.
                </div>
              ) : null}

              <div className="kb-providers-defaults">
                <div className="kb-providers-defaults-title">Defaults</div>
                <label className="kb-sentry-row">
                  <span className="kb-sentry-label">Default provider</span>
                  <select
                    value={payload.settings.defaultProvider ?? ''}
                    onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                      void handleSetDefaults({
                        defaultProvider: (e.target.value || null) as ProviderId | null,
                      })
                    }
                  >
                    <option value="">(none)</option>
                    {configuredProviders.map((p) => (
                      <option key={p.id} value={p.id}>
                        {SPECS.find((s) => s.id === p.id)?.name ?? p.id}
                      </option>
                    ))}
                  </select>
                </label>
                {payload.settings.defaultProvider ? (
                  <label className="kb-sentry-row">
                    <span className="kb-sentry-label">Default model</span>
                    <select
                      value={payload.settings.defaultModel ?? ''}
                      onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                        void handleSetDefaults({ defaultModel: e.target.value || null })
                      }
                    >
                      <option value="">(provider default)</option>
                      {(MODELS_BY_PROVIDER[payload.settings.defaultProvider] ?? []).map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>

              <div className="kb-providers-list">
                {SPECS.map((spec) => {
                  const cfg = payload.providers.find((p) => p.id === spec.id);
                  if (!cfg) return null;
                  return (
                    <ProviderSection
                      key={spec.id}
                      spec={spec}
                      config={cfg}
                      onChanged={(next) => setPayload(next)}
                    />
                  );
                })}
              </div>
            </>
          ) : null}
        </div>

        <div className="kb-modal-foot">
          <span className="hint" />
          <button type="button" className="kb-btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; models?: string[] }
  | { kind: 'error'; message: string };

type LoginState = { kind: 'idle' } | { kind: 'running' } | { kind: 'error'; message: string };

interface SectionProps {
  spec: ProviderSpec;
  config: ProviderConfigPayload;
  onChanged: (next: ProvidersPayload) => void;
}

function ProviderSection({ spec, config, onChanged }: SectionProps) {
  const [enabled, setEnabled] = useState(config.enabled);
  const [defaultModel, setDefaultModel] = useState(config.defaultModel ?? '');
  const [saving, setSaving] = useState(false);
  const [testState, setTestState] = useState<TestState>({ kind: 'idle' });
  const [loginState, setLoginState] = useState<LoginState>({ kind: 'idle' });
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(config.enabled);
    setDefaultModel(config.defaultModel ?? '');
  }, [config.enabled, config.defaultModel]);

  const dirty = useMemo(() => {
    if (enabled !== config.enabled) return true;
    if ((defaultModel || null) !== (config.defaultModel ?? null)) return true;
    return false;
  }, [enabled, defaultModel, config]);

  async function handleSave(): Promise<void> {
    if (saving) return;
    setSaving(true);
    setLocalError(null);
    try {
      const next = await api.saveProvider({
        id: spec.id,
        enabled,
        defaultModel: defaultModel.trim() || null,
      });
      onChanged(next);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(): Promise<void> {
    setTestState({ kind: 'running' });
    try {
      const result: ProviderTestConnectionResult = await api.testProviderConnection({
        id: spec.id,
      });
      if (result.ok) {
        const out: TestState = { kind: 'ok' };
        if (result.models !== undefined) out.models = result.models;
        setTestState(out);
      } else {
        setTestState({ kind: 'error', message: result.error ?? 'unknown error' });
      }
    } catch (err) {
      setTestState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleSignIn(): Promise<void> {
    const bridge = getBridge();
    if (!bridge) {
      setLoginState({
        kind: 'error',
        message: 'Desktop bridge unavailable — open the desktop app to sign in.',
      });
      return;
    }
    setLoginState({ kind: 'running' });
    try {
      const result = await runLoginForProvider(bridge, spec.id);
      if (!result.ok) {
        setLoginState({ kind: 'error', message: result.error });
        return;
      }
      // Refresh the providers payload so `hasKey` flips to true and the
      // section swaps to the "configured" state.
      const next = await api.getProviders();
      onChanged(next);
      setLoginState({ kind: 'idle' });
    } catch (err) {
      setLoginState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function handleCancelSignIn(): void {
    const bridge = getBridge();
    if (!bridge) return;
    cancelLoginForProvider(bridge, spec.id);
  }

  const models = MODELS_BY_PROVIDER[spec.id] ?? [];
  const signedInLabel = signedInLabelFor(spec.id);

  return (
    <section className="kb-provider-section">
      <header className="kb-provider-header">
        <strong>{spec.name}</strong>
        {config.hasKey ? <span className="kb-provider-badge">configured</span> : null}
      </header>
      <p className="kb-provider-desc">{spec.description}</p>

      <label className="kb-sentry-row kb-sentry-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setEnabled(e.target.checked)}
        />
        <span>Enabled</span>
      </label>

      <div className="kb-sentry-row">
        {config.hasKey ? (
          <span>{signedInLabel}</span>
        ) : (
          <span>
            {spec.authHint}{' '}
            <a href={spec.signupUrl} target="_blank" rel="noopener noreferrer">
              Learn more
            </a>
          </span>
        )}
      </div>

      {!config.hasKey ? (
        <div className="kb-provider-actions">
          <button
            type="button"
            className="kb-btn primary"
            onClick={() => void handleSignIn()}
            disabled={loginState.kind === 'running'}
          >
            {loginState.kind === 'running' ? 'Waiting for browser…' : spec.signInLabel}
          </button>
          {loginState.kind === 'running' ? (
            <button type="button" className="kb-btn ghost" onClick={handleCancelSignIn}>
              Cancel
            </button>
          ) : null}
        </div>
      ) : null}
      {loginState.kind === 'error' ? (
        <div className="kb-sentry-error">{loginState.message}</div>
      ) : null}

      <label className="kb-sentry-row">
        <span className="kb-sentry-label">Default model</span>
        <select
          value={defaultModel}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => setDefaultModel(e.target.value)}
        >
          <option value="">(none)</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      <div className="kb-provider-actions">
        <button
          type="button"
          className="kb-btn"
          disabled={testState.kind === 'running'}
          onClick={() => void handleTest()}
        >
          {testState.kind === 'running' ? 'Testing…' : 'Test connection'}
        </button>
        <button
          type="button"
          className="kb-btn primary"
          disabled={!dirty || saving}
          onClick={() => void handleSave()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {testState.kind === 'ok' ? (
        <div className="kb-sentry-ok">
          ✓ Connection ok
          {testState.models && testState.models.length > 0
            ? ` — ${testState.models.length} models available`
            : ''}
          .
        </div>
      ) : null}
      {testState.kind === 'error' ? (
        <div className="kb-sentry-error">{testState.message}</div>
      ) : null}
      {localError ? <div className="kb-sentry-error">{localError}</div> : null}
      {config.lastError ? (
        <div className="kb-sentry-error">Last error: {config.lastError}</div>
      ) : null}

      {spec.id === 'acp' ? <AcpCommandPanel /> : null}
    </section>
  );
}

function AcpCommandPanel() {
  const [initial, setInitial] = useState<string>('');
  const [draft, setDraft] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.getWorkspaceAcpCommand();
        if (cancelled) return;
        const value = res.acpCommand ?? '';
        setInitial(value);
        setDraft(value);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = draft.trim() !== initial.trim();

  async function handleSave(): Promise<void> {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const trimmed = draft.trim();
      const res = await api.setWorkspaceAcpCommand({
        acpCommand: trimmed.length === 0 ? null : trimmed,
      });
      const next = res.acpCommand ?? '';
      setInitial(next);
      setDraft(next);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="kb-provider-acp">
      <label className="kb-sentry-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <span className="kb-sentry-label">ACP command</span>
        <input
          type="text"
          value={draft}
          placeholder="gemini --experimental-acp --yolo"
          disabled={loading || saving}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
          spellCheck={false}
          style={{
            width: '100%',
            fontFamily: 'var(--ff-mono)',
            fontSize: 12.5,
            padding: 8,
          }}
        />
        <div className="kb-sentry-hint" style={{ marginTop: 4 }}>
          Run any ACP-compatible CLI (Gemini, Cursor, etc.) via the Agent Client Protocol.
        </div>
      </label>
      <div className="kb-provider-actions">
        <button
          type="button"
          className="kb-btn primary"
          disabled={loading || saving || !dirty}
          onClick={() => void handleSave()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {savedAt !== null && !dirty ? (
          <span className="kb-sentry-hint" style={{ alignSelf: 'center' }}>
            Saved.
          </span>
        ) : null}
      </div>
      {error ? <div className="kb-sentry-error">{error}</div> : null}
    </div>
  );
}
