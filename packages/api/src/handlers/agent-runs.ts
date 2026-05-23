import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import type { AgentRun, DiffHunk } from '@kanbots/local-store';
import { z } from 'zod';
import type {
  DiffFile,
  DiffFileStatus,
  DiffPayload,
  ForkRunResult,
  PromoteCommitResult,
  PromotePrResult,
  RunStatsResult,
} from '../bridge.js';
import { stopRunPreview } from './agent-preview.js';
import { badRequest, notFound, parseArgs } from './errors.js';
import type { HandlerDeps } from './types.js';

const execFileAsync = promisify(execFile);

const idSchema = z
  .object({
    runId: z.number().int().positive(),
  })
  .strict();

export interface RunIdArgs {
  runId: number;
}

export async function get(
  deps: HandlerDeps,
  args: RunIdArgs,
): Promise<AgentRun> {
  const parsed = parseArgs(idSchema, args);
  const run = deps.supervisor.getRun(parsed.runId);
  if (!run) throw notFound(`agent run ${parsed.runId} not found`);
  return run;
}

export async function listHunks(
  deps: HandlerDeps,
  args: RunIdArgs,
): Promise<DiffHunk[]> {
  const parsed = parseArgs(idSchema, args);
  return deps.store.diffHunks.listByRun(parsed.runId);
}

export async function stop(
  deps: HandlerDeps,
  args: RunIdArgs,
): Promise<AgentRun> {
  const parsed = parseArgs(idSchema, args);
  return deps.supervisor.stop(parsed.runId);
}

export async function diff(
  deps: HandlerDeps,
  args: RunIdArgs,
): Promise<DiffPayload> {
  const parsed = parseArgs(idSchema, args);
  const run = deps.store.agentRuns.findById(parsed.runId);
  if (!run) throw notFound(`agent run ${parsed.runId} not found`);
  if (!run.worktreePath) throw badRequest('run has no worktree');
  return collectDiff(run.worktreePath, run.branchName);
}

export async function revealWorktree(
  deps: HandlerDeps,
  args: RunIdArgs,
): Promise<{ worktreePath: string }> {
  const parsed = parseArgs(idSchema, args);
  const run = deps.store.agentRuns.findById(parsed.runId);
  if (!run) throw notFound(`agent run ${parsed.runId} not found`);
  if (!run.worktreePath) throw badRequest('run has no worktree');
  if (!deps.revealPath) {
    throw badRequest('reveal is not supported in this environment');
  }
  await deps.revealPath(run.worktreePath);
  return { worktreePath: run.worktreePath };
}

interface StatsCacheEntry {
  expiresAt: number;
  payload: RunStatsResult;
}

const STATS_CACHE_MS = 5_000;
const statsCache = new Map<number, StatsCacheEntry>();

export async function stats(
  deps: HandlerDeps,
  args: RunIdArgs,
): Promise<RunStatsResult> {
  const parsed = parseArgs(idSchema, args);
  const cached = statsCache.get(parsed.runId);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;

  const run = deps.store.agentRuns.findById(parsed.runId);
  if (!run) throw notFound(`agent run ${parsed.runId} not found`);
  if (!run.worktreePath) throw badRequest('run has no worktree');

  const collected = await collectDiff(run.worktreePath, run.branchName);
  let additions = 0;
  let deletions = 0;
  for (const file of collected.files) {
    for (const line of file.patch.split('\n')) {
      if (
        line.startsWith('+++') ||
        line.startsWith('---') ||
        line.startsWith('diff ')
      ) {
        continue;
      }
      if (line.startsWith('+')) additions++;
      else if (line.startsWith('-')) deletions++;
    }
  }
  const payload: RunStatsResult = {
    additions,
    deletions,
    filesChanged: collected.files.length,
  };
  statsCache.set(parsed.runId, {
    expiresAt: Date.now() + STATS_CACHE_MS,
    payload,
  });
  return payload;
}

