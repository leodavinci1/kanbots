/**
 * Ship handlers: takes a card's agent run (worktree + branch) and either
 * merges it into a local target branch, or opens a GitHub PR against one.
 *
 * Wired to the UI's [Ship…] panel on review-column cards. Replaces the
 * misleading "Approve & merge" button, which used to only change labels.
 *
 * Local merge strategy: `git checkout <target> && git merge --no-ff <branch>`
 * inside whichever worktree already has the target checked out (so we don't
 * fight a second checkout of the same branch elsewhere). On conflict we
 * roll back and surface the conflict to the user — no auto-resolution.
 *
 * PR creation uses `IssueSource.openDraftPR`, which only GitHub backends
 * implement. Non-GitHub sources surface a clear error.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { PullRequest } from '@kanbots/core';
import {
  detectLocalBase,
  isWorktreeClean,
  locateBaseCheckout,
  runGit,
} from './agent-runs.js';
import type { HandlerDeps } from './types.js';
import { badRequest, notFound, parseArgs } from './errors.js';

const execFileAsync = promisify(execFile);

export interface ShipStatus {
  /** Internal agent_runs id. Null if no run on this issue's thread. */
  runId: number | null;
  /** Branch name the agent committed to (e.g., `kanbots/issue-12-xyz`). */
  branchName: string | null;
  /** Absolute path to the agent's worktree, if it still exists on disk. */
  worktreePath: string | null;
  /** True if `git status --porcelain` returned anything inside the worktree. */
  hasUncommittedChanges: boolean;
  /** Commits ahead of the configured default merge target. */
  commitsAheadOfDefault: number;
  /** Branch name we'll default to in the picker (usually `main`/`master`). */
  defaultMergeTarget: string;
  /** All local branches the user could merge into (excludes the run's own). */
  availableTargets: string[];
}

export interface ShipMergeResult {
  merged: true;
  targetBranch: string;
  mergeCommitSha: string;
  /** Where the merge landed on disk so the UI can offer "reveal in finder". */
  baseCheckoutPath: string;
}

export interface ShipPRResult {
  pr: PullRequest;
}

export interface ShipCommitResult {
  commitSha: string;
}

const numberSchema = z.object({ issueNumber: z.number().int().positive() });
const commitSchema = z.object({
  issueNumber: z.number().int().positive(),
  message: z.string().min(1).optional(),
});
const mergeSchema = z.object({
  issueNumber: z.number().int().positive(),
  targetBranch: z.string().min(1),
});
const prSchema = z.object({
  issueNumber: z.number().int().positive(),
  targetBranch: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  draft: z.boolean().optional(),
});

async function resolveRun(
  deps: HandlerDeps,
  issueNumber: number,
): Promise<{
  run: {
    id: number;
    branchName: string | null;
    worktreePath: string | null;
    threadId: number;
  };
  repoPath: string;
}> {
  const repoPath = deps.config.repoPath;
  if (!repoPath) throw badRequest('repoPath is not configured');
  const thread = deps.store.threads.findByIssue(
    deps.config.owner,
    deps.config.repo,
    issueNumber,
  );
  if (!thread) throw notFound(`no thread for issue #${issueNumber}`);
  const active = deps.store.agentRuns.findActiveForThread(thread.id);
  const run = active ?? deps.store.agentRuns.findLatestForThread(thread.id);
  if (!run) throw notFound(`no agent runs for issue #${issueNumber}`);
  return { run, repoPath };
}

async function listLocalBranches(repoPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
    { cwd: repoPath },
  );
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function commitsAhead(
  repoPath: string,
  base: string,
  branch: string,
): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-list', '--count', `${base}..${branch}`],
      { cwd: repoPath },
    );
    return Number.parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

export async function status(
  deps: HandlerDeps,
  args: unknown,
): Promise<ShipStatus> {
  const parsed = parseArgs(numberSchema, args);
  const { run, repoPath } = await resolveRun(deps, parsed.issueNumber);

  const branches = await listLocalBranches(repoPath);
  const defaultMergeTarget = await detectLocalBase(repoPath).catch(() => 'main');
  const availableTargets = branches.filter((b) => b !== run.branchName);

  let hasUncommittedChanges = false;
  if (run.worktreePath !== null) {
    try {
      hasUncommittedChanges = !(await isWorktreeClean(run.worktreePath));
    } catch {
      // Worktree missing or unreadable — treat as clean so the UI doesn't
      // block on a non-existent commit step.
      hasUncommittedChanges = false;
    }
  }

  const commitsAheadOfDefault = run.branchName
    ? await commitsAhead(repoPath, defaultMergeTarget, run.branchName)
    : 0;

  return {
    runId: run.id,
    branchName: run.branchName,
    worktreePath: run.worktreePath,
    hasUncommittedChanges,
    commitsAheadOfDefault,
    defaultMergeTarget,
    availableTargets,
  };
}

