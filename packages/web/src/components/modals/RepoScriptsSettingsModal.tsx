import { Logo } from '../Logo.js';
import { useEffect, useRef, useState, type ChangeEvent, type MouseEvent } from 'react';
import { api } from '../../api.js';

const SCRIPT_MAX_BYTES = 4 * 1024;

interface ScriptDraft {
  devServer: string;
  setup: string;
  cleanup: string;
}

const EMPTY: ScriptDraft = { devServer: '', setup: '', cleanup: '' };

type RunOutput = {
  kind: 'setup' | 'cleanup';
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: string;
} | null;

export interface RepoScriptsSettingsModalProps {
  onClose: () => void;
  /** When set, the modal runs that script automatically once data is loaded. */
  autoRun?: 'setup' | 'cleanup';
}

export function RepoScriptsSettingsModal({ onClose, autoRun }: RepoScriptsSettingsModalProps) {
  const [initial, setInitial] = useState<ScriptDraft>(EMPTY);
  const [draft, setDraft] = useState<ScriptDraft>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [running, setRunning] = useState<null | 'setup' | 'cleanup'>(null);
  const [output, setOutput] = useState<RunOutput>(null);
  const autoRunFiredRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.getWorkspaceScripts();
        if (cancelled) return;
        const next: ScriptDraft = {
          devServer: res.scripts.devServer ?? '',
          setup: res.scripts.setup ?? '',
          cleanup: res.scripts.cleanup ?? '',
        };
        setInitial(next);
        setDraft(next);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
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

  const dirty =
    draft.devServer.trim() !== initial.devServer.trim() ||
    draft.setup.trim() !== initial.setup.trim() ||
    draft.cleanup.trim() !== initial.cleanup.trim();

  function byteLength(s: string): number {
    return new TextEncoder().encode(s.trim()).length;
  }
  const overLimit =
    byteLength(draft.devServer) > SCRIPT_MAX_BYTES ||
    byteLength(draft.setup) > SCRIPT_MAX_BYTES ||
    byteLength(draft.cleanup) > SCRIPT_MAX_BYTES;

  async function handleSave(): Promise<void> {
    if (saving || overLimit) return;
    setSaving(true);
    setError(null);
    try {
      const next = await api.setWorkspaceScripts({
        devServer: draft.devServer.trim() === '' ? null : draft.devServer.trim(),
        setup: draft.setup.trim() === '' ? null : draft.setup.trim(),
        cleanup: draft.cleanup.trim() === '' ? null : draft.cleanup.trim(),
      });
      const merged: ScriptDraft = {
        devServer: next.scripts.devServer ?? '',
        setup: next.scripts.setup ?? '',
        cleanup: next.scripts.cleanup ?? '',
      };
      setInitial(merged);
      setDraft(merged);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setSaving(false);
    }
  }

  // Auto-run once the initial script values have loaded. Guarded so the
  // effect doesn't re-fire on every dependency change.
  useEffect(() => {
    if (autoRun === undefined) return;
    if (loading || autoRunFiredRef.current) return;
    const script = autoRun === 'setup' ? initial.setup : initial.cleanup;
    if (script.trim().length === 0) return;
    autoRunFiredRef.current = true;
    void handleRun(autoRun);
    // handleRun is stable enough for our purposes; keep deps minimal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, loading, initial.setup, initial.cleanup]);

  async function handleRun(kind: 'setup' | 'cleanup'): Promise<void> {
    if (running !== null || dirty) return;
    if ((kind === 'setup' ? initial.setup : initial.cleanup).trim() === '') return;
    setRunning(kind);
    setOutput(null);
    try {
      const res = await api.runWorkspaceScript(kind);
      setOutput({ kind, ...res });
    } catch (err) {
      setOutput({
        kind,
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        stdoutTruncated: false,
        stderrTruncated: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunning(null);
    }
  }

  function updateField<K extends keyof ScriptDraft>(key: K, value: string): void {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  return (
    <div
      className="kb-modal-scrim kb-app"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Repo scripts"
    >
      <div className="kb-modal kb-sentry-modal" onClick={stopInner}>
        <div className="kb-modal-head">
          <Logo size={11} withWordmark />
          <span style={{ color: 'var(--ink-4)' }}>·</span>
          <h2>Repo scripts</h2>
          <span className="grow" />
          <button
            type="button"
            className="x-btn"
            onClick={onClose}
            aria-label="Close (Esc)"
            title="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </button>
        </div>

        <div className="kb-modal-body kb-sentry-body">
          <div className="kb-sentry-hint">
            Shell commands that run inside the bound repo. Used by the in-app preview and by
            one-shot setup / cleanup actions in the command palette. Stored in{' '}
            <code>.kanbots/config.json</code> and executed via the system shell.
          </div>

          {loading ? <div className="kb-sentry-row">Loading…</div> : null}

          {error ? (
            <div className="kb-sentry-error" role="alert">
              {error.message}
            </div>
          ) : null}

          {!loading ? (
            <>
              <ScriptField
                label="Dev server"
                hint="Used by the in-app preview when set, falls back to `pnpm dev` otherwise."
                value={draft.devServer}
                placeholder="pnpm dev"
                onChange={(v) => updateField('devServer', v)}
                rows={2}
                overLimit={byteLength(draft.devServer) > SCRIPT_MAX_BYTES}
                bytes={byteLength(draft.devServer)}
              />
              <ScriptField
                label="Setup"
                hint="One-shot script run from the command palette. Use for `pnpm i`, env priming, etc."
                value={draft.setup}
                placeholder="pnpm i"
                onChange={(v) => updateField('setup', v)}
                rows={3}
                overLimit={byteLength(draft.setup) > SCRIPT_MAX_BYTES}
                bytes={byteLength(draft.setup)}
                {...(initial.setup.trim().length > 0 && !dirty
                  ? { onRun: () => void handleRun('setup') }
                  : {})}
                runDisabled={running !== null || dirty}
                running={running === 'setup'}
              />
              <ScriptField
                label="Cleanup"
                hint="One-shot script run from the command palette after you're done in this repo."
                value={draft.cleanup}
                placeholder="rm -rf .turbo dist"
                onChange={(v) => updateField('cleanup', v)}
                rows={3}
                overLimit={byteLength(draft.cleanup) > SCRIPT_MAX_BYTES}
                bytes={byteLength(draft.cleanup)}
                {...(initial.cleanup.trim().length > 0 && !dirty
                  ? { onRun: () => void handleRun('cleanup') }
                  : {})}
                runDisabled={running !== null || dirty}
                running={running === 'cleanup'}
              />

              {output ? (
                <div className="kb-scripts-output" role="region" aria-label="Script output">
                  <div className="kb-scripts-output-head">
                    <span className={`kb-scripts-output-status${output.ok ? ' ok' : ' err'}`}>
                      {output.ok ? '✓ ok' : `✗ exit ${output.exitCode ?? '?'}`}
                    </span>
                    <span>{output.kind} script</span>
                    <span className="grow" />
                    <button
                      type="button"
                      className="kb-btn ghost"
                      onClick={() => setOutput(null)}
                    >
                      Dismiss
                    </button>
                  </div>
                  {output.error ? (
                    <div className="kb-sentry-error">{output.error}</div>
                  ) : null}
                  {output.stdout ? (
                    <pre className="kb-scripts-output-pane">
                      {output.stdout}
                      {output.stdoutTruncated ? '\n…[truncated]' : ''}
                    </pre>
                  ) : null}
                  {output.stderr ? (
                    <pre className="kb-scripts-output-pane is-err">
                      {output.stderr}
                      {output.stderrTruncated ? '\n…[truncated]' : ''}
                    </pre>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="kb-modal-foot">
          <span className="hint">
            Saved to <code>.kanbots/config.json</code>. Dev-server change takes effect on next
            preview start.
          </span>
          <span className="grow" />
          <button type="button" className="kb-btn ghost" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="kb-btn primary"
            onClick={() => void handleSave()}
            disabled={saving || !dirty || overLimit}
            title={overLimit ? `One or more scripts exceed ${SCRIPT_MAX_BYTES} bytes` : undefined}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ScriptFieldProps {
  label: string;
  hint: string;
  value: string;
  placeholder: string;
  rows: number;
  overLimit: boolean;
  bytes: number;
  onChange: (v: string) => void;
  onRun?: () => void;
  runDisabled?: boolean;
  running?: boolean;
}

function ScriptField({
  label,
  hint,
  value,
  placeholder,
  rows,
  overLimit,
  bytes,
  onChange,
  onRun,
  runDisabled,
  running,
}: ScriptFieldProps) {
  return (
    <label className="kb-sentry-row kb-scripts-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div className="kb-scripts-row-head">
        <span className="kb-sentry-label">{label}</span>
        {onRun ? (
          <button
            type="button"
            className="kb-btn ghost"
            onClick={onRun}
            disabled={runDisabled}
            title={
              runDisabled
                ? 'Save unsaved changes first'
                : `Run the ${label.toLowerCase()} script in this repo`
            }
          >
            {running ? 'Running…' : `Run ${label.toLowerCase()}`}
          </button>
        ) : null}
      </div>
      <textarea
        value={value}
        placeholder={placeholder}
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
        rows={rows}
        spellCheck={false}
        style={{
          width: '100%',
          fontFamily: 'var(--ff-mono)',
          fontSize: 12.5,
          padding: 8,
          resize: 'vertical',
        }}
      />
      <div
        className="kb-sentry-hint"
        style={{
          marginTop: 4,
          display: 'flex',
          justifyContent: 'space-between',
          color: overLimit ? 'var(--del)' : undefined,
        }}
      >
        <span>{hint}</span>
        <span>
          {bytes} / {SCRIPT_MAX_BYTES} bytes
        </span>
      </div>
    </label>
  );
}
