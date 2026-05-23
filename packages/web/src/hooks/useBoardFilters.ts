import { useEffect, useMemo, useState } from 'react';
import { areaLabels, priorityFromLabels, type Priority } from '../labels.js';
import type { Issue } from '../types.js';

export interface BoardFilters {
  hasAgent: boolean;
  priorities: ReadonlySet<Priority>;
  areas: ReadonlySet<string>;
}

const EMPTY_FILTERS: BoardFilters = {
  hasAgent: false,
  priorities: new Set(),
  areas: new Set(),
};

const INCLUDE_BACKLOG_KEY = 'kanbots:board:includeBacklog';

function readIncludeBacklog(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(INCLUDE_BACKLOG_KEY) === '1';
  } catch {
    return false;
  }
}

export interface BoardFilterAPI {
  filters: BoardFilters;
  filtered: Issue[];
  /**
   * Backlog is hidden by default to keep the board focused on active work.
   * Toggle to show it; preference is persisted to localStorage.
   */
  includeBacklog: boolean;
  toggleIncludeBacklog: () => void;
  toggleHasAgent: () => void;
  togglePriority: (p: Priority) => void;
  toggleArea: (a: string) => void;
  clear: () => void;
  availablePriorities: Priority[];
  availableAreas: string[];
}

const PRIORITY_ORDER: Priority[] = ['p0', 'p1', 'p2', 'p3'];

export function useBoardFilters(issues: Issue[]): BoardFilterAPI {
  const [filters, setFilters] = useState<BoardFilters>(EMPTY_FILTERS);
  const [includeBacklog, setIncludeBacklog] = useState<boolean>(() => readIncludeBacklog());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(INCLUDE_BACKLOG_KEY, includeBacklog ? '1' : '0');
    } catch {
      // ignore — private mode / quota.
    }
  }, [includeBacklog]);

  const availablePriorities = useMemo<Priority[]>(() => {
    const seen = new Set<Priority>();
    for (const i of issues) {
      const p = priorityFromLabels(i.labels);
      if (p) seen.add(p);
    }
    return PRIORITY_ORDER.filter((p) => seen.has(p));
  }, [issues]);

  const availableAreas = useMemo<string[]>(() => {
    const counts = new Map<string, number>();
    for (const i of issues) {
      for (const l of areaLabels(i.labels)) {
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
  }, [issues]);

  const filtered = useMemo<Issue[]>(() => {
    return issues.filter((i) => {
      if (!includeBacklog && i.status === 'backlog') return false;
      if (filters.hasAgent && (i.agent === null || i.agent === 'idle')) return false;
      if (filters.priorities.size > 0) {
        const p = priorityFromLabels(i.labels);
        if (!p || !filters.priorities.has(p)) return false;
      }
      if (filters.areas.size > 0) {
        const areas = areaLabels(i.labels);
        const matches = areas.some((a) => filters.areas.has(a));
        if (!matches) return false;
      }
      return true;
    });
  }, [issues, filters, includeBacklog]);

  function toggleHasAgent(): void {
    setFilters((f) => ({ ...f, hasAgent: !f.hasAgent }));
  }
  function togglePriority(p: Priority): void {
    setFilters((f) => {
      const next = new Set(f.priorities);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return { ...f, priorities: next };
    });
  }
  function toggleArea(a: string): void {
    setFilters((f) => {
      const next = new Set(f.areas);
      if (next.has(a)) next.delete(a);
      else next.add(a);
      return { ...f, areas: next };
    });
  }
  function clear(): void {
    setFilters(EMPTY_FILTERS);
  }
  function toggleIncludeBacklog(): void {
    setIncludeBacklog((v) => !v);
  }

  return {
    filters,
    filtered,
    includeBacklog,
    toggleIncludeBacklog,
    toggleHasAgent,
    togglePriority,
    toggleArea,
    clear,
    availablePriorities,
    availableAreas,
  };
}