export async function commit(
  deps: HandlerDeps,
  args: unknown,
): Promise<ShipCommitResult> {
  const parsed = parseArgs(commitSchema, args);
  const { run } = await resolveRun(deps, parsed.issueNumber);
  if (run.worktreePath === null) {
    throw badRequest(`run #${run.id} has no worktree on disk`);
  }
  if (await isWorktreeClean(run.worktreePath)) {
    throw badRequest('nothing to commit — worktree is clean');
  }
  const issue = await deps.source.getIssue(parsed.issueNumber);
  const fallbackMessage = `${issue.title} (#${issue.number})`;
  const message = parsed.message ?? fallbackMessage;

  await runGit(['add', '-A'], run.worktreePath);
  await runGit(['commit', '-m', message], run.worktreePath);
  const { stdout } = await runGit(['rev-parse', 'HEAD'], run.worktreePath);
  return { commitSha: stdout.trim() };
}

export async function merge(
  deps: HandlerDeps,
  args: unknown,
): Promise<ShipMergeResult> {
  const parsed = parseArgs(mergeSchema, args);
  const { run, repoPath } = await resolveRun(deps, parsed.issueNumber);
  if (run.branchName === null) {
    throw badRequest(`run #${run.id} has no branch to merge`);
  }

  // Refuse to merge if the worktree has uncommitted changes — the UI is
  // expected to call `ship:commit` first if the user opts in. Surfacing
  // here as a stable error lets the UI present a "Commit pending changes?"
  // prompt without race conditions.
  if (run.worktreePath !== null && !(await isWorktreeClean(run.worktreePath))) {
    throw badRequest(
      'worktree has uncommitted changes — commit or discard them first',
    );
  }

  const baseLocation = await locateBaseCheckout(repoPath, parsed.targetBranch);
  if (baseLocation === null) {
    throw badRequest(
      `target branch '${parsed.targetBranch}' is not checked out anywhere — switch to it in a worktree before shipping`,
    );
  }
  if (!(await isWorktreeClean(baseLocation))) {
    throw badRequest(
      `target branch '${parsed.targetBranch}' is checked out at ${baseLocation} but has uncommitted changes — clean it up before shipping`,
    );
  }

  const issue = await deps.source.getIssue(parsed.issueNumber);
  const mergeMessage = `Merge #${issue.number}: ${issue.title}`;
  let commitSha: string;
  try {
    await runGit(
      ['merge', '--no-ff', '-m', mergeMessage, run.branchName],
      baseLocation,
    );
    const { stdout } = await runGit(['rev-parse', 'HEAD'], baseLocation);
    commitSha = stdout.trim();
  } catch (err) {
    // Roll back any half-applied merge so the user's checkout doesn't end
    // up with conflict markers or staged-but-uncommitted changes.
    await execFileAsync('git', ['merge', '--abort'], {
      cwd: baseLocation,
    }).catch(() => undefined);
    throw err;
  }

  return {
    merged: true,
    targetBranch: parsed.targetBranch,
    mergeCommitSha: commitSha,
    baseCheckoutPath: baseLocation,
  };
}

export async function createPR(
  deps: HandlerDeps,
  args: unknown,
): Promise<ShipPRResult> {
  const parsed = parseArgs(prSchema, args);
  if (deps.source.openDraftPR === undefined) {
    throw badRequest(
      'PR creation is only supported on GitHub-backed workspaces',
    );
  }
  const { run } = await resolveRun(deps, parsed.issueNumber);
  if (run.branchName === null) {
    throw badRequest(`run #${run.id} has no branch to open a PR from`);
  }

  const issue = await deps.source.getIssue(parsed.issueNumber);
  const pr = await deps.source.openDraftPR({
    title: parsed.title ?? `${issue.title} (#${issue.number})`,
    body: parsed.body ?? issue.body ?? '',
    head: run.branchName,
    ...(parsed.targetBranch !== undefined ? { base: parsed.targetBranch } : {}),
    draft: parsed.draft ?? true,
    issueNumber: issue.number,
  });
  return { pr };
}
