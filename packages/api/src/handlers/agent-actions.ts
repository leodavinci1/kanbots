import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Issue } from '@kanbots/core';
import type { AgentRun, Store } from '@kanbots/local-store';
import { z } from 'zod';
import type { DecoratedIssue, SplitResult } from '../bridge.js';
import { buildActiveRunMap, decorateIssue } from './issues.js';
import { badRequest, parseArgs } from './errors.js';
import type { HandlerDeps } from './types.js';

const execFileAsync = promisify(execFile);

const REVIEWER_SYSTEM_PROMPT = `You are a code reviewer for a kanbots task.

Your job is to read the diff already in this worktree and produce a focused review.

1. Run \`git diff main...HEAD\` (or \`git diff master...HEAD\`) to read the changes
   this branch introduces versus the base. Do not treat an empty working tree as
   "nothing to review" if that three-dot diff is non-empty.
2. Read the linked issue body (the user's prompt has it).
3. Identify: bugs, missed edge cases, places where the change diverges from the
   issue's acceptance criteria, opportunities to simplify.
4. Emit your review as a single text response. Do NOT modify code. Do NOT
   commit. Do NOT spawn checks.
5. End your turn after the review.`;

const PROVIDER_ENUM = z.enum([
  'claude-code',
  'codex-cli',
  'gemini-cli',
  'amp-cli',
  'cursor-cli',
  'copilot-cli',
  'opencode-cli',
  'droid-cli',
  'ccr-cli',
  'qwen-cli',
  'acp',
]);

const startAgentSchema = z
  .object({
    number: z.number().int().positive(),
    threadId: z.number().int().positive(),
    prompt: z.string().min(1).max(20_000),
    appendSystemPrompt: z.string().max(20_000).optional(),
    model: z.string().min(1).max(120).optional(),
    provider: PROVIDER_ENUM.optional(),
    repoId: z.number().int().positive().optional(),
  })
  .strict();

const issueNumberSchema = z
  .object({
    number: z.number().int().positive(),
  })
  .strict();

