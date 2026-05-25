import { describe, expect, it } from 'vitest';
import { makeHandlerTestKit } from '../helpers/make-handlers.js';

describe('agent-runs:events:subscribe', () => {
  it('delegates to the subscription registry for an existing run', async () => {
    const { handlers, registry, store } = makeHandlerTestKit();
    const t = store.threads.create({ repoOwner: 'octo', repoName: 'hello', issueNumber: 1 });
    const run = store.agentRuns.create({ threadId: t.id });
    registry.next = { subscriptionId: 'sub-1', runStatus: 'running' };
    const result = await handlers['agent-runs:events:subscribe']({ runId: run.id });
    expect(result.subscriptionId).toBe('sub-1');
    expect(registry.calls).toContainEqual({
      kind: 'register',
      args: { runId: run.id },
    });
  });

  it('accepts chat-scoped subscriptions for desktop routing', async () => {
    const { handlers, registry, store } = makeHandlerTestKit();
    const t = store.threads.create({ repoOwner: 'octo', repoName: 'hello', issueNumber: 1 });
    const run = store.agentRuns.create({ threadId: t.id });
    registry.next = { subscriptionId: 'sub-chat', runStatus: 'running' };

    const result = await handlers['agent-runs:events:subscribe']({
      runId: run.id,
      scope: 'chat',
    });

    expect(result.subscriptionId).toBe('sub-chat');
    expect(registry.calls).toContainEqual({
      kind: 'register',
      args: { runId: run.id },
    });
  });

  it('throws NotFound when the run does not exist', async () => {
    const { handlers } = makeHandlerTestKit();
    await expect(handlers['agent-runs:events:subscribe']({ runId: 9999 })).rejects.toMatchObject({
      name: 'NotFound',
    });
  });
});

describe('agent-runs:events:unsubscribe', () => {
  it('delegates to the registry', async () => {
    const { handlers, registry } = makeHandlerTestKit();
    await handlers['agent-runs:events:unsubscribe']({ subscriptionId: 'sub-x' });
    expect(registry.calls).toContainEqual({
      kind: 'unregister',
      args: { subscriptionId: 'sub-x' },
    });
  });
});
