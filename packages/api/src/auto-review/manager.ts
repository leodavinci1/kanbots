/**
 * AutoReview manager.
 *
 * Pipeline for each eligible issue in status:review:
 *   1. Start a reviewer agent (reads diff, produces review text).
 *   2. Wait for the reviewer to finish.
 *   3. Post the review as a message and dispatch a fix agent.
 *   4. Wait for the fix agent to finish.
 *   5. Mark the issue agent:auto-reviewed so it isn't picked up again.
 */
import { statusFromLabels, withAgentLabel } from '@kanbots/core';
import type { IssueSource } from '@kanbots/core';
import type { AgentRunStatus, Store } from '@kanbots/local-store';
import type { AgentSupervisor } from '../agent-runs/supervisor.js';

const AUTO_REVIEWED_LABEL = 'agent:auto-reviewed' as const;

// Terminal statuses for an agent run
const TERMINAL: ReadonlySet<AgentRunStatus> = new Set([
  'complete',
  'failed',
  'stopped',
  'awaiting_input',
]);

export const AUTO_REVIEW_DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
export const AUTO_REVIEW_DEFAULT_MAX_CONCURRENT = 2;

export interface AutoReviewConfig {
  maxConcurrent: number;
  intervalMs: number;
}

export interface AutoReviewStatus {
  running: boolean;
  config: AutoReviewConfig;
  lastTickAt: string | null;
  lastReviewedCount: number;
  /** Issues currently going through the pipeline (issue numbers). */
  activeIssues: number[];
}

export interface AutoReviewManagerOpts {
  store: Store;
  source: IssueSource;
  supervisor: AgentSupervisor;
  /**
   * Starts a reviewer agent for the given issue. Returns the agent run ID.
   * Equivalent to clicking "Review code" in the UI.
   */
  startReviewer: (issueNumber: number, threadId: number) => Promise<number>;
  /**
   * Posts a message (the review) to the thread and dispatches a fix agent.
   * Returns the agent run ID.
   */
  dispatchFix: (issueNumber: number, reviewText: string) => Promise<number>;
  onStatusChange?: (status: AutoReviewStatus) => void;
}

export interface AutoReviewManager {
  start(config?: Partial<AutoReviewConfig>): void;
  stop(): void;
  getStatus(): AutoReviewStatus;
}

export function createAutoReviewManager(opts: AutoReviewManagerOpts): AutoReviewManager {
  const { store, source, supervisor, startReviewer, dispatchFix, onStatusChange } = opts;

  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastTickAt: string | null = null;
  let lastReviewedCount = 0;
  const activeIssues = new Set<number>();
  let config: AutoReviewConfig = {
    maxConcurrent: AUTO_REVIEW_DEFAULT_MAX_CONCURRENT,
    intervalMs: AUTO_REVIEW_DEFAULT_INTERVAL_MS,
  };

  function getStatus(): AutoReviewStatus {
    return {
      running,
      config,
      lastTickAt,
      lastReviewedCount,
      activeIssues: [...activeIssues],
    };
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

  /** Wait for an agent run to reach a terminal status. */
  function waitForRun(runId: number): Promise<AgentRunStatus> {
    return new Promise((resolve) => {
      const initial = supervisor.getRun(runId);
      if (initial && TERMINAL.has(initial.status)) {
        resolve(initial.status);
        return;
      }
      const unsub = supervisor.subscribe(
        runId,
        () => {},
        (status) => {
          if (TERMINAL.has(status)) {
            unsub();
            resolve(status);
          }
        },
      );
    });
  }

  /** Get the last agent message text from a thread. */
  function getLastReviewText(threadId: number): string | null {
    const messages = store.messages.list(threadId);
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg !== undefined && msg.role === 'agent' && msg.body.trim().length > 0) {
        return msg.body;
      }
    }
    return null;
  }

  /** Get or create thread for an issue. */
  function getOrCreateThread(issueNumber: number): number {
    const all = store.threads.list();
    const existing = all.find((t) => t.issueNumber === issueNumber);
    if (existing) return existing.id;
    const thread = store.threads.getOrCreate({
      repoOwner: 'local',
      repoName: 'autoreview',
      issueNumber,
    });
    return thread.id;
  }

  /** Run the full review+fix pipeline for one issue. */
  async function reviewIssue(issueNumber: number): Promise<void> {
    activeIssues.add(issueNumber);
    notify();

    try {
      const threadId = getOrCreateThread(issueNumber);

      // Step 1: start reviewer agent
      const reviewRunId = await startReviewer(issueNumber, threadId);

      // Step 2: wait for reviewer to finish
      const reviewStatus = await waitForRun(reviewRunId);
      if (reviewStatus !== 'complete') {
        console.warn(`[auto-review] reviewer for #${issueNumber} ended with ${reviewStatus}, skipping fix`);
        return;
      }

      // Step 3: read the review text
      const reviewText = getLastReviewText(threadId);
      if (!reviewText) {
        console.warn(`[auto-review] no review text found for #${issueNumber}, skipping fix`);
        return;
      }

      // Step 4: dispatch fix agent with review as context
      const fixRunId = await dispatchFix(issueNumber, reviewText);

      // Step 5: wait for fix agent to finish
      const fixStatus = await waitForRun(fixRunId);
      if (fixStatus !== 'complete') {
        console.warn(`[auto-review] fix agent for #${issueNumber} ended with ${fixStatus}`);
        // Still mark as auto-reviewed to avoid re-running indefinitely on broken issues
      }

      // Step 6: mark issue as auto-reviewed
      const issue = await source.getIssue(issueNumber);
      const newLabels = withAgentLabel([...issue.labels], 'autoReviewed');
      await source.updateIssue(issueNumber, { labels: newLabels });

      lastReviewedCount++;
    } finally {
      activeIssues.delete(issueNumber);
      notify();
    }
  }

  async function tick(): Promise<void> {
    lastTickAt = new Date().toISOString();
    lastReviewedCount = 0;
    notify();

    try {
      const issues = await source.listIssues({ state: 'open' });
      const eligible = issues.filter(
        (issue) =>
          statusFromLabels(issue.labels) === 'review' &&
          !issue.labels.includes(AUTO_REVIEWED_LABEL) &&
          !issue.labels.includes('type:autopilot') &&
          !activeIssues.has(issue.number),
      );

      const slots = config.maxConcurrent - activeIssues.size;
      const toReview = eligible.slice(0, slots);

      // Fire pipelines concurrently (don't await — each runs in background)
      for (const issue of toReview) {
        void reviewIssue(issue.number).catch((err) => {
          console.error(`[auto-review] pipeline failed for #${issue.number}:`, err);
          activeIssues.delete(issue.number);
          notify();
        });
      }
    } catch (err) {
      console.error('[auto-review] tick error:', err);
    }

    notify();
  }

  function start(overrides?: Partial<AutoReviewConfig>): void {
    if (running) stop();
    config = {
      maxConcurrent: overrides?.maxConcurrent ?? AUTO_REVIEW_DEFAULT_MAX_CONCURRENT,
      intervalMs: overrides?.intervalMs ?? AUTO_REVIEW_DEFAULT_INTERVAL_MS,
    };
    running = true;
    notify();
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