export async function fork(
  deps: HandlerDeps,
  args: RunIdArgs,
): Promise<ForkRunResult> {
  const parsed = parseArgs(idSchema, args);
  const source = deps.store.agentRuns.findById(parsed.runId);
  if (!source) throw notFound(`run ${parsed.runId} not found`);
  if (!source.worktreePath || !source.branchName) {
    throw badRequest('source run has no worktree to fork from');
  }
  const thread = deps.store.threads.findById(source.threadId);
  if (!thread) throw badRequest('source run has no thread');

  const { stdout: headSha } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: source.worktreePath,
  });
  const sha = headSha.trim();
  const stamp = Date.now().toString(36);
  const newBranch = `${source.branchName}-fork-${stamp}`;
  const newWorktreePath = `${source.worktreePath}-fork-${stamp}`;
  await mkdir(dirname(newWorktreePath), { recursive: true });
  await execFileAsync(
    'git',
    ['worktree', 'add', '-b', newBranch, newWorktreePath, sha],
    { cwd: source.worktreePath },
  );
  const run = await deps.supervisor.start({
    threadId: thread.id,
    issueNumber: thread.issueNumber,
    prompt: `Continue from a fork of run #${parsed.runId} (branch ${source.branchName}).`,
    ...(source.model ? { model: source.model } : {}),
  });
  return { source: parsed.runId, run, worktree: newWorktreePath, branch: newBranch };
}

export async function promoteCommit(
  deps: HandlerDeps,
  args: RunIdArgs,
): Promise<PromoteCommitResult> {
  const parsed = parseArgs(idSchema, args);
  const repoPath = deps.config.repoPath;
  if (!repoPath) throw badRequest('repoPath is not configured');
  const run = deps.store.agentRuns.findById(parsed.runId);
  if (!run) throw notFound(`run ${parsed.runId} not found`);
  if (!run.worktreePath || !run.branchName) {
    throw badRequest('run has no worktree or branch to promote');
  }
  const thread = deps.store.threads.findById(run.threadId);
  if (!thread) throw badRequest('run has no thread');
  const issue = await deps.source.getIssue(thread.issueNumber);

  const base = await detectLocalBase(repoPath);
  await ensureBranchAhead(repoPath, base, run.branchName);

  const message = `Issue #${issue.number}: ${issue.title}`;
  const baseLocation = await locateBaseCheckout(repoPath, base);
  let commitSha: string;
  if (baseLocation && (await isWorktreeClean(baseLocation))) {
    // base is already checked out cleanly somewhere — merge in place so the
    // working tree stays in sync with the moved branch ref.
    try {
      await runGit(['merge', '--squash', run.branchName], baseLocation);
      await runGit(['commit', '-m', message], baseLocation);
      const { stdout } = await runGit(['rev-parse', 'HEAD'], baseLocation);
      commitSha = stdout.trim();
    } catch (err) {
      // Roll back any half-applied merge so the user's checkout doesn't end
      // up with conflict markers or staged-but-uncommitted changes.
      await execFileAsync('git', ['reset', '--hard', 'HEAD'], {
        cwd: baseLocation,
      }).catch(() => undefined);
      throw err;
    }
  } else {
    if (baseLocation) {
      throw badRequest(
        `base branch '${base}' is checked out at ${baseLocation} with uncommitted changes — clean it up before promoting`,
      );
    }
    // base isn't checked out anywhere — use a detached worktree and move the
    // ref ourselves so we don't compete with another checkout.
    const stamp = Date.now().toString(36);
    const tmpPath = `${repoPath}/.kanbots/promote/${parsed.runId}-${stamp}`;
    await mkdir(dirname(tmpPath), { recursive: true });
    await runGit(['worktree', 'add', '--detach', tmpPath, base], repoPath);
    try {
      await runGit(['merge', '--squash', run.branchName], tmpPath);
      await runGit(['commit', '-m', message], tmpPath);
      const { stdout } = await runGit(['rev-parse', 'HEAD'], tmpPath);
      commitSha = stdout.trim();
      await runGit(['update-ref', `refs/heads/${base}`, commitSha], repoPath);
    } finally {
      await execFileAsync(
        'git',
        ['worktree', 'remove', '--force', tmpPath],
        { cwd: repoPath },
      ).catch(() => undefined);
    }
  }

  const cleanup = await cleanupRunArtifacts(deps, run, repoPath);
  // Mark the run as promoted (monotonic upgrade — won't regress earlier
  // signals like `failed`/`stopped` if a user force-promotes a partial run).
  deps.store.agentRuns.upgradeSuccessSignal(run.id, 'promoted');
  // sync-07: best-effort report to cloud so the board surfaces the
  // merge sticker. Only fires when the run originated in a cloud
  // workspace (the IPC layer wires `cloudPromote` only then).
  if (deps.cloudPromote !== undefined) {
    try {
      await deps.cloudPromote({
        localRunId: run.id,
        kind: 'commit',
        commitSha,
        targetBranch: base,
        ...(run.branchName !== null ? { sourceBranch: run.branchName } : {}),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[agent-runs] cloudPromote(commit) failed:', err instanceof Error ? err.message : err);
    }
  }
  return { commitSha, base, cleanup };
}

async function ensureBranchAhead(
  repoPath: string,
  base: string,
  branch: string,
): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      ['rev-list', '--count', `${base}..${branch}`],
      { cwd: repoPath },
    ));
  } catch (err) {
    const e = err as { stderr?: string };
    const detail = (e.stderr ?? '').trim();
    throw badRequest(
      `could not compare '${branch}' against '${base}'${detail ? `: ${detail}` : ''}`,
    );
  }
  if (stdout.trim() === '0') {
    throw badRequest(
      `branch '${branch}' has no commits beyond '${base}' — nothing to merge (already integrated?)`,
    );
  }
}

