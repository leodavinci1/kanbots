export interface BoardFiltersStats {
  issues: number;
  runs: number;
  awaiting: number;
  costToday: number;
}

export type BoardSortMode = 'manual' | 'priority' | 'createdAt' | 'updatedAt';

export interface BoardFiltersControls {
  hasAgent: boolean;
  priorities: ReadonlySet<string>;
  areas: ReadonlySet<string>;
  availablePriorities: readonly string[];
  availableAreas: readonly string[];
  includeBacklog: boolean;
  /** Number of issues in the (hidden) backlog — null hides the toggle when 0. */
  backlogCount: number;
  sortMode: BoardSortMode;
  onToggleHasAgent: () => void;
  onTogglePriority: (p: string) => void;
  onToggleArea: (a: string) => void;
  onToggleIncludeBacklog: () => void;
  onChangeSortMode: (mode: BoardSortMode) => void;
  onClear: () => void;
}

const SORT_LABEL: Record<BoardSortMode, string> = {
  manual: 'Manual',
  priority: 'Priority',
  createdAt: 'Newest',
  updatedAt: 'Recently active',
};

export interface BoardFiltersProps {
  stats: BoardFiltersStats;
  /** Pass null in cloud mode (phase 1) — only the Open pill + stats render. */
  controls: BoardFiltersControls | null;
}

/**
 * Shared filter row: "Open" pill + optional toggleable pills for has-agent /
 * priority / area + stats summary. Cloud mode passes `controls={null}` until
 * filter state and label parity land in a later phase.
 */
export function BoardFilters({ stats, controls }: BoardFiltersProps) {
  const anyOn =
    controls !== null &&
    (controls.hasAgent || controls.priorities.size > 0 || controls.areas.size > 0);
  return (
    <div className="kb-filter-row">
      <span className="kb-pill on" title="Only open issues are loaded">
        <span className="kb-pill-x" />
        Open
      </span>
      {controls !== null ? (
        <>
          {controls.backlogCount > 0 || controls.includeBacklog ? (
            <button
              type="button"
              className={`kb-pill${controls.includeBacklog ? ' on' : ''}`}
              onClick={controls.onToggleIncludeBacklog}
              aria-pressed={controls.includeBacklog}
              title={
                controls.includeBacklog
                  ? 'Click to hide the Backlog column'
                  : `Click to show the Backlog column (${controls.backlogCount} hidden)`
              }
            >
              {controls.includeBacklog ? <span className="kb-pill-x" /> : null}
              {controls.includeBacklog
                ? 'Backlog'
                : `Backlog (${controls.backlogCount})`}
            </button>
          ) : null}
          <button
            type="button"
            className={`kb-pill${controls.hasAgent ? ' on kb-pill-running' : ''}`}
            onClick={controls.onToggleHasAgent}
            aria-pressed={controls.hasAgent}
          >
            {controls.hasAgent ? <span className="kb-pill-x" /> : null}
            Has agent
          </button>
          {controls.availablePriorities.map((p) => {
            const on = controls.priorities.has(p);
            return (
              <button
                key={p}
                type="button"
                className={`kb-pill${on ? ' on' : ''}`}
                onClick={() => controls.onTogglePriority(p)}
                aria-pressed={on}
              >
                {on ? <span className="kb-pill-x" /> : null}
                priority:{p}
              </button>
            );
          })}
          {controls.availableAreas.slice(0, 4).map((area) => {
            const on = controls.areas.has(area);
            return (
              <button
                key={area}
                type="button"
                className={`kb-pill${on ? ' on' : ''}`}
                onClick={() => controls.onToggleArea(area)}
                aria-pressed={on}
              >
                {on ? <span className="kb-pill-x" /> : null}
                {area}
              </button>
            );
          })}
          {anyOn ? (
            <button
              type="button"
              className="kb-pill"
              onClick={controls.onClear}
              title="Clear filters"
              style={{ color: 'var(--ink-3)' }}
            >
              clear
            </button>
          ) : null}
        </>
      ) : null}
      {controls !== null ? (
        <label
          className="kb-board-sort"
          title={
            controls.sortMode === 'manual'
              ? 'Manual sort lets you drag cards within a column (drag-reorder ships in a later milestone)'
              : `Sorting by ${SORT_LABEL[controls.sortMode].toLowerCase()} — switch to Manual for drag-reorder`
          }
        >
          <span className="kb-board-sort-label">Sort</span>
          <select
            className="kb-board-sort-select"
            value={controls.sortMode}
            onChange={(e) => controls.onChangeSortMode(e.target.value as BoardSortMode)}
          >
            <option value="manual">{SORT_LABEL.manual}</option>
            <option value="priority">{SORT_LABEL.priority}</option>
            <option value="createdAt">{SORT_LABEL.createdAt}</option>
            <option value="updatedAt">{SORT_LABEL.updatedAt}</option>
          </select>
        </label>
      ) : null}
      <span className="kb-stats-line">
        {stats.issues} issue{stats.issues === 1 ? '' : 's'} · {stats.runs} active run
        {stats.runs === 1 ? '' : 's'} · {stats.awaiting} awaiting
        {stats.costToday > 0 ? ` · $${stats.costToday.toFixed(2)} today` : ''}
      </span>
    </div>
  );
}
