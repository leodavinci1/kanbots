import { statusFromLabels } from '@kanbots/core';
import type { IssueSource } from '@kanbots/core';
import type { Store } from '@kanbots/local-store';

export const READY_TO_GO_DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const READY_TO_GO_DEFAULT_MAX_CONCURRENT = 3;

export interface ReadyToGoConfig {
  /** How many agents may run in parallel. Default: 3. */
  maxConcurrent: number;
  /** Polling interval in milliseconds. Default: 5 minutes. */
  intervalMs: number;
}

export interface ReadyToGoStatus {
  running: boolean;
  config: ReadyToGoConfig;
  /** ISO timestamp of the last tick, or null if never run. */
  lastTickAt: string | null;
  /** Number of issues dispatched in the last tick. */
  lastDispatchCount: number;
}

export interface ReadyToGoManagerOpts {
  store: Store;
  source: IssueSource;
  /** Called to actually launch an agent for a given issue number. */
  dispatchIssue: (issueNumber: number) => Promise<void>;
  onStatusChange?: (status: ReadyToGoStatus) => void;
}

export interface ReadyToGoManager {
  start(config?: Partial<ReadyToGoConfig>): void;
  stop(): void;
  getStatus(): ReadyToGoStatus;
}

export function createReadyToGoManager(opts: ReadyToGoManagerOpts): ReadyToGoManager {
  const { store, source, dispatchIssue, onStatusChange } = opts;

  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastTickAt: string | null = null;
  let lastDispatchCount = 0;
  let config: ReadyToGoConfig = {
    maxConcurrent: READY_TO_GO_DEFAULT_MAX_CONCURRENT,
    intervalMs: READY_TO_GO_DEFAULT_INTERVAL_MS,
  };

  function getStatus(): ReadyToGoStatus {
    return { running, config, lastTickAt, lastDispatchCount };
  }

  function notify(): void {
    onStatusChange?.(getStatus());
  }

  function scheduleNext(): void {
    if (!running) return;
    timer = setTimeout(() => {
      void tick().then(() => scheduleNext());
    }, config.intervalMs);
  }

  async function tick(): Promise<void> {
    lastTickAt = new Date().toISOString();
    lastDispatchCount = 0;

    try {
      const activeRuns = store.agentRuns.listActive();
      const slots = config.maxConcurrent - activeRuns.length;
      if (slots <= 0) {
        notify();
        return;
      }

      // Find open issues with status:todo, excluding autopilot tasks
      const issues = await source.listIssues({ state: 'open' });
      const todoIssues = issues.filter(
        (issue) =>
          statusFromLabels(issue.labels) === 'todo' &&
          !issue.labels.includes('type:autopilot'),
      );

      if (todoIssues.length === 0) {
        notify();
        return;
      }

      // Skip issues that already have an active run
      const activeIssueNumbers = new Set(activeRuns.map((r) => r.issueNumber));
      const candidates = todoIssues.filter(
        (issue) => !activeIssueNumbers.has(issue.number),
      );

      const toDispatch = candidates.slice(0, slots);
      for (const issue of toDispatch) {
        try {
          await dispatchIssue(issue.number);
          lastDispatchCount++;
        } catch (err) {
          // Already active or other transient error — skip this issue
          console.warn(
            `[ready-to-go] skipped issue #${issue.number}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    } catch (err) {
      console.error('[ready-to-go] tick error:', err);
    }

    notify();
  }

  function start(overrides?: Partial<ReadyToGoConfig>): void {
    if (running) stop();

    config = {
      maxConcurrent: overrides?.maxConcurrent ?? READY_TO_GO_DEFAULT_MAX_CONCURRENT,
      intervalMs: overrides?.intervalMs ?? READY_TO_GO_DEFAULT_INTERVAL_MS,
    };
    running = true;
    notify();

    // Run first tick immediately, then schedule repeating
    void tick().then(() => scheduleNext());
  }

  function stop(): void {
    running = false;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    notify();
  }

  return { start, stop, getStatus };
}