// Removes worktree+branch artifacts for any run in the thread whose branch
// has zero commits beyond base — i.e. the agent's work is already in main
// (squash-merged, PR-merged, manually integrated, …). Idempotent.
export async function sweepMergedRunsForThread(
  deps: HandlerDeps,
  threadId: number,
): Promise<{ swept: number }> {
  const repoPath = deps.config.repoPath;
  if (!repoPath) return { swept: 0 };
  let base: string;
  try {
    base = await detectLocalBase(repoPath);
  } catch {
    return { swept: 0 };
  }
  const runs = deps.store.agentRuns.listByThread(threadId);
  let swept = 0;
  for (const run of runs) {
    if (!run.branchName || !run.worktreePath) continue;
    let isMerged = false;
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['rev-list', '--count', `${base}..${run.branchName}`],
        { cwd: repoPath },
      );
      isMerged = stdout.trim() === '0';
    } catch {
      // branch missing or unreadable — leave it alone for the user to inspect.
      continue;
    }
    if (!isMerged) continue;
    const result = await cleanupRunArtifacts(deps, run, repoPath);
    if (result.worktreeRemoved || result.branchDeleted) swept += 1;
  }
  return { swept };
}

// Aggressive thread-level cleanup invoked when the user explicitly marks a card
// complete. Always force-removes worktrees so the file system goes back to a
// clean state — but for runs whose branch has unmerged commits, it preserves
// the branch so the agent's work isn't silently destroyed (the user can still
// recover by running `git worktree add`). Branches already merged into base
// are deleted along with the worktree.
export async function sweepAllRunsForThread(
  deps: HandlerDeps,
  threadId: number,
): Promise<{ worktreesRemoved: number; branchesDeleted: number; branchesKept: number }> {
  const repoPath = deps.config.repoPath;
  if (!repoPath) {
    return { worktreesRemoved: 0, branchesDeleted: 0, branchesKept: 0 };
  }
  let base: string | null = null;
  try {
    base = await detectLocalBase(repoPath);
  } catch {
    base = null;
  }
  const runs = deps.store.agentRuns.listByThread(threadId);
  let worktreesRemoved = 0;
  let branchesDeleted = 0;
  let branchesKept = 0;
  for (const run of runs) {
    if (!run.worktreePath) continue;
    let keepBranch = true;
    if (base !== null && run.branchName) {
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['rev-list', '--count', `${base}..${run.branchName}`],
          { cwd: repoPath },
        );
        keepBranch = stdout.trim() !== '0';
      } catch {
        // branch missing or unreadable — preserve it just in case.
        keepBranch = true;
      }
    }
    const result = await cleanupRunArtifacts(deps, run, repoPath, { keepBranch });
    if (result.worktreeRemoved) worktreesRemoved += 1;
    if (result.branchDeleted) branchesDeleted += 1;
    else if (keepBranch && run.branchName) branchesKept += 1;
  }
  return { worktreesRemoved, branchesDeleted, branchesKept };
}

// execFileAsync's default error message is "Command failed: <cmd>", which
// hides git's actual stderr (e.g., "nothing to commit, working tree clean").
// Surface the stderr so the UI shows an actionable message.
export async function runGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('git', args, { cwd });
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    const e = err as Error & { stderr?: string; stdout?: string };
    const detail = ((e.stderr ?? '').trim() || (e.stdout ?? '').trim());
    if (!detail) throw err;
    const wrapped = new Error(`git ${args[0] ?? ''} failed: ${detail}`);
    wrapped.name = e.name;
    throw wrapped;
  }
}

