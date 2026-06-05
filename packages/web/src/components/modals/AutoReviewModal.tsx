import { useEffect, useState } from 'react';
import { api } from '../../api.js';

export interface AutoReviewModalProps {
  onClose: () => void;
}

const MAX_CONCURRENT_OPTIONS = [1, 2, 3] as const;
type MaxConcurrent = (typeof MAX_CONCURRENT_OPTIONS)[number];

const INTERVAL_OPTIONS = [
  { label: '1 min', ms: 60_000 },
  { label: '5 min', ms: 5 * 60_000 },
  { label: '15 min', ms: 15 * 60_000 },
  { label: '30 min', ms: 30 * 60_000 },
] as const;

const playIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="5,3 19,12 5,21" />
  </svg>
);

const stopIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
    <rect x="4" y="4" width="16" height="16" rx="2" />
  </svg>
);

export function AutoReviewModal({ onClose }: AutoReviewModalProps) {
  const [maxConcurrent, setMaxConcurrent] = useState<MaxConcurrent>(2);
  const [intervalMs, setIntervalMs] = useState(5 * 60_000);
  const [running, setRunning] = useState(false);
  const [activeIssues, setActiveIssues] = useState<number[]>([]);
  const [lastTickAt, setLastTickAt] = useState<string | null>(null);
  const [lastReviewedCount, setLastReviewedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.autoReviewStatus().then((s) => {
      setRunning(s.running);
      setActiveIssues(s.activeIssues);
      setLastTickAt(s.lastTickAt);
      setLastReviewedCount(s.lastReviewedCount);
      if (s.running) {
        setMaxConcurrent(Math.min(s.config.maxConcurrent, 3) as MaxConcurrent);
        setIntervalMs(s.config.intervalMs);
      }
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleStart(): Promise<void> {
    setError(null);
    try {
      const s = await api.autoReviewStart({ maxConcurrent, intervalMs });
      setRunning(s.running);
      setActiveIssues(s.activeIssues);
      setLastTickAt(s.lastTickAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleStop(): Promise<void> {
    setError(null);
    try {
      const s = await api.autoReviewStop();
      setRunning(s.running);
      setActiveIssues(s.activeIssues);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const intervalLabel =
    INTERVAL_OPTIONS.find((o) => o.ms === intervalMs)?.label ?? `${intervalMs / 1000}s`;

  return (
    <div className="kb-modal-scrim kb-app" onClick={onClose} role="dialog" aria-modal="true">
      <div className="kb-modal sm" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <div className="kb-modal-head">
          <span style={{ fontSize: 16 }}>🔍</span>
          <h2>Auto review</h2>
          <span className="grow" />
          <button type="button" className="x-btn" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </button>
        </div>

        <div className="kb-modal-body" style={{ display: 'block', padding: '18px 22px' }}>
          <p style={{ fontSize: 12.5, color: 'var(--ink-2)', margin: '0 0 18px' }}>
            Automatically reviews cards in the <strong>review</strong> column: runs a code reviewer
            agent, then dispatches a fix agent to address the findings. Marks cards with{' '}
            <code style={{ fontSize: 11 }}>agent:auto-reviewed</code> when done so they aren't
            re-reviewed.
          </p>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
            <label className="kb-pill-select" title="Max parallel review pipelines">
              <span className="lbl">parallel</span>
              <select
                value={maxConcurrent}
                onChange={(e) => setMaxConcurrent(Number(e.target.value) as MaxConcurrent)}
                className="kb-pill-select-native mono"
                disabled={running}
              >
                {MAX_CONCURRENT_OPTIONS.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <span className="caret">▾</span>
            </label>

            <label className="kb-pill-select" title="How often to check for new review cards">
              <span className="lbl">every</span>
              <select
                value={intervalMs}
                onChange={(e) => setIntervalMs(Number(e.target.value))}
                className="kb-pill-select-native mono"
                disabled={running}
              >
                {INTERVAL_OPTIONS.map((o) => (
                  <option key={o.ms} value={o.ms}>{o.label}</option>
                ))}
              </select>
              <span className="caret">▾</span>
            </label>
          </div>

          {!loading && (
            <div style={{ fontSize: 11.5, color: running ? 'var(--accent)' : 'var(--ink-3)', minHeight: 20 }}>
              {running ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', display: 'inline-block', flexShrink: 0 }} />
                  Running · checks every {intervalLabel} · up to {maxConcurrent} pipelines
                  {activeIssues.length > 0
                    ? ` · reviewing #${activeIssues.join(', #')}`
                    : lastTickAt
                    ? ` · last run: ${lastReviewedCount} reviewed`
                    : ' · first tick pending…'}
                </span>
              ) : (
                'Not running'
              )}
            </div>
          )}

          {error ? (
            <div style={{ color: 'var(--failed)', fontSize: 11, marginTop: 10 }}>{error}</div>
          ) : null}
        </div>

        <div className="kb-modal-foot">
          <span className="grow" />
          <button type="button" className="kb-btn ghost" onClick={onClose}>
            Close
          </button>
          {running ? (
            <button
              type="button"
              className="kb-btn"
              onClick={() => void handleStop()}
              style={{ marginLeft: 8, gap: 6 }}
            >
              {stopIcon} Stop
            </button>
          ) : (
            <button
              type="button"
              className="kb-btn primary"
              onClick={() => void handleStart()}
              style={{ marginLeft: 8, gap: 6 }}
              disabled={loading}
            >
              {playIcon} Start
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
