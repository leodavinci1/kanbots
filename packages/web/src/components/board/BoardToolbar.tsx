import type { ReactNode } from 'react';
import { WorkspaceCostMeter } from './WorkspaceCostMeter.js';

export interface BoardToolbarProps {
  crumbs: ReactNode;
  onOpenPalette?: (() => void) | undefined;
  onOpenAutopilot?: (() => void) | undefined;
  onOpenReadyToGo?: (() => void) | undefined;
  readyToGoActive?: boolean | undefined;
  onOpenAutoReview?: (() => void) | undefined;
  autoReviewActive?: boolean | undefined;
  onCreate?: (() => void) | undefined;
  createLabel?: string | undefined;
  createKbd?: string | undefined;
  /** Disable the Autopilot button (cloud mode shows tooltip until the endpoint lands). */
  autopilotDisabled?: boolean | undefined;
  autopilotDisabledTitle?: string | undefined;
  /** Extra trailing action buttons — used by cloud mode for "Refresh" / "Switch workspace". */
  trailingActions?: ReactNode;
  /** Workspace-wide cost since midnight (sum of run totalCostUsd). Null
   *  while the first fetch is in flight; the meter dims to a placeholder
   *  rather than flashing "$0.00". Omit entirely to hide the meter. */
  costTodayUsd?: number | null | undefined;
  /** Optional handler invoked when the user clicks the cost meter —
   *  typically opens the Stats & cost modal. */
  onOpenCostMeter?: (() => void) | undefined;
}

const searchIcon = (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
  >
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);

const plusIcon = (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
  >
    <path d="M12 5v14M5 12h14" />
  </svg>
);

/**
 * Shared board toolbar: breadcrumbs on the left, command-palette search,
 * Autopilot, and Create buttons on the right. Cloud mode supplies extra
 * trailing actions and disables Autopilot until phase 3.
 */
export function BoardToolbar({
  crumbs,
  onOpenPalette,
  onOpenAutopilot,
  onOpenReadyToGo,
  readyToGoActive = false,
  onOpenAutoReview,
  autoReviewActive = false,
  onCreate,
  createLabel = 'New task',
  createKbd = 'N',
  autopilotDisabled = false,
  autopilotDisabledTitle,
  trailingActions,
  costTodayUsd,
  onOpenCostMeter,
}: BoardToolbarProps) {
  // Show the meter when the caller wires it up at all — `undefined` hides
  // it (used by hosts that don't have cost data yet); `null` keeps it
  // visible but in its loading-placeholder state.
  const showCostMeter = costTodayUsd !== undefined;
  return (
    <div className="kb-board-toolbar">
      <div className="kb-crumbs">{crumbs}</div>
      <div className="kb-toolbar-actions">
        <button
          type="button"
          className="kb-search"
          onClick={() => onOpenPalette?.()}
          aria-label="Open command palette"
        >
          {searchIcon}
          <span>Search issues, branches, agents…</span>
          <span className="kb-search-kbd">⌘K</span>
        </button>
        {showCostMeter ? (
          <WorkspaceCostMeter totalUsd={costTodayUsd} onClick={onOpenCostMeter} />
        ) : null}
        <button
          type="button"
          className="kb-btn ghost"
          onClick={() => onOpenReadyToGo?.()}
          title="Auto-dispatch todo tasks on a timer"
          style={{ position: 'relative' }}
        >
          {readyToGoActive ? (
            <span style={{ position: 'absolute', top: 4, right: 4, width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)' }} />
          ) : null}
          Ready to go
        </button>
        <button
          type="button"
          className="kb-btn ghost"
          onClick={() => onOpenAutoReview?.()}
          title="Auto-review cards in the review column"
          style={{ position: 'relative' }}
        >
          {autoReviewActive ? (
            <span style={{ position: 'absolute', top: 4, right: 4, width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)' }} />
          ) : null}
          Auto review
        </button>
        <button
          type="button"
          className="kb-btn ghost"
          onClick={() => onOpenAutopilot?.()}
          title={autopilotDisabled ? autopilotDisabledTitle : 'Start an autopilot session'}
          disabled={autopilotDisabled}
        >
          Autopilot
        </button>
        <button type="button" className="kb-btn primary" onClick={() => onCreate?.()}>
          {plusIcon} {createLabel} <span className="kb-kbd">{createKbd}</span>
        </button>
        {trailingActions}
      </div>
    </div>
  );
}
