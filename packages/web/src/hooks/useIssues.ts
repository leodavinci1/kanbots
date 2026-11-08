import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from '../api.js';
import { useFetch, type Mutator } from './useFetch.js';
import type { Issue } from '../types.js';

export interface IssuesContextValue {
  issues: Issue[];
  loading: boolean;
  error: Error | null;
  mutate: Mutator<Issue[]>;
  refetch: () => Promise<void>;
}

const IssuesContext = createContext<IssuesContextValue | null>(null);

export const ISSUES_REFETCH_EVENT = 'kanbots:issues-refetch';
export const ISSUES_CHANGED_CHANNEL = 'issues:changed';

export function IssuesProvider({ children }: { children: ReactNode }) {
  const [refetchTick, setRefetchTick] = useState(0);
  const { data, loading, error, mutate } = useFetch(`issues:open:${refetchTick}`, () =>
    api.issues('open'),
  );

  const refetch = useCallback(async () => {
    setRefetchTick((t) => t + 1);
  }, []);

  // Coalesce bursts of change events so a flurry of label/run updates
  // results in at most one refetch per ~80ms window.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedRefetch = useCallback(() => {
    if (debounceRef.current !== null) return;
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void refetch();
    }, 80);
  }, [refetch]);

  useEffect(() => {
    function onEvent(): void {
      debouncedRefetch();
    }
    window.addEventListener(ISSUES_REFETCH_EVENT, onEvent);
    return () => window.removeEventListener(ISSUES_REFETCH_EVENT, onEvent);
  }, [debouncedRefetch]);

  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.kanbots : undefined;
    if (!bridge) return;
    return bridge.subscribe(ISSUES_CHANGED_CHANNEL, () => {
      debouncedRefetch();
    });
  }, [debouncedRefetch]);

  // External creates (gh / GitHub web) never hit issues:changed. Poll while
  // the window is visible, and refetch on focus, so the board catches up
  // without a manual app restart.
  useEffect(() => {
    const POLL_MS = 15_000;
    function tick(): void {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      debouncedRefetch();
    }
    function onFocus(): void {
      debouncedRefetch();
    }
    const id = window.setInterval(tick, POLL_MS);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [debouncedRefetch]);

  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, []);

  return createElement(
    IssuesContext.Provider,
    { value: { issues: data ?? [], loading, error, mutate, refetch } },
    children,
  );
}

export function useIssues(): IssuesContextValue {
  const v = useContext(IssuesContext);
  if (!v) throw new Error('useIssues must be used inside <IssuesProvider>');
  return v;
}

export function dispatchIssuesRefetch(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(ISSUES_REFETCH_EVENT));
}