export async function locateBaseCheckout(
  repoPath: string,
  base: string,
): Promise<string | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoPath,
    }));
  } catch {
    return null;
  }
  let currentPath: string | null = null;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length);
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length);
      if (ref === `refs/heads/${base}` && currentPath) return currentPath;
    } else if (line === '' || line === 'detached') {
      currentPath = null;
    }
  }
  return null;
}

export async function isWorktreeClean(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: path });
    return stdout.trim() === '';
  } catch {
    return false;
  }
}

async function cleanupRunArtifacts(
  deps: HandlerDeps,
  run: AgentRun,
  repoPath: string,
  opts: { keepBranch?: boolean } = {},
): Promise<{ worktreeRemoved: boolean; branchDeleted: boolean }> {
  let worktreeRemoved = false;
  let branchDeleted = false;
  if (!run.worktreePath || !run.branchName) {
    return { worktreeRemoved, branchDeleted };
  }
  // Stop any preview server holding the worktree open before we yank it.
  try {
    await stopRunPreview(deps, { runId: run.id });
  } catch {
    // best-effort
  }
  try {
    await execFileAsync(
      'git',
      ['worktree', 'remove', '--force', run.worktreePath],
      { cwd: repoPath },
    );
    worktreeRemoved = true;
  } catch {
    // worktree may already be missing
  }
  if (!opts.keepBranch) {
    try {
      await execFileAsync('git', ['branch', '-D', run.branchName], { cwd: repoPath });
      branchDeleted = true;
    } catch {
      // branch may already be gone
    }
  }
  deps.store.agentRuns.update(run.id, {
    worktreePath: null,
    ...(opts.keepBranch ? {} : { branchName: null }),
  });
  return { worktreeRemoved, branchDeleted };
}

