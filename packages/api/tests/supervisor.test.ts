import type {
  AgentRunHandle,
  CreateWorktreeInput,
  RunSummary,
  StartAgentRunOptions,
  Worktree,
} from '@kanbots/dispatcher';
import { openStoreInMemory, type Store } from '@kanbots/local-store';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSupervisor } from '../src/agent-runs/supervisor.js';

interface FakeHandle extends AgentRunHandle {
  emitClose(opts?: { exitCode?: number; killedByStop?: boolean }): void;
}

function makeFakeHandle(pid = 1234): FakeHandle {
  const emitter = new EventEmitter();
  let resolveDone: (summary: RunSummary) => void = () => undefined;
  const done = new Promise<RunSummary>((resolve) => {
    resolveDone = resolve;
  });
  const handle = {
    pid,
    done,
    on: (ev: string, fn: (...args: unknown[]) => void): FakeHandle => {
      emitter.on(ev, fn);
      return handle as unknown as FakeHandle;
    },
    off: (ev: string, fn: (...args: unknown[]) => void): FakeHandle => {
      emitter.off(ev, fn);
      return handle as unknown as FakeHandle;
    },
    stop: (): void => undefined,
    emitClose: (opts?: { exitCode?: number; killedByStop?: boolean }): void => {
      const summary: RunSummary = {
        exitCode: opts?.exitCode ?? 0,
        killedByStop: opts?.killedByStop ?? false,
        stopEscalation: null,
        stderr: '',
        result: null,
      };
      emitter.emit('close', summary);
      resolveDone(summary);
    },
  };
  return handle as unknown as FakeHandle;
}

async function buildSupervisorWithFakes(store: Store): Promise<{
  supervisor: Awaited<ReturnType<typeof createSupervisor>>;
  startCalls: StartAgentRunOptions[];
  worktreeCalls: CreateWorktreeInput[];
  handle: FakeHandle;
}> {
  const startCalls: StartAgentRunOptions[] = [];
  const worktreeCalls: CreateWorktreeInput[] = [];
  const handle = makeFakeHandle();
  const supervisor = await createSupervisor({
    store,
    repoPath: '/tmp/repo',
    prepareWorktreeDir: async () => undefined,
    createWorktree: async (input: CreateWorktreeInput): Promise<Worktree> => {
      worktreeCalls.push(input);
      return { branch: input.branch, path: input.worktreePath, baseRef: null };
    },
    stampWorktreeIdentity: async () => ({
      userName: 'test',
      userEmail: 'test@example.com',
      hookInstalled: false,
      hookSkippedReason: 'test stub',
    }),
    startAgentRun: (opts: StartAgentRunOptions): AgentRunHandle => {
      startCalls.push(opts);
      return handle;
    },
  });
  return { supervisor, startCalls, worktreeCalls, handle };
}

describe('createSupervisor', () => {
  let store: Store;
  let threadId: number;

  beforeEach(() => {
    store = openStoreInMemory();
    threadId = store.threads.create({ repoOwner: 'a', repoName: 'b', issueNumber: 1 }).id;
  });

  afterEach(() => {
    store.close();
  });

  it('sweeps stale starting/running rows on construction', async () => {
    const stale1 = store.agentRuns.create({ threadId });
    const stale2 = store.agentRuns.create({ threadId });
    store.agentRuns.update(stale1.id, { status: 'starting' });
    store.agentRuns.update(stale2.id, { status: 'running', pid: 9999 });
    const waiting = store.agentRuns.create({ threadId });
    store.agentRuns.update(waiting.id, { status: 'awaiting_input' });

    await createSupervisor({
      store,
      repoPath: '/tmp',
      reapOverrides: {
        // Pretend pid 9999 is dead so we don't actually try to signal anything.
        kill: () => {
          const err = new Error('no such process');
          (err as NodeJS.ErrnoException).code = 'ESRCH';
          throw err;
        },
        readComm: () => null,
        sleep: async () => {},
        graceMs: 0,
      },
    });

    expect(store.agentRuns.findById(stale1.id)?.status).toBe('failed');
    expect(store.agentRuns.findById(stale2.id)?.status).toBe('failed');
    expect(store.agentRuns.findById(stale2.id)?.pid).toBeNull();
    // stale1 had no pid → generic restart reason; stale2 had pid 9999 →
    // per-row "pid not running" reason after the reaper failed liveness.
    expect(store.agentRuns.findById(stale1.id)?.exitReason).toMatch(/restart/);
    expect(store.agentRuns.findById(stale2.id)?.exitReason).toMatch(/9999 not running/);
    // awaiting_input is left alone.
    expect(store.agentRuns.findById(waiting.id)?.status).toBe('awaiting_input');
  });
});

