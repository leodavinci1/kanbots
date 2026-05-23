import { useEffect, useState } from 'react';
import { api } from '../../api.js';

export interface PreviewPanelProps {
  activeRunId?: number;
  branch: string | null;
  worktreePath?: string | null;
  /** When `compact`, the preview canvas is shorter — use inside a tab pane. */
  size?: 'compact' | 'tall';
}

type DeviceMode = 'desktop' | 'mobile' | 'responsive';

const MOBILE_W = 390;
const MOBILE_H = 844;

export function PreviewPanel({
  activeRunId,
  branch,
  worktreePath,
  size = 'compact',
}: PreviewPanelProps) {
  const [state, setState] = useState<{
    url: string | null;
    state: 'idle' | 'booting' | 'live' | 'crashed' | 'stopped';
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceMode>('desktop');
  // URL bar lets the user navigate the preview to a sub-path. We keep an
  // explicit "loadedUrl" separate from "draftUrl" so typing doesn't
  // re-fetch the iframe on every keystroke; the user commits with Enter
  // or the submit button.
  const [draftUrl, setDraftUrl] = useState<string>('');
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [copyOk, setCopyOk] = useState(false);

  useEffect(() => {
    if (!activeRunId) {
      setState(null);
      return;
    }
    let cancelled = false;
    api
      .getAgentRunPreview(activeRunId)
      .then((p) => {
        if (!cancelled) setState({ url: p.url, state: p.state });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeRunId]);

  async function start(): Promise<void> {
    if (!activeRunId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.startAgentRunPreview(activeRunId);
      setState({ url: p.url, state: p.state });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function stop(): Promise<void> {
    if (!activeRunId || busy) return;
    setBusy(true);
    try {
      const p = await api.stopAgentRunPreview(activeRunId);
      setState({ url: p.url, state: p.state });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const url = state?.url ?? null;
  const isLive = state?.state === 'live' && url;
  const canvasHeight = size === 'tall' ? 360 : 280;

  // When the upstream URL changes (start/restart/run-switch), sync the
  // draft input and the actual loaded iframe URL.
  useEffect(() => {
    if (url === null) {
      setDraftUrl('');
      setLoadedUrl(null);
      return;
    }
    setDraftUrl(url);
    setLoadedUrl(url);
  }, [url]);

  function submitUrl(): void {
    if (draftUrl.trim() === '') return;
    setLoadedUrl(draftUrl.trim());
    setIframeKey((k) => k + 1);
  }
  function refresh(): void {
    setIframeKey((k) => k + 1);
  }
  async function copyUrl(): Promise<void> {
    if (loadedUrl === null) return;
    try {
      await navigator.clipboard.writeText(loadedUrl);
      setCopyOk(true);
      window.setTimeout(() => setCopyOk(false), 1200);
    } catch {
      // ignore — clipboard may be unavailable in restricted contexts.
    }
  }

  return (
    <div className="kb-preview-frame" role="region" aria-label="Branch preview">
      <div className="pf-bar">
        <div className="pf-dots" aria-hidden>
          <i />
          <i />
          <i />
        </div>
        {activeRunId ? (
          <button
            type="button"
            className="pf-play"
            onClick={() => void (isLive ? stop() : start())}
            disabled={busy || state?.state === 'booting'}
            aria-label={isLive ? 'Pause preview' : 'Resume preview'}
            title={
              busy || state?.state === 'booting'
                ? 'Preview is changing state…'
                : isLive
                  ? 'Pause the dev server'
                  : state?.state === 'crashed'
                    ? 'Retry — the dev server crashed'
                    : 'Resume the dev server'
            }
          >
            <span aria-hidden>{isLive ? '⏸' : '▶'}</span>
          </button>
        ) : null}
        {isLive ? (
          <form
            className="pf-url-form"
            onSubmit={(e) => {
              e.preventDefault();
              submitUrl();
            }}
          >
            <input
              type="url"
              className="pf-url-input"
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
              spellCheck={false}
              autoCorrect="off"
              aria-label="Preview URL"
              title="Edit and press Enter to navigate"
            />
            <button
              type="button"
              className="pf-url-action"
              onClick={refresh}
              title="Refresh preview"
              aria-label="Refresh preview"
            >
              <span aria-hidden>↻</span>
            </button>
            <button
              type="button"
              className="pf-url-action"
              onClick={() => void copyUrl()}
              title={copyOk ? 'Copied!' : 'Copy URL'}
              aria-label="Copy URL"
            >
              <span aria-hidden>{copyOk ? '✓' : '⧉'}</span>
            </button>
            <button
              type="button"
              className="pf-url-action"
              onClick={() => loadedUrl && window.open(loadedUrl, '_blank')}
              title="Open in external browser"
              aria-label="Open in external browser"
            >
              <span aria-hidden>↗</span>
            </button>
          </form>
        ) : (
          <div className="pf-url">
            {url ?? `(no preview)`} · {branch ?? '(no worktree)'}
          </div>
        )}
        {isLive ? (
          <div className="pf-device" role="group" aria-label="Device preview mode">
            <button
              type="button"
              className={`pf-device-btn${device === 'desktop' ? ' is-active' : ''}`}
              aria-pressed={device === 'desktop'}
              title="Desktop view (full width)"
              onClick={() => setDevice('desktop')}
            >
              Desktop
            </button>
            <button
              type="button"
              className={`pf-device-btn${device === 'mobile' ? ' is-active' : ''}`}
              aria-pressed={device === 'mobile'}
              title={`Mobile view (${MOBILE_W}×${MOBILE_H})`}
              onClick={() => setDevice('mobile')}
            >
              Mobile
            </button>
            <button
              type="button"
              className={`pf-device-btn${device === 'responsive' ? ' is-active' : ''}`}
              aria-pressed={device === 'responsive'}
              title="Responsive view (drag the bottom-right corner to resize)"
              onClick={() => setDevice('responsive')}
            >
              Responsive
            </button>
          </div>
        ) : null}
        <span style={{ color: state?.state === 'live' ? 'var(--review)' : 'var(--ink-3)' }}>
          {state?.state ?? 'idle'}
        </span>
      </div>
      <div
        className={`pf-canvas pf-canvas-${device}`}
        style={{ height: canvasHeight, padding: 0 }}
      >
        {isLive ? (
          device === 'mobile' ? (
            <div className="pf-mobile-shell" aria-label="Mobile device frame">
              <iframe
                key={iframeKey}
                src={loadedUrl ?? undefined}
                title="Branch preview"
                sandbox="allow-scripts allow-same-origin allow-forms"
                style={{
                  width: MOBILE_W,
                  height: MOBILE_H,
                  border: 'none',
                  background: 'white',
                  display: 'block',
                }}
              />
            </div>
          ) : device === 'responsive' ? (
            <div className="pf-responsive-shell">
              <iframe
                key={iframeKey}
                src={loadedUrl ?? undefined}
                title="Branch preview"
                sandbox="allow-scripts allow-same-origin allow-forms"
                style={{ width: '100%', height: '100%', border: 'none', background: 'white' }}
              />
            </div>
          ) : (
            <iframe
              src={url ?? undefined}
              title="Branch preview"
              sandbox="allow-scripts allow-same-origin allow-forms"
              style={{ width: '100%', height: '100%', border: 'none', background: 'white' }}
            />
          )
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              padding: 24,
              height: '100%',
            }}
          >
            <div className="lbl" style={{ color: 'var(--ink-2)' }}>
              BRANCH PREVIEW
            </div>
            <div className="lbl" style={{ color: 'var(--ink-3)' }}>
              {worktreePath ? `worktree: ${worktreePath}` : 'no worktree'}
            </div>
            {activeRunId ? (
              <button
                type="button"
                className="kb-btn primary"
                onClick={() => void start()}
                disabled={busy || state?.state === 'booting'}
              >
                {busy
                  ? 'Starting…'
                  : state?.state === 'crashed'
                    ? 'Retry preview'
                    : 'Start preview'}
              </button>
            ) : (
              <div className="lbl" style={{ color: 'var(--ink-4)' }}>
                no active run
              </div>
            )}
            {error ? (
              <div className="kb-composer-error" style={{ marginTop: 8 }}>
                {error}
              </div>
            ) : null}
          </div>
        )}
      </div>
      {isLive ? (
        <div
          style={{
            display: 'flex',
            gap: 6,
            padding: '8px 10px',
            borderTop: '1px solid var(--hairline-soft)',
            background: 'var(--bg)',
          }}
        >
          <button
            type="button"
            className="kb-btn ghost"
            onClick={() => void stop()}
            disabled={busy}
          >
            Stop preview
          </button>
          <button
            type="button"
            className="kb-btn ghost"
            onClick={() => url && window.open(url, '_blank')}
          >
            Open in browser ↗
          </button>
        </div>
      ) : null}
    </div>
  );
}