export async function promotePr(
  deps: HandlerDeps,
  args: RunIdArgs,
): Promise<PromotePrResult> {
  const parsed = parseArgs(idSchema, args);
  if (deps.config.mode !== 'github') {
    throw badRequest('PR creation requires github mode');
  }
  const openDraftPR = deps.source.openDraftPR;
  if (typeof openDraftPR !== 'function') {
    throw badRequest('source does not support PR creation');
  }
  const repoPath = deps.config.repoPath;
  if (!repoPath) throw badRequest('repoPath is not configured');
  const run = deps.store.agentRuns.findById(parsed.runId);
  if (!run) throw notFound(`run ${parsed.runId} not found`);
  if (!run.worktreePath || !run.branchName) {
    throw badRequest('run has no worktree or branch to promote');
  }
  const thread = deps.store.threads.findById(run.threadId);
  if (!thread) throw badRequest('run has no thread');
  const issue = await deps.source.getIssue(thread.issueNumber);

  await execFileAsync('git', ['push', '-u', 'origin', run.branchName], {
    cwd: run.worktreePath,
  });

  const base = (await detectLocalBase(repoPath)).replace(/^origin\//, '');
  const pr = await openDraftPR.call(deps.source, {
    title: issue.title,
    ...(issue.body ? { body: issue.body } : {}),
    head: run.branchName,
    base,
    issueNumber: issue.number,
  });
  // PR open is a "promoted" signal too — the user has chosen to land this
  // run via review rather than direct commit. Monotonic upgrade.
  deps.store.agentRuns.upgradeSuccessSignal(run.id, 'promoted');
  // sync-07: report the PR to cloud so the board's "Open PR" sticker
  // and PR number land server-side. Best-effort — if the cloud is
  // unreachable the local promote still wins. The `PullRequest` shape
  // declares the GitHub PR's url as `htmlUrl`; we map onto the
  // cloud's snake-case `pr_url` here so the wire contract stays
  // consistent with the rest of the v1 API.
  if (deps.cloudPromote !== undefined) {
    try {
      await deps.cloudPromote({
        localRunId: run.id,
        kind: 'pr',
        targetBranch: base,
        ...(run.branchName !== null ? { sourceBranch: run.branchName } : {}),
        ...(pr.htmlUrl ? { prUrl: pr.htmlUrl } : {}),
        ...(pr.number ? { prNumber: pr.number } : {}),
        prProvider: 'github',
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[agent-runs] cloudPromote(pr) failed:', err instanceof Error ? err.message : err);
    }
  }
  return { pr };
}

export async function detectLocalBase(repoPath: string): Promise<string> {
  for (const ref of ['main', 'master']) {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', ref], { cwd: repoPath });
      return ref;
    } catch {
      // try next
    }
  }
  throw badRequest('could not find a local main/master branch to promote into');
}

async function collectDiff(
  worktreePath: string,
  branchName: string | null,
): Promise<DiffPayload> {
  const base = await detectBase(worktreePath);
  const tracked = await diffAgainstBase(worktreePath, base);
  const untracked = await listUntrackedFiles(worktreePath);
  const files: DiffFile[] = [];

  for (const f of tracked) files.push(f);
  for (const path of untracked) {
    files.push({
      path,
      status: 'untracked',
      patch: await readUntracked(worktreePath, path),
    });
  }

  return {
    base,
    branch: branchName,
    files,
    empty: files.length === 0,
  };
}

async function detectBase(cwd: string): Promise<string> {
  // Prefer local refs: worktrees are forked from the local branch, and
  // origin/* can be far behind, which would surface unrelated upstream commits
  // as if they were the run's diff.
  for (const ref of ['main', 'master', 'origin/main', 'origin/master']) {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', ref], { cwd });
      return ref;
    } catch {
      // try next
    }
  }
  return 'HEAD';
}

async function diffAgainstBase(cwd: string, base: string): Promise<DiffFile[]> {
  // Unborn HEAD (worktree on a fresh branch with no commits yet): nothing is
  // tracked, so there's no base to diff against. Untracked files are picked
  // up separately by listUntrackedFiles.
  try {
    await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd });
  } catch {
    return [];
  }

  // Diff against the fork point so we only see what this worktree changed —
  // both committed and uncommitted. `base...HEAD` would miss uncommitted work,
  // and a plain `git diff base` would also include commits that landed on
  // base after the fork.
  let forkPoint = base;
  try {
    const { stdout } = await execFileAsync('git', ['merge-base', base, 'HEAD'], {
      cwd,
    });
    const trimmed = stdout.trim();
    if (trimmed) forkPoint = trimmed;
  } catch {
    // no shared ancestor — fall through and let the diff fail open
  }

  const nameStatus = await execFileAsync(
    'git',
    ['diff', '--name-status', forkPoint],
    { cwd, maxBuffer: 16 * 1024 * 1024 },
  ).catch(async () =>
    execFileAsync('git', ['diff', '--name-status', 'HEAD'], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    }),
  );

  const statuses = parseNameStatus(nameStatus.stdout);
  if (statuses.length === 0) return [];

  const patchOut = await execFileAsync('git', ['diff', forkPoint], {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
  }).catch(async () =>
    execFileAsync('git', ['diff', 'HEAD'], { cwd, maxBuffer: 32 * 1024 * 1024 }),
  );

  const patches = splitUnifiedDiff(patchOut.stdout);
  return statuses.map((s) => ({
    path: s.path,
    status: s.status,
    patch: patches.get(s.path) ?? '',
  }));
}

interface NameStatusRow {
  path: string;
  status: DiffFileStatus;
}

function parseNameStatus(stdout: string): NameStatusRow[] {
  const rows: NameStatusRow[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\t/);
    const code = parts[0]?.[0] ?? '';
    const path = parts[parts.length - 1] ?? '';
    if (!path) continue;
    rows.push({ path, status: codeToStatus(code) });
  }
  return rows;
}

function codeToStatus(code: string): DiffFileStatus {
  switch (code) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    default:
      return 'other';
  }
}

function splitUnifiedDiff(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!diff) return out;
  const blocks = diff
    .split(/^(?=diff --git )/m)
    .filter((b) => b.startsWith('diff --git '));
  for (const block of blocks) {
    const headerMatch = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(block);
    const path = headerMatch ? (headerMatch[2] ?? headerMatch[1] ?? null) : null;
    if (path) out.set(path, block);
  }
  return out;
}

async function listUntrackedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '--others', '--exclude-standard'],
      { cwd, maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function readUntracked(cwd: string, path: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--no-index', '/dev/null', path],
      { cwd, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout;
  } catch (err) {
    const e = err as { stdout?: string; code?: number };
    if (typeof e.stdout === 'string') return e.stdout;
    return '';
  }
}
