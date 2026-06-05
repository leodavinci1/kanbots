import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { api } from '../api.js';
import { AutopilotLaunchModal } from '../components/modals/AutopilotLaunchModal.js';
import { ReadyToGoModal } from '../components/modals/ReadyToGoModal.js';
import { BoardViewsModal } from '../components/modals/BoardViewsModal.js';
import { BoardErrorBanner } from '../components/board/BoardErrorBanner.js';
import { BoardFilters } from '../components/board/BoardFilters.js';
import { BoardToolbar } from '../components/board/BoardToolbar.js';
import { BoardUsageRow } from '../components/board/BoardUsageRow.js';
import { BulkActionBar, type BulkStatusTarget } from '../components/board/BulkActionBar.js';
import { CardPreview, type CardSelectModifiers } from '../components/Card.js';
import { Column, type SuggestActivity } from '../components/Column.js';
import { PersonaPickerModal } from '../components/modals/PersonaPickerModal.js';
import { useBoardAgentStreams } from '../hooks/useBoardAgentStreams.js';
import { useBoardViews, boardViewStateEqual } from '../hooks/useBoardViews.js';
import { useCardSelection } from '../hooks/useCardSelection.js';
import { useCloudBoardStreams } from '../hooks/useCloudBoardStreams.js';
import { getCloudCtx } from '../api.js';
import { useBoardFilters } from '../hooks/useBoardFilters.js';
import { useFetch } from '../hooks/useFetch.js';
import { useFocusedRepo } from '../hooks/useFocusedRepo.js';
import { useIssues, dispatchIssuesRefetch } from '../hooks/useIssues.js';
import { useSelection } from '../hooks/useSelection.js';
import { useWorkspace } from '../hooks/useWorkspace.js';
import { usePrefsStore, type BoardSortMode } from '../stores/usePrefsStore.js';
import { COLUMNS, priorityFromLabels, withStatus, type Priority } from '../labels.js';
import type { Persona } from '../personas.js';
import type { Issue, ProviderId, StatusKey } from '../types.js';

type SortMode = BoardSortMode;
const PRIORITY_RANK: Record<Priority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };

