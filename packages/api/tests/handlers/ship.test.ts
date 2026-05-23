import { describe, expect, it, vi } from 'vitest';
import { issueFixture } from '../helpers/fixtures.js';
import { makeHandlerTestKit } from '../helpers/make-handlers.js';

describe('ship:status', () => {
  it('throws BadRequest when repoPath is not configured', async () => {
    const { handlers, source } = makeHandlerTestKit();
    source.setIssue(issueFixture(7, 'card'));
    await expect(
      handlers['ship:status']({ issueNumber: 7 }),
    ).rejects.toMatchObject({ name: 'BadRequest' });
  });

  it('throws NotFound when no thread exists for the issue', async () => {
    const { handlers, source } = makeHandlerTestKit({ repoPath: '/tmp/no-repo' });
    source.setIssue(issueFixture(7, 'card'));
    await expect(
      handlers['ship:status']({ issueNumber: 7 }),
    ).rejects.toMatchObject({ name: 'NotFound' });
  });

  it('throws NotFound when thread has no agent runs', async () => {
    const { handlers, store, source } = makeHandlerTestKit({
      repoPath: '/tmp/no-repo',
    });
    source.setIssue(issueFixture(7, 'card'));
    store.threads.create({
      repoOwner: 'octo',
      repoName: 'hello',
      issueNumber: 7,
    });
    await expect(
      handlers['ship:status']({ issueNumber: 7 }),
    ).rejects.toMatchObject({ name: 'NotFound' });
  });
});

describe('ship:merge validation', () => {
  it('rejects empty targetBranch via zod', async () => {
    const { handlers, source } = makeHandlerTestKit({ repoPath: '/tmp/no-repo' });
    source.setIssue(issueFixture(7, 'card'));
    await expect(
      handlers['ship:merge']({ issueNumber: 7, targetBranch: '' }),
    ).rejects.toMatchObject({ name: 'ValidationError' });
  });
});

describe('ship:create-pr', () => {
  it('throws BadRequest when source does not implement openDraftPR', async () => {
    const { handlers, store, source } = makeHandlerTestKit({
      repoPath: '/tmp/no-repo',
    });
    source.setIssue(issueFixture(7, 'card'));
    const thread = store.threads.create({
      repoOwner: 'octo',
      repoName: 'hello',
      issueNumber: 7,
    });
    store.agentRuns.create({
      threadId: thread.id,
      worktreePath: '/tmp/wt',
      branchName: 'kanbots/issue-7',
    });
    // FakeIssueSource has no openDraftPR — exactly the local-only case.
    await expect(
      handlers['ship:create-pr']({ issueNumber: 7 }),
    ).rejects.toMatchObject({ name: 'BadRequest' });
  });

  it('calls openDraftPR with run branch as head and issue context', async () => {
    const { handlers, store, source } = makeHandlerTestKit({
      repoPath: '/tmp/no-repo',
    });
    source.setIssue(
      issueFixture(7, 'card', { body: 'Task body lives here.' }),
    );
    const openDraftPR = vi.fn().mockResolvedValue({
      number: 42,
      title: 'card (#7)',
      body: 'Task body lives here.',
      state: 'open',
      draft: true,
      htmlUrl: 'https://github.com/octo/hello/pull/42',
      head: 'kanbots/issue-7',
      base: 'main',
    });
    // Inject the PR creator onto the fake source. The IssueSource
    // interface declares openDraftPR as optional; FakeIssueSource omits
    // it by default, so adding it at test time mirrors the real
    // GitHub-only behavior.
    (source as unknown as { openDraftPR: typeof openDraftPR }).openDraftPR =
      openDraftPR;

    const thread = store.threads.create({
      repoOwner: 'octo',
      repoName: 'hello',
      issueNumber: 7,
    });
    store.agentRuns.create({
      threadId: thread.id,
      worktreePath: '/tmp/wt',
      branchName: 'kanbots/issue-7',
    });

    const result = await handlers['ship:create-pr']({
      issueNumber: 7,
      targetBranch: 'develop',
    });
    expect(openDraftPR).toHaveBeenCalledWith(
      expect.objectContaining({
        head: 'kanbots/issue-7',
        base: 'develop',
        issueNumber: 7,
        draft: true,
      }),
    );
    expect(result.pr.htmlUrl).toBe('https://github.com/octo/hello/pull/42');
  });
});