const splitSchema = z
  .object({
    number: z.number().int().positive(),
    subtasks: z
      .array(
        z
          .object({
            title: z.string().min(1).max(200),
            body: z.string().max(20_000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    dispatch: z.boolean().optional(),
    repoId: z.number().int().positive().optional(),
  })
  .strict();

const reviewerSchema = z
  .object({
    number: z.number().int().positive(),
    threadId: z.number().int().positive().optional(),
    prompt: z.string().min(1).max(20_000).optional(),
    model: z.string().min(1).max(120).optional(),
    repoId: z.number().int().positive().optional(),
  })
  .strict();

export interface StartAgentArgs {
  number: number;
  threadId: number;
  prompt: string;
  appendSystemPrompt?: string;
  model?: string;
  provider?:
    | 'claude-code'
    | 'codex-cli'
    | 'gemini-cli'
    | 'amp-cli'
    | 'cursor-cli'
    | 'copilot-cli'
    | 'opencode-cli'
    | 'droid-cli'
    | 'ccr-cli'
    | 'qwen-cli'
    | 'acp';
  repoId?: number;
}

export interface NumberArgs {
  number: number;
}

export interface SplitArgs {
  number: number;
  subtasks: Array<{ title: string; body?: string }>;
  dispatch?: boolean;
  repoId?: number;
}

export interface ReviewerArgs {
  number: number;
  threadId?: number;
  prompt?: string;
  model?: string;
  repoId?: number;
}

export async function startAgent(
  deps: HandlerDeps,
  args: StartAgentArgs,
): Promise<AgentRun> {
  const parsed = parseArgs(startAgentSchema, args);
  return deps.supervisor.start({
    threadId: parsed.threadId,
    issueNumber: parsed.number,
    prompt: parsed.prompt,
    ...(parsed.appendSystemPrompt !== undefined
      ? { appendSystemPrompt: parsed.appendSystemPrompt }
      : {}),
    ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    ...(parsed.provider !== undefined ? { provider: parsed.provider } : {}),
    ...(parsed.repoId !== undefined ? { repoId: parsed.repoId } : {}),
  });
}

export async function archive(
  deps: HandlerDeps,
  args: NumberArgs,
): Promise<DecoratedIssue> {
  const parsed = parseArgs(issueNumberSchema, args);
  const issue = await deps.source.getIssue(parsed.number);

  // If this is an autopilot parent, stop its session so the orchestrator loop
  // exits cleanly before we close the issue. Children are left as-is — the
  // user can archive them individually if desired.
  if (issue.labels.includes('type:autopilot')) {
    const session = deps.autopilot.getSessionByIssue(parsed.number);
    if (session && session.status === 'running') {
      await deps.autopilot.stop(session.id, { stopChildren: false });
    }
  }

  const thread = findThreadForIssue(deps.store, parsed.number);
  if (thread) {
    const runs = deps.store.agentRuns
      .listByThread(thread.id)
      .filter(
        (r) =>
          r.status === 'starting' ||
          r.status === 'running' ||
          r.status === 'awaiting_input',
      );
    for (const run of runs) {
      await deps.supervisor.stop(run.id);
    }
  }
  const labels = issue.labels.filter(
    (l) =>
      !l.startsWith('status:') && !l.startsWith('agent:') && l !== 'archived',
  );
  labels.push('archived');
  const updated = await deps.source.updateIssue(parsed.number, {
    labels,
    state: 'closed',
  });
  return decorateIssue(updated);
}

export async function unarchive(
  deps: HandlerDeps,
  args: NumberArgs,
): Promise<DecoratedIssue> {
  const parsed = parseArgs(issueNumberSchema, args);
  const issue = await deps.source.getIssue(parsed.number);
  // Drop the 'archived' marker, keep all other labels, and restore a sensible
  // status so the card appears on the board instead of falling into Inbox.
  const stripped = issue.labels.filter(
    (l) => l !== 'archived' && !l.startsWith('status:'),
  );
  const labels = [...stripped, 'status:backlog'];
  const updated = await deps.source.updateIssue(parsed.number, {
    labels,
    state: 'open',
  });
  return decorateIssue(updated);
}

export async function approve(
  deps: HandlerDeps,
  args: NumberArgs,
): Promise<DecoratedIssue> {
  const parsed = parseArgs(issueNumberSchema, args);
  const issue = await deps.source.getIssue(parsed.number);
  const labels = issue.labels.filter(
    (l) => !l.startsWith('status:') && !l.startsWith('agent:'),
  );
  labels.push('status:done', 'agent:idle');
  const updated = await deps.source.updateIssue(parsed.number, {
    labels,
    state: 'closed',
  });
  return decorateIssue(updated);
}

export async function requestChanges(
  deps: HandlerDeps,
  args: NumberArgs,
): Promise<DecoratedIssue> {
  const parsed = parseArgs(issueNumberSchema, args);
  const issue = await deps.source.getIssue(parsed.number);
  const labels = issue.labels.filter(
    (l) => !l.startsWith('status:') && !l.startsWith('agent:'),
  );
  labels.push('status:in-progress', 'agent:blocked');
  const updated = await deps.source.updateIssue(parsed.number, { labels });
  return decorateIssue(updated);
}

export async function split(
  deps: HandlerDeps,
  args: SplitArgs,
): Promise<SplitResult> {
  const parsed = parseArgs(splitSchema, args);
  const parent = await deps.source.getIssue(parsed.number);
  const labels = (parent.labels ?? []).filter(
    (l) => !l.startsWith('status:') && !l.startsWith('agent:'),
  );
  const created: Issue[] = [];
  for (const sub of parsed.subtasks) {
    const child = await deps.source.createIssue({
      title: sub.title,
      ...(sub.body !== undefined ? { body: sub.body } : {}),
      labels: [...labels, 'status:backlog', `parent:${parsed.number}`],
    });
    created.push(child);
    if (parsed.dispatch) {
      const thread = ensureThread(deps.store, child.number);
      deps.store.messages.create({
        threadId: thread.id,
        role: 'user',
        body: sub.body ?? sub.title,
      });
      try {
        await deps.supervisor.start({
          threadId: thread.id,
          issueNumber: child.number,
          prompt: sub.body ?? sub.title,
          ...(parsed.repoId !== undefined ? { repoId: parsed.repoId } : {}),
        });
      } catch {
        // Surfaced via run rows; child issue still created.
      }
    }
  }
  const activeRunMap = buildActiveRunMap(deps);
  const decoratedChildren = created.map((c) =>
    decorateIssue(c, activeRunMap.get(c.number) ?? null),
  );
  return { parent: parsed.number, children: decoratedChildren };
}

export async function reviewer(
  deps: HandlerDeps,
  args: ReviewerArgs,
): Promise<AgentRun> {
  const parsed = parseArgs(reviewerSchema, args);
  const issue = await deps.source.getIssue(parsed.number);
  let threadId = parsed.threadId;
  if (threadId === undefined) {
    const existingThread = findThreadForIssue(deps.store, parsed.number);
    if (existingThread) {
      threadId = existingThread.id;
    } else {
      throw badRequest(
        'no thread for this issue yet — send a message first or pass threadId explicitly',
      );
    }
  }
  const repoPath = resolveReviewRepoPath(deps, parsed.repoId);
  const baseRef =
    repoPath !== null
      ? await findImplementBaseRef(deps.store, threadId, repoPath)
      : null;
  const reviewerPrompt =
    parsed.prompt ??
    `Review the implementation against the issue:\n\n${issue.title}\n\n${issue.body ?? ''}${
      baseRef
        ? `\n\nThis reviewer worktree was branched from \`${baseRef}\` (the last implement run with commits ahead of main). Review that diff — do not conclude "no changes" from an empty working tree alone.`
        : ''
    }`;
  return deps.supervisor.start({
    threadId,
    issueNumber: parsed.number,
    prompt: reviewerPrompt,
    appendSystemPrompt: REVIEWER_SYSTEM_PROMPT,
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.repoId !== undefined ? { repoId: parsed.repoId } : {}),
    ...(baseRef !== null ? { baseRef } : {}),
  });
}

function resolveReviewRepoPath(
  deps: HandlerDeps,
  repoId: number | undefined,
): string | null {
  if (repoId !== undefined) {
    const row = deps.store.workspaceRepos.findById(repoId);
    if (row) return row.repoPath;
  }
  return deps.config.repoPath ?? null;
}

/**
 * Prefer the newest thread run whose branch still has commits ahead of
 * main/master. Reviewer used to `git worktree add` from HEAD (main), so
 * Diff + the reviewer always saw an empty tree after a good implement.
 */
export async function findImplementBaseRef(
  store: Store,
  threadId: number,
  repoPath: string,
): Promise<string | null> {
  const runs = [...store.agentRuns.listByThread(threadId)].sort(
    (a, b) => b.id - a.id,
  );
  for (const run of runs) {
    if (!run.branchName) continue;
    if (
      run.status === 'starting' ||
      run.status === 'running' ||
      run.status === 'awaiting_input'
    ) {
      continue;
    }
    const count = await countCommitsAheadOfMain(repoPath, run);
    if (count > 0) return run.branchName;
  }
  return null;
}

async function countCommitsAheadOfMain(
  repoPath: string,
  run: AgentRun,
): Promise<number> {
  const bases = ['main', 'master', 'origin/main', 'origin/master'] as const;
  for (const base of bases) {
    if (run.branchName) {
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['rev-list', '--count', `${base}..${run.branchName}`],
          { cwd: repoPath },
        );
        const n = Number.parseInt(stdout.trim(), 10);
        if (Number.isFinite(n) && n > 0) return n;
        if (n === 0) return 0;
      } catch {
        // try next base / worktree
      }
    }
    if (run.worktreePath) {
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['rev-list', '--count', `${base}..HEAD`],
          { cwd: run.worktreePath },
        );
        const n = Number.parseInt(stdout.trim(), 10);
        if (Number.isFinite(n) && n > 0) return n;
        if (n === 0) return 0;
      } catch {
        // try next
      }
    }
  }
  return 0;
}

function findThreadForIssue(
  store: Store,
  issueNumber: number,
): { id: number; issueNumber: number } | null {
  const all = store.threads.list();
  return all.find((t) => t.issueNumber === issueNumber) ?? null;
}

function ensureThread(store: Store, issueNumber: number): { id: number } {
  const existing = findThreadForIssue(store, issueNumber);
  if (existing) return { id: existing.id };
  return store.threads.create({
    repoOwner: 'local',
    repoName: 'split',
    issueNumber,
  });
}
