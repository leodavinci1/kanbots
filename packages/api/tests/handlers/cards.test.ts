import { describe, expect, it } from 'vitest';
import { issueFixture } from '../helpers/fixtures.js';
import { makeHandlerTestKit } from '../helpers/make-handlers.js';

describe('cards:resolve', () => {
  it('resolves the card and returns the run', async () => {
    const { handlers, source, store } = makeHandlerTestKit();
    source.setIssue(issueFixture(1, 'decision task'));
    const t = store.threads.create({ repoOwner: 'octo', repoName: 'hello', issueNumber: 1 });
    const run = store.agentRuns.create({ threadId: t.id });
    store.agentRuns.update(run.id, { status: 'awaiting_input' });
    const msg = store.messages.create({
      threadId: t.id,
      role: 'agent',
      body: 'pick one',
      agentRunId: run.id,
    });
    const card = store.cards.create({
      messageId: msg.id,
      type: 'decision',
      payload: { question: 'q', options: [{ value: 'a', label: 'A' }] },
    });

    const result = await handlers['cards:resolve']({ cardId: card.id, value: 'a' });
    expect(result.card.status).toBe('resolved');
    expect(result.run.id).toBe(run.id);
  });

  it('throws NotFound for a missing card', async () => {
    const { handlers } = makeHandlerTestKit();
    await expect(handlers['cards:resolve']({ cardId: 9999, value: 'x' })).rejects.toThrow();
  });
});