function sortIssues(issues: Issue[], mode: SortMode): Issue[] {
  if (mode === 'manual') return issues;
  const out = [...issues];
  if (mode === 'priority') {
    out.sort((a, b) => {
      const ap = priorityFromLabels(a.labels);
      const bp = priorityFromLabels(b.labels);
      const ar = ap === null ? 99 : PRIORITY_RANK[ap];
      const br = bp === null ? 99 : PRIORITY_RANK[bp];
      if (ar !== br) return ar - br;
      // Tiebreak on createdAt desc so newer items surface within the same priority.
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    return out;
  }
  const field = mode === 'createdAt' ? 'createdAt' : 'updatedAt';
  out.sort((a, b) => new Date(b[field]).getTime() - new Date(a[field]).getTime());
  return out;
}

const STATUS_KEYS: readonly StatusKey[] = ['backlog', 'todo', 'inProgress', 'review', 'done'];

function issueNumberFromDragId(id: UniqueIdentifier): number | null {
  if (typeof id !== 'string' || !id.startsWith('card:')) return null;
  const n = Number.parseInt(id.slice(5), 10);
  return Number.isFinite(n) ? n : null;
}

function statusFromDropId(id: UniqueIdentifier): StatusKey | null | undefined {
  if (typeof id !== 'string' || !id.startsWith('col:')) return undefined;
  const rest = id.slice(4);
  if (rest === 'inbox') return null;
  return (STATUS_KEYS as readonly string[]).includes(rest) ? (rest as StatusKey) : undefined;
}

interface GroupedIssues {
  byKey: Record<StatusKey, Issue[]>;
  untagged: Issue[];
}

function groupByStatus(issues: Issue[]): GroupedIssues {
  const grouped: GroupedIssues = {
    byKey: { backlog: [], todo: [], inProgress: [], review: [], done: [] },
    untagged: [],
  };
  for (const issue of issues) {
    if (issue.status === null) {
      grouped.untagged.push(issue);
    } else {
      grouped.byKey[issue.status].push(issue);
    }
  }
  // Inbox order: unreviewed (no sentryMeta or sentryMeta.status === 'imported')
  // first, analyzed last. Manual entries treated as unreviewed since they
  // also need attention. Ties broken by createdAt desc.
  grouped.untagged.sort((a, b) => {
    const aReviewed = a.sentryMeta?.status === 'analyzed';
    const bReviewed = b.sentryMeta?.status === 'analyzed';
    if (aReviewed !== bReviewed) return aReviewed ? 1 : -1;
    const at = new Date(a.createdAt).getTime();
    const bt = new Date(b.createdAt).getTime();
    return bt - at;
  });
  return grouped;
}

export interface BoardProps {
  onOpenDetail?: (issueNumber: number) => void;
  onOpenCreate?: () => void;
  onOpenPalette?: () => void;
  /** Optional handler for the toolbar's workspace cost meter — typically
   *  opens the Stats & cost modal. Omit to render the meter as static. */
  onOpenStats?: () => void;
}

export function Board({ onOpenDetail, onOpenCreate, onOpenPalette, onOpenStats }: BoardProps = {}) {
  const { data: config } = useFetch('config', () => api.config());
  const { issues, loading, error, mutate } = useIssues();
  const { data: costToday, refetch: refetchCostToday } = useFetch('cost:today', () =>
    api.costToday(),
  );
  const { data: costUsage, refetch: refetchCostUsage } = useFetch('cost:usage', () =>
    api.costUsage(),
  );
  const filterApi = useBoardFilters(issues);
  const { focusedRepoId } = useFocusedRepo();
  const sortMode = usePrefsStore((s) => s.board.sortMode);
  const setSortMode = usePrefsStore((s) => s.setBoardSortMode);

  // Poll the usage meters (claude.ai OAuth windows) once a minute — the
  // backend caches /usage for 60s anyway, so polling faster just thrashes
  // the renderer. The workspace cost rollup (`cost:today`) refreshes on a
  // tighter 30s cadence so the toolbar meter feels responsive as agent
  // runs accumulate spend. Both pause when the tab is hidden so a
  // background window doesn't burn requests.
  useEffect(() => {
    let cancelled = false;
    function tickUsage(): void {
      if (cancelled) return;
      if (typeof document === 'undefined' || !document.hidden) {
        void refetchCostUsage();
      }
    }
    function tickToday(): void {
      if (cancelled) return;
      if (typeof document === 'undefined' || !document.hidden) {
        void refetchCostToday();
      }
    }
    const usageId = window.setInterval(tickUsage, 60_000);
    const todayId = window.setInterval(tickToday, 30_000);
    function onVisibility(): void {
      if (!document.hidden) {
        tickUsage();
        tickToday();
      }
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(usageId);
      window.clearInterval(todayId);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refetchCostUsage, refetchCostToday]);

  const [activeNumber, setActiveNumber] = useState<number | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestActivity, setSuggestActivity] = useState<SuggestActivity[]>([]);
  const [suggestStartedAt, setSuggestStartedAt] = useState<string | null>(null);
  const [personaPickerOpen, setPersonaPickerOpen] = useState(false);
  const [autopilotLaunchOpen, setAutopilotLaunchOpen] = useState(false);
  const [readyToGoOpen, setReadyToGoOpen] = useState(false);
  const [readyToGoActive, setReadyToGoActive] = useState(false);
  const [selectedNumber, setSelectedNumber] = useSelection();
  const [bulkBusy, setBulkBusy] = useState(false);
  const [manageViewsOpen, setManageViewsOpen] = useState(false);
  const cardSelection = useCardSelection();
  const workspaceMeta = useWorkspace();
  const viewsApi = useBoardViews(workspaceMeta.workspace.id);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const list = filterApi.filtered;
  const activeRunIds = useMemo(
    () => list.filter((i) => i.activeRun !== null).map((i) => i.activeRun!.id),
    [list],
  );
  const liveByRunLocal = useBoardAgentStreams(activeRunIds);

  // Cloud board cards carry their cloud-run KSUID on activeRun.cloudRunId
  // (set by cardToIssue); subscribe per-card so live tool/arg ticks the
  // way it does locally. The two RunLiveMaps share the same key shape
  // (activeRun.id), so merging them is a flat spread.
  const cloudCtx = getCloudCtx();
  const cloudEntries = useMemo(
    () =>
      list
        .filter(
          (i): i is typeof i & { activeRun: NonNullable<typeof i.activeRun> } =>
            i.activeRun !== null && typeof i.activeRun.cloudRunId === 'string',
        )
        .map((i) => ({ key: i.activeRun.id, cloudRunId: i.activeRun.cloudRunId as string })),
    [list],
  );
  const liveByRunCloud = useCloudBoardStreams(
    cloudCtx?.orgSlug ?? null,
    cloudCtx?.projectSlug ?? null,
    cloudEntries,
  );
  const liveByRun = useMemo(() => {
    if (liveByRunCloud.size === 0) return liveByRunLocal;
    const merged = new Map(liveByRunLocal);
    for (const [k, v] of liveByRunCloud) merged.set(k, v);
    return merged;
  }, [liveByRunLocal, liveByRunCloud]);

  useEffect(() => {
    if (!suggesting) return;
    const bridge = typeof window !== 'undefined' ? window.kanbots : undefined;
    if (!bridge) return;
    const unsub = bridge.subscribe('composer:suggest:event', (payload) => {
      const ev = payload as Partial<SuggestActivity> | null;
      if (!ev || typeof ev !== 'object') return;
      if (ev.kind === 'tool' && typeof ev.name === 'string') {
        const tool: SuggestActivity = {
          kind: 'tool',
          name: ev.name,
          summary: typeof ev.summary === 'string' ? ev.summary : '',
        };
        setSuggestActivity((prev) => [...prev, tool].slice(-10));
      } else if (ev.kind === 'thought' && typeof ev.text === 'string') {
        const thought: SuggestActivity = { kind: 'thought', text: ev.text };
        setSuggestActivity((prev) => [...prev, thought].slice(-10));
      }
    });
    return () => {
      unsub();
    };
  }, [suggesting]);

  // Sync ready-to-go active state on mount
  useEffect(() => {
    void api.readyToGoStatus().then((s) => setReadyToGoActive(s.running)).catch(() => {});
  }, []);

  // Memoised before the loading/error guards so the hook order stays
  // stable across renders — the early returns below add zero hooks when
  // they fire, but any new hook added _after_ them would skip on the first
  // render and break the Rules of Hooks.
  const grouped = useMemo(() => {
    const base = groupByStatus(list);
    if (sortMode === 'manual') return base;
    return {
      byKey: {
        backlog: sortIssues(base.byKey.backlog, sortMode),
        todo: sortIssues(base.byKey.todo, sortMode),
        inProgress: sortIssues(base.byKey.inProgress, sortMode),
        review: sortIssues(base.byKey.review, sortMode),
        done: sortIssues(base.byKey.done, sortMode),
      },
      untagged: base.untagged,
    };
  }, [list, sortMode]);

  // The next three memos must be declared before the loading/error guards
  // so the hook-call order stays stable across renders. They depend only
  // on values already computed above (grouped, filterApi, sortMode,
  // viewsApi) so hoisting them is a no-op semantically — the prior
  // location after the guards caused a `useMemo` to be skipped on the
  // first render and added on later renders, tripping the Rules of Hooks.

  const orderedNumbers = useMemo<number[]>(() => {
    const out: number[] = [];
    for (const issue of grouped.untagged) out.push(issue.number);
    if (filterApi.includeBacklog) {
      for (const issue of grouped.byKey.backlog) out.push(issue.number);
    }
    for (const issue of grouped.byKey.todo) out.push(issue.number);
    for (const issue of grouped.byKey.inProgress) out.push(issue.number);
    for (const issue of grouped.byKey.review) out.push(issue.number);
    for (const issue of grouped.byKey.done) out.push(issue.number);
    return out;
  }, [grouped, filterApi.includeBacklog]);

  const currentViewState = useMemo(
    () => ({
      filters: {
        hasAgent: filterApi.filters.hasAgent,
        priorities: [...filterApi.filters.priorities],
        areas: [...filterApi.filters.areas],
      },
      sortMode,
      includeBacklog: filterApi.includeBacklog,
    }),
    [filterApi.filters, sortMode, filterApi.includeBacklog],
  );

  const matchedViewId = useMemo(() => {
    for (const v of viewsApi.views) {
      if (boardViewStateEqual(v, currentViewState)) return v.id;
    }
    return null;
  }, [viewsApi.views, currentViewState]);

  if (loading && issues.length === 0) {
    return (
      <div className="kb-app" style={{ padding: 32, color: 'var(--ink-2)' }}>
        Loading…
      </div>
    );
  }
  if (error) {
    return (
      <div className="kb-app" style={{ padding: 32 }}>
        <h2 style={{ color: 'var(--ink)', fontSize: 16, marginBottom: 12 }}>
          Failed to load issues
        </h2>
        <pre style={{ color: 'var(--failed)' }}>{error.message}</pre>
      </div>
    );
  }
  const activeIssue =
    activeNumber !== null ? (issues.find((i) => i.number === activeNumber) ?? null) : null;

  const stats = {
    issues: list.length,
    runs: list.filter((i) => i.agent === 'running').length,
    awaiting: list.filter((i) => i.agent === 'blocked').length,
    costToday: costToday?.totalUsd ?? 0,
  };

  function onDragStart(event: DragStartEvent): void {
    const n = issueNumberFromDragId(event.active.id);
    setActiveNumber(n);
  }

  async function onDragEnd(event: DragEndEvent): Promise<void> {
    setActiveNumber(null);
    const { active, over } = event;
    if (!over) return;

    const issueNumber = issueNumberFromDragId(active.id);
    if (issueNumber === null) return;

    const targetStatus = statusFromDropId(over.id);
    if (targetStatus === undefined) return;

    const current = list.find((i) => i.number === issueNumber);
    if (!current) return;
    if (current.status === targetStatus) return;

    const fromStatus = current.status;
    const nextLabels = withStatus(current.labels, targetStatus);
    const before = list;

    mutate((prev) =>
      (prev ?? []).map((i) =>
        i.number === issueNumber ? { ...i, status: targetStatus, labels: nextLabels } : i,
      ),
    );

    try {
      const updated = await api.updateIssue(issueNumber, { labels: nextLabels });
      mutate((prev) => (prev ?? []).map((i) => (i.number === issueNumber ? updated : i)));
      setMoveError(null);
    } catch (err) {
      mutate(before);
      const message = err instanceof Error ? err.message : String(err);
      setMoveError(`Couldn't move #${issueNumber}: ${message}`);
      return;
    }

    if (targetStatus === 'inProgress' && current.activeRun == null) {
      try {
        await api.dispatchIssue(issueNumber, {
          fromStatus,
          ...(focusedRepoId !== null ? { repoId: focusedRepoId } : {}),
        });
        dispatchIssuesRefetch();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setMoveError(`Moved #${issueNumber}, but couldn't start an agent: ${message}`);
      }
    }
  }

  function openPersonaPicker(): void {
    if (suggesting) return;
    setPersonaPickerOpen(true);
  }

  async function runSuggestionWith(
    persona: Persona,
    provider?: ProviderId,
    userNotes?: string,
  ): Promise<void> {
    setPersonaPickerOpen(false);
    if (suggesting) return;
    setSuggestActivity([]);
    setSuggestStartedAt(new Date().toISOString());
    setSuggesting(true);
    setMoveError(null);
    try {
      const drafted = await api.suggestFeature(persona.prompt, provider, userNotes);
      await api.createIssue({
        title: drafted.title,
        body: drafted.body,
        labels: ['status:backlog', 'type:feat'],
      });
      dispatchIssuesRefetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMoveError(`Couldn't suggest a feature: ${message}`);
    } finally {
      setSuggesting(false);
      setSuggestStartedAt(null);
    }
  }

  /**
   * Stable rendered order across columns. Used by shift-range selection
   * so a range can span columns the same way a Trello / Linear board
   * does. Order matches the visible top-to-bottom layout:
   * inbox → backlog (if shown) → todo → inProgress → review → done.
   *
   * NOTE: declared at the top of the component (above the loading/error
   * guards) so the hook order stays stable across renders. See the
   * `grouped` / `currentViewState` / `matchedViewId` comments for the
   * same constraint.
   */
  // (`orderedNumbers` / `currentViewState` / `matchedViewId` are declared
  // earlier in the function — see the block before the loading/error
  // early returns. Kept here as documentation only.)

  function handleCardSelect(n: number, modifiers: CardSelectModifiers): void {
    if (modifiers.shiftKey) {
      cardSelection.selectRange(cardSelection.anchor, n, orderedNumbers);
      return;
    }
    if (modifiers.metaOrCtrlKey) {
      cardSelection.toggle(n);
      return;
    }
    // Plain click — focus the card and clear any multi-select. The
    // selection ring (single) lives on the route hash; the multi-select
    // ring lives in the ephemeral hook state.
    if (cardSelection.selected.size > 0) cardSelection.clear();
    setSelectedNumber(n);
  }

  function handleBoardBackgroundClick(e: ReactMouseEvent<HTMLDivElement>): void {
    // Only clear the multi-select if the click landed on the empty
    // background — clicks that bubble from a card should be left alone.
    if (e.target === e.currentTarget && cardSelection.selected.size > 0) {
      cardSelection.clear();
    }
  }

  async function withBulkBusy<T>(fn: () => Promise<T>): Promise<T | null> {
    setBulkBusy(true);
    setMoveError(null);
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMoveError(`Bulk action failed: ${message}`);
      return null;
    } finally {
      setBulkBusy(false);
    }
  }

  // v1 of bulk ops piggybacks on the per-issue endpoints via
  // Promise.allSettled so we don't have to ship a new backend channel
  // for what's mostly a fan-out. If any subset fails, the rest still
  // succeed and the error banner surfaces an aggregate message.
  async function bulkMoveToStatus(status: BulkStatusTarget): Promise<void> {
    const targets = [...cardSelection.selected];
    if (targets.length === 0) return;
    await withBulkBusy(async () => {
      const before = issues;
      const results = await Promise.allSettled(
        targets.map(async (n) => {
          const issue = before.find((i) => i.number === n);
          if (!issue) return null;
          const nextLabels = withStatus(issue.labels, status);
          return api.updateIssue(n, { labels: nextLabels });
        }),
      );
      dispatchIssuesRefetch();
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        throw new Error(`${failed} of ${targets.length} card(s) failed to move`);
      }
    });
  }

  async function bulkAddLabels(labels: string[]): Promise<void> {
    const targets = [...cardSelection.selected];
    if (targets.length === 0 || labels.length === 0) return;
    await withBulkBusy(async () => {
      const before = issues;
      const results = await Promise.allSettled(
        targets.map(async (n) => {
          const issue = before.find((i) => i.number === n);
          if (!issue) return null;
          const set = new Set(issue.labels);
          for (const l of labels) set.add(l);
          return api.updateIssue(n, { labels: [...set] });
        }),
      );
      dispatchIssuesRefetch();
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        throw new Error(`${failed} of ${targets.length} card(s) failed to label`);
      }
    });
  }

  async function bulkDispatch(): Promise<void> {
    const targets = [...cardSelection.selected];
    if (targets.length === 0) return;
    await withBulkBusy(async () => {
      const before = issues;
      const results = await Promise.allSettled(
        targets.map(async (n) => {
          const issue = before.find((i) => i.number === n);
          if (!issue) return null;
          if (issue.activeRun !== null) return null;
          return api.dispatchIssue(n, {
            fromStatus: issue.status,
            ...(focusedRepoId !== null ? { repoId: focusedRepoId } : {}),
          });
        }),
      );
      dispatchIssuesRefetch();
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        throw new Error(
          `${failed} of ${targets.length} card(s) failed to dispatch`,
        );
      }
    });
  }

  async function bulkArchive(): Promise<void> {
    const targets = [...cardSelection.selected];
    if (targets.length === 0) return;
    const ok = window.confirm(
      `Archive ${targets.length} card${targets.length === 1 ? '' : 's'}?`,
    );
    if (!ok) return;
    await withBulkBusy(async () => {
      const results = await Promise.allSettled(
        targets.map((n) => api.archiveIssue(n)),
      );
      dispatchIssuesRefetch();
      cardSelection.clear();
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        throw new Error(
          `${failed} of ${targets.length} card(s) failed to archive`,
        );
      }
    });
  }

  // --- Saved views ---------------------------------------------------------
  //
  // (`currentViewState` + `matchedViewId` are declared earlier in the
  // function — see the block before the loading/error early returns.)

  function applyView(id: string | null): void {
    viewsApi.setActiveView(id);
    if (id === null) {
      // Reset to a clean slate.
      filterApi.clear();
      setSortMode('manual');
      if (filterApi.includeBacklog) filterApi.toggleIncludeBacklog();
      return;
    }
    const v = viewsApi.views.find((x) => x.id === id);
    if (!v) return;
    // Reset and re-apply each filter so we don't carry over stale state.
    filterApi.clear();
    if (v.filters.hasAgent) filterApi.toggleHasAgent();
    for (const p of v.filters.priorities) filterApi.togglePriority(p);
    for (const a of v.filters.areas) filterApi.toggleArea(a);
    setSortMode(v.sortMode);
    if (filterApi.includeBacklog !== v.includeBacklog) {
      filterApi.toggleIncludeBacklog();
    }
  }

  function saveCurrentAsView(name: string): void {
    viewsApi.saveView(name, currentViewState);
  }

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <BoardToolbar
        crumbs={
          <>
            {config ? (
              <>
                <span>
                  {config.mode === 'local' ? config.repo : `${config.owner}/${config.repo}`}
                </span>
                <span className="kb-sep">/</span>
              </>
            ) : null}
            <span className="kb-crumb-active">Board</span>
          </>
        }
        onOpenPalette={onOpenPalette}
        onOpenAutopilot={() => setAutopilotLaunchOpen(true)}
        onOpenReadyToGo={() => setReadyToGoOpen(true)}
        readyToGoActive={readyToGoActive}
        onCreate={onOpenCreate}
        // null while the first fetch is in flight so the meter shows its
        // placeholder; once loaded it lights up in the clay accent when
        // any spend has accumulated this calendar day.
        costTodayUsd={costToday === null ? null : costToday.totalUsd}
        {...(onOpenStats ? { onOpenCostMeter: onOpenStats } : {})}
      />
      <BoardFilters
        stats={stats}
        controls={{
          hasAgent: filterApi.filters.hasAgent,
          priorities: filterApi.filters.priorities as ReadonlySet<string>,
          areas: filterApi.filters.areas,
          availablePriorities: filterApi.availablePriorities,
          availableAreas: filterApi.availableAreas,
          includeBacklog: filterApi.includeBacklog,
          backlogCount: issues.filter((i) => i.status === 'backlog').length,
          sortMode,
          onToggleHasAgent: filterApi.toggleHasAgent,
          onTogglePriority: (p) => filterApi.togglePriority(p as (typeof filterApi.availablePriorities)[number]),
          onToggleArea: filterApi.toggleArea,
          onToggleIncludeBacklog: filterApi.toggleIncludeBacklog,
          onChangeSortMode: setSortMode,
          onClear: filterApi.clear,
          views: {
            views: viewsApi.views.map((v) => ({ id: v.id, name: v.name })),
            activeViewId: viewsApi.activeViewId,
            matchedViewId,
            onPickView: applyView,
            onSaveAsView: saveCurrentAsView,
            onManageViews: () => setManageViewsOpen(true),
          },
        }}
      />
      <BoardUsageRow
        fiveHour={costUsage?.fiveHour ?? null}
        sevenDay={costUsage?.sevenDay ?? null}
      />
      <BoardErrorBanner message={moveError} onDismiss={() => setMoveError(null)} />
      <div className="kb-board" onClick={handleBoardBackgroundClick}>
        {COLUMNS.filter((col) => filterApi.includeBacklog || col.key !== 'backlog').map((col) => (
          <Column
            key={String(col.key)}
            columnKey={col.key}
            status={col.status}
            label={col.label}
            issues={col.key === null ? grouped.untagged : grouped.byKey[col.key]}
            selectedNumber={selectedNumber}
            multiSelected={cardSelection.selected}
            liveByRun={liveByRun}
            onSelect={handleCardSelect}
            onOpen={(n) => {
              setSelectedNumber(n);
              onOpenDetail?.(n);
            }}
            {...(col.key === 'backlog'
              ? {
                  onSuggest: openPersonaPicker,
                  suggesting,
                  suggestingActivity: suggestActivity,
                  suggestingStartedAt: suggestStartedAt,
                }
              : {})}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeIssue ? <CardPreview issue={activeIssue} /> : null}
      </DragOverlay>
      {personaPickerOpen ? (
        <PersonaPickerModal
          onClose={() => setPersonaPickerOpen(false)}
          onPick={(persona, provider, notes) => void runSuggestionWith(persona, provider, notes)}
        />
      ) : null}
      {autopilotLaunchOpen ? (
        <AutopilotLaunchModal
          onClose={() => setAutopilotLaunchOpen(false)}
          onStarted={() => dispatchIssuesRefetch()}
        />
      ) : null}
      {readyToGoOpen ? (
        <ReadyToGoModal
          onClose={() => {
            setReadyToGoOpen(false);
            void api.readyToGoStatus().then((s) => setReadyToGoActive(s.running)).catch(() => {});
          }}
        />
      ) : null}
      {cardSelection.selected.size > 0 ? (
        <BulkActionBar
          count={cardSelection.selected.size}
          busy={bulkBusy}
          onMoveToStatus={(s) => void bulkMoveToStatus(s)}
          onAddLabels={(labels) => void bulkAddLabels(labels)}
          onDispatch={() => void bulkDispatch()}
          onArchive={() => void bulkArchive()}
          onClear={() => cardSelection.clear()}
        />
      ) : null}
      {manageViewsOpen ? (
        <BoardViewsModal
          views={viewsApi.views}
          onRename={(id, name) => viewsApi.updateView(id, { name })}
          onDelete={viewsApi.deleteView}
          onReorder={viewsApi.reorderViews}
          onClose={() => setManageViewsOpen(false)}
        />
      ) : null}
    </DndContext>
  );
}
