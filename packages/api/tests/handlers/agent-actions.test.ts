import { describe, expect, it } from 'vitest';
import { issueFixture } from '../helpers/fixtures.js';
import { makeHandlerTestKit } from '../helpers/make-handlers.js';

describe('issues:archive', () => {
  it('replaces status/agent labels with `archived` and returns a decorated issue', async () => {
    const { handlers, source } = makeHandlerTestKit();
    source.setIssue(issueFixture(7, 'lucky', { labels: ['status:todo', 'agent:idle'] }));
    const result = await handlers['issues:archive']({ number: 7 });
    expect(result.labels).toContain('archived');
    expect(result.labels).not.toContain('status:todo');
    expect(result.state).toBe('closed');
    expect(result).toHaveProperty('activeRun');
  });
});

describe('issues:approve', () => {
  it('marks the issue done and closed', async () => {
    const { handlers, source } = makeHandlerTestKit();
    source.setIssue(issueFixture(7, 'lucky', { labels: ['status:review'] }));
    const result = await handlers['issues:approve']({ number: 7 });
    expect(result.labels).toContain('status:done');
    expect(result.state).toBe('closed');
  });
});

describe('issues:request-changes', () => {
  it('moves the issue back to in-progress with agent:blocked', async () => {
    const { handlers, source } = makeHandlerTestKit();
    source.setIssue(issueFixture(7, 'lucky', { labels: ['status:review'] }));
    const result = await handlers['issues:request-changes']({ number: 7 });
    expect(result.labels).toContain('status:in-progress');
    expect(result.labels).toContain('agent:blocked');
  });
});

describe('issues:split', () => {
  it('creates child issues and returns decorated children', async () => {
    const { handlers, source } = makeHandlerTestKit();
    source.setIssue(issueFixture(7, 'parent'));
    const result = await handlers['issues:split']({
      number: 7,
      subtasks: [{ title: 'a' }, { title: 'b' }],
    });
    expect(result.parent).toBe(7);
    expect(result.children).toHaveLength(2);
    expect(result.children[0]?.labels).toContain('parent:7');
  });

  it('rejects empty subtasks via validation', async () => {
    const { handlers, source } = makeHandlerTestKit();
    source.setIssue(issueFixture(7, 'parent'));
    await expect(
      handlers['issues:split']({ number: 7, subtasks: [] }),
    ).rejects.toMatchObject({ name: 'ValidationError' });
  });
});

describe('issues:reviewer', () => {
  it('throws BadRequest when no thread exists for the issue', async () => {
    const { handlers, source } = makeHandlerTestKit();
    source.setIssue(issueFixture(7, 'lucky'));
    await expect(
      handlers['issues:reviewer']({ number: 7 }),
    ).rejects.toMatchObject({ name: 'BadRequest' });
  });

  it('starts a reviewer worktree from the last implement branch with commits', async () => {
    const { handlers, store, source, supervisor } = makeHandlerTestKit();
    source.setIssue(issueFixture(7, 'lucky'));
    const t = store.threads.create({
      repoOwner: 'octo',
      repoName: 'hello',
      issueNumber: 7,
    });
    store.agentRuns.create({
      threadId: t.id,
      status: 'complete',
      branchName: 'kanbots/issue-7-3',
      worktreePath: '/tmp/fake-wt',
    });
    // Stub git rev-list via findImplementBaseRef — without a real repo the
    // helper returns null; assert start is still called (reviewer must not throw).
    const run = await handlers['issues:reviewer']({ number: 7, threadId: t.id });
    expect(run.status).toBe('running');
    const startCall = supervisor.calls.find((c) => c.type === 'start');
    expect(startCall).toBeTruthy();
    expect((startCall?.args as { appendSystemPrompt?: string }).appendSystemPrompt).toContain(
      'code reviewer',
    );
  });
});


describe('issues:start-agent', () => {
  it('starts via the supervisor', async () => {
    const { handlers, store, supervisor } = makeHandlerTestKit();
    const t = store.threads.create({ repoOwner: 'octo', repoName: 'hello', issueNumber: 7 });
    const result = await handlers['issues:start-agent']({
      number: 7,
      threadId: t.id,
      prompt: 'do the thing',
    });
    expect(result.status).toBe('running');
    expect(supervisor.calls.some((c) => c.type === 'start')).toBe(true);
  });
});