describe('supervisor.stop', () => {
  let store: Store;
  let threadId: number;

  beforeEach(() => {
    store = openStoreInMemory();
    threadId = store.threads.create({ repoOwner: 'a', repoName: 'b', issueNumber: 1 }).id;
  });

  afterEach(() => {
    store.close();
  });

  it('marks an active-in-DB-but-untracked run as stopped', async () => {
    const supervisor = await createSupervisor({ store, repoPath: '/tmp' });

    const ghost = store.agentRuns.create({ threadId });
    store.agentRuns.update(ghost.id, { status: 'awaiting_input' });

    const result = await supervisor.stop(ghost.id);
    expect(result.status).toBe('stopped');
    expect(result.endedAt).toBeTruthy();
    expect(store.agentRuns.findById(ghost.id)?.status).toBe('stopped');
  });

  it('returns terminal runs unchanged', async () => {
    const supervisor = await createSupervisor({ store, repoPath: '/tmp' });

    const done = store.agentRuns.create({ threadId });
    store.agentRuns.update(done.id, { status: 'complete', endedAt: '2026-01-01T00:00:00Z' });

    const result = await supervisor.stop(done.id);
    expect(result.status).toBe('complete');
    expect(result.endedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('throws when the run is missing', async () => {
    const supervisor = await createSupervisor({ store, repoPath: '/tmp' });
    await expect(supervisor.stop(99999)).rejects.toThrow(/not found/);
  });
});

describe('supervisor.start one-run-per-thread guard', () => {
  let store: Store;
  let threadId: number;

  beforeEach(() => {
    store = openStoreInMemory();
    threadId = store.threads.create({ repoOwner: 'a', repoName: 'b', issueNumber: 7 }).id;
  });

  afterEach(() => {
    store.close();
  });

  it('rejects a second concurrent start on the same thread with AlreadyActive', async () => {
    const { supervisor, startCalls, worktreeCalls } = await buildSupervisorWithFakes(store);

    const first = await supervisor.start({ threadId, issueNumber: 7, prompt: 'hi' });
    expect(first.status).toBe('running');

    const before = store.agentRuns.listByThread(threadId).length;
    let caught: Error | null = null;
    try {
      await supervisor.start({ threadId, issueNumber: 7, prompt: 'again' });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.name).toBe('AlreadyActive');
    expect((caught as unknown as { run: { id: number } }).run.id).toBe(first.id);

    // No new row created, no extra worktree, no extra spawn.
    expect(store.agentRuns.listByThread(threadId).length).toBe(before);
    expect(startCalls.length).toBe(1);
    expect(worktreeCalls.length).toBe(1);
  });

  it('rejects a start when the DB has an awaiting_input run on the thread', async () => {
    const supervisor = await createSupervisor({ store, repoPath: '/tmp' });
    const ghost = store.agentRuns.create({ threadId });
    store.agentRuns.update(ghost.id, { status: 'awaiting_input' });

    let caught: Error | null = null;
    try {
      await supervisor.start({ threadId, issueNumber: 7, prompt: 'hi' });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.name).toBe('AlreadyActive');
    expect((caught as unknown as { run: { id: number } }).run.id).toBe(ghost.id);
    expect(store.agentRuns.listByThread(threadId).length).toBe(1);
  });

  it('allows a fresh start once the prior run terminates', async () => {
    const { supervisor, handle } = await buildSupervisorWithFakes(store);
    const first = await supervisor.start({ threadId, issueNumber: 7, prompt: 'a' });
    handle.emitClose({ exitCode: 0 });
    await handle.done;

    expect(store.agentRuns.findById(first.id)?.status).toBe('complete');

    // Replace handle for the second run by building a fresh fake supervisor.
    const second = await buildSupervisorWithFakes(store);
    const next = await second.supervisor.start({ threadId, issueNumber: 7, prompt: 'b' });
    expect(next.status).toBe('running');
    expect(next.id).not.toBe(first.id);
  });

  it('resume rejects when a different active run exists on the same thread', async () => {
    const { supervisor, handle } = await buildSupervisorWithFakes(store);
    const live = await supervisor.start({ threadId, issueNumber: 7, prompt: 'a' });

    // Create an inactive prior run that *could* be resumed.
    const prior = store.agentRuns.create({ threadId });
    store.agentRuns.update(prior.id, {
      status: 'failed',
      sessionId: 'sess-x',
      worktreePath: '/tmp/w',
      endedAt: new Date().toISOString(),
    });

    let caught: Error | null = null;
    try {
      await supervisor.resume({ runId: prior.id, prompt: 'continue' });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.name).toBe('AlreadyActive');
    expect((caught as unknown as { run: { id: number } }).run.id).toBe(live.id);

    handle.emitClose({ exitCode: 0 });
    await handle.done;
  });
});
