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
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { AutopilotLaunchModal } from '../components/modals/AutopilotLaunchModal.js';
import { BoardErrorBanner } from '../components/board/BoardErrorBanner.js';
import { BoardFilters } from '../components/board/BoardFilters.js';
import { BoardToolbar } from '../components/board/BoardToolbar.js';
import { BoardUsageRow } from '../components/board/BoardUsageRow.js';
import { CardPreview } from '../components/Card.js';
import { Column, type SuggestActivity } from '../components/Column.js';
import { PersonaPickerModal } from '../components/modals/PersonaPickerModal.js';
import { useBoardAgentStreams } from '../hooks/useBoardAgentStreams.js';
import { useCloudBoardStreams } from '../hooks/useCloudBoardStreams.js';
import { getCloudCtx } from '../api.js';
import { useBoardFilters } from '../hooks/useBoardFilters.js';
import { useFetch } from '../hooks/useFetch.js';
import { useIssues, dispatchIssuesRefetch } from '../hooks/useIssues.js';
import { useSelection } from '../hooks/useSelection.js';
import { COLUMNS, priorityFromLabels, withStatus, type Priority } from '../labels.js';
import type { Persona } from '../personas.js';
import type { Issue, ProviderId, StatusKey } from '../types.js';

type SortMode = 'manual' | 'priority' | 'createdAt' | 'updatedAt';
const SORT_MODES: readonly SortMode[] = ['manual', 'priority', 'createdAt', 'updatedAt'];
const SORT_KEY = 'kanbots:board:sortMode';
const PRIORITY_RANK: Record<Priority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };

function readSortMode(): SortMode {
  if (typeof window === 'undefined') return 'manual';
  try {
    const raw = window.localStorage.getItem(SORT_KEY);
    if (raw !== null && (SORT_MODES as readonly string[]).includes(raw)) return raw as SortMode;
  } catch {
    // ignore
  }
  return 'manual';
}

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
}

export function Board({ onOpenDetail, onOpenCreate, onOpenPalette }: BoardProps = {}) {
  const { data: config } = useFetch('config', () => api.config());
  const { issues, loading, error, mutate } = useIssues();
  const { data: costToday, refetch: refetchCostToday } = useFetch('cost:today', () =>
    api.costToday(),
  );
  const { data: costUsage, refetch: refetchCostUsage } = useFetch('cost:usage', () =>
    api.costUsage(),
  );
  const filterApi = useBoardFilters(issues);
  const [sortMode, setSortMode] = useState<SortMode>(() => readSortMode());
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(SORT_KEY, sortMode);
    } catch {
      // ignore
    }
  }, [sortMode]);

  // Poll the usage meters once a minute. The backend caches OAuth /usage for
  // 60s anyway, so polling faster just thrashes the renderer for no extra
  // freshness. Pause when the tab is hidden so a background window doesn't
  // burn requests.
  useEffect(() => {
    let cancelled = false;
    function tick(): void {
      if (cancelled) return;
      if (typeof document === 'undefined' || !document.hidden) {
        void refetchCostUsage();
        void refetchCostToday();
      }
    }
    const id = window.setInterval(tick, 60_000);
    function onVisibility(): void {
      if (!document.hidden) tick();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(id);
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
  const [selectedNumber, setSelectedNumber] = useSelection();

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
        await api.dispatchIssue(issueNumber, { fromStatus });
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
        onCreate={onOpenCreate}
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
        }}
      />
      <BoardUsageRow
        fiveHour={costUsage?.fiveHour ?? null}
        sevenDay={costUsage?.sevenDay ?? null}
      />
      <BoardErrorBanner message={moveError} onDismiss={() => setMoveError(null)} />
      <div className="kb-board">
        {COLUMNS.filter((col) => filterApi.includeBacklog || col.key !== 'backlog').map((col) => (
          <Column
            key={String(col.key)}
            columnKey={col.key}
            status={col.status}
            label={col.label}
            issues={col.key === null ? grouped.untagged : grouped.byKey[col.key]}
            selectedNumber={selectedNumber}
            liveByRun={liveByRun}
            onSelect={setSelectedNumber}
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
    </DndContext>
  );
}
