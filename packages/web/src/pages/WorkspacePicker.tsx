import { useEffect, useState } from 'react';
import { getBridge, type RecentWorkspace } from '../desktop-bridge.js';
import { Logo } from '../components/Logo.js';
import { CloudSettingsModal } from '../components/modals/CloudSettingsModal.js';

export function WorkspacePicker({
  initialRecents,
  cloudAuthed,
  onOpened,
  onBrowseCloud,
  onCloudAuthChanged,
}: {
  initialRecents: RecentWorkspace[];
  cloudAuthed: boolean;
  onOpened: () => void;
  /** Switch to the cloud project picker. Only meaningful when signed in. */
  onBrowseCloud?: () => void;
  /** Notify parent that cloud auth state may have changed (login / logout). */
  onCloudAuthChanged?: (authed: boolean) => void;
}) {
  const [recents, setRecents] = useState<RecentWorkspace[]>(initialRecents);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCloudModal, setShowCloudModal] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) return;
    void bridge.recentWorkspaces().then(setRecents);
  }, []);

  async function open(repoPath: string): Promise<void> {
    const bridge = getBridge();
    if (!bridge) {
      setError('Desktop bridge not available — open the desktop app instead.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await bridge.openWorkspace(repoPath);
    if (!result.ok) {
      setBusy(false);
      setError(result.error);
      return;
    }
    onOpened();
  }

  async function pickFolder(): Promise<void> {
    const bridge = getBridge();
    if (!bridge) {
      setError('Desktop bridge not available — open the desktop app instead.');
      return;
    }
    const path = await bridge.pickFolder();
    if (!path) return;
    await open(path);
  }

  async function signOut(): Promise<void> {
    if (signingOut) return;
    if (!window.confirm('Sign out of Kanbots Cloud on this device?')) return;
    const bridge = getBridge();
    if (!bridge) return;
    setSigningOut(true);
    try {
      await bridge.cloudLogout();
      onCloudAuthChanged?.(false);
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="picker">
      <div className="picker-card">
        <h1 className="picker-title">
          <Logo size={28} withWordmark />
        </h1>
        <p className="picker-sub">Pick a project folder to open its workspace.</p>
        <button
          type="button"
          className="picker-primary"
          onClick={() => void pickFolder()}
          disabled={busy}
        >
          {busy ? 'Opening…' : 'Open folder…'}
        </button>
        {error ? (
          <p className="composer-error" role="alert">
            {error}
          </p>
        ) : null}
        {recents.length > 0 ? (
          <div className="picker-recents">
            <h2 className="picker-recents-heading">Recent</h2>
            <ul className="picker-recents-list">
              {recents.map((r) => (
                <li key={r.repoPath}>
                  <button
                    type="button"
                    className="picker-recent"
                    onClick={() => void open(r.repoPath)}
                    disabled={busy}
                  >
                    <span className="picker-recent-name">{r.displayName}</span>
                    <span className="picker-recent-path muted">{r.repoPath}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="muted picker-empty">No recent workspaces yet.</p>
        )}

        <div className="picker-cloud-footer">
          {cloudAuthed ? (
            <>
              <span className="muted">Signed in to Kanbots Cloud.</span>{' '}
              {onBrowseCloud !== undefined ? (
                <>
                  <button
                    type="button"
                    className="picker-cloud-link"
                    onClick={onBrowseCloud}
                  >
                    Browse cloud projects
                  </button>
                  <span className="muted"> · </span>
                </>
              ) : null}
              <button
                type="button"
                className="picker-cloud-link"
                onClick={() => void signOut()}
                disabled={signingOut}
              >
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </>
          ) : (
            <>
              <span className="muted">Want team sync?</span>{' '}
              <button
                type="button"
                className="picker-cloud-link"
                onClick={() => setShowCloudModal(true)}
              >
                Sign in to Kanbots Cloud
              </button>
            </>
          )}
        </div>
      </div>

      {showCloudModal ? (
        <CloudSettingsModal
          onClose={() => setShowCloudModal(false)}
          onChanged={(status) => onCloudAuthChanged?.(status.authed)}
        />
      ) : null}
    </div>
  );
}
