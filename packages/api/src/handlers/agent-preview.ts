import { startPreview, type PreviewHandle } from '@kanbots/dispatcher';
import { readWorkspaceConfig } from '@kanbots/local-store';
import { z } from 'zod';
import type { PreviewStatePayload } from '../bridge.js';
import { badRequest, notFound, parseArgs } from './errors.js';
import type { HandlerDeps } from './types.js';

const idSchema = z
  .object({
    runId: z.number().int().positive(),
  })
  .strict();

export interface PreviewArgs {
  runId: number;
}

export interface StartPreviewImplOptions {
  cwd: string;
  startCommandLine?: string;
}

export type StartPreviewImpl = (opts: StartPreviewImplOptions) => Promise<PreviewHandle>;

const handles = new Map<number, PreviewHandle>();

export async function getPreview(
  deps: HandlerDeps,
  args: PreviewArgs,
): Promise<PreviewStatePayload> {
  const parsed = parseArgs(idSchema, args);
  const run = deps.store.agentRuns.findById(parsed.runId);
  if (!run) throw notFound(`agent run ${parsed.runId} not found`);
  return {
    url: run.previewUrl,
    state: run.previewState ?? 'idle',
    pid: run.previewPid,
  };
}

export interface StartPreviewDeps extends HandlerDeps {
  startPreviewImpl?: StartPreviewImpl;
}

export async function startRunPreview(
  deps: StartPreviewDeps,
  args: PreviewArgs,
): Promise<PreviewStatePayload> {
  const parsed = parseArgs(idSchema, args);
  const run = deps.store.agentRuns.findById(parsed.runId);
  if (!run) throw notFound(`agent run ${parsed.runId} not found`);
  if (!run.worktreePath) throw badRequest('run has no worktree');

  const existing = handles.get(parsed.runId);
  if (existing) {
    return { url: existing.url, state: existing.state, pid: existing.pid };
  }

  const startImpl: StartPreviewImpl =
    deps.startPreviewImpl ?? ((opts) => startPreview(opts));

  // Per-repo dev-server override, set via Settings → Repos. Falls back to
  // dispatcher's default `pnpm dev` if the user hasn't configured one.
  let startCommandLine: string | undefined;
  if (deps.config.repoPath) {
    try {
      const cfg = await readWorkspaceConfig(deps.config.repoPath);
      startCommandLine = cfg?.scripts?.devServer;
    } catch {
      // ignore — fall back to dispatcher default.
    }
  }

  deps.store.agentRuns.update(parsed.runId, { previewState: 'booting' });
  try {
    const handle = await startImpl({
      cwd: run.worktreePath,
      ...(startCommandLine !== undefined ? { startCommandLine } : {}),
    });
    handles.set(parsed.runId, handle);
    deps.store.agentRuns.update(parsed.runId, {
      previewUrl: handle.url,
      previewState: handle.state,
      previewPid: handle.pid,
    });
    return { url: handle.url, state: handle.state, pid: handle.pid };
  } catch (err) {
    deps.store.agentRuns.update(parsed.runId, {
      previewState: 'crashed',
      previewUrl: null,
      previewPid: null,
    });
    throw err;
  }
}

export async function stopRunPreview(
  deps: HandlerDeps,
  args: PreviewArgs,
): Promise<PreviewStatePayload> {
  const parsed = parseArgs(idSchema, args);
  const handle = handles.get(parsed.runId);
  if (handle) await handle.stop();
  handles.delete(parsed.runId);
  deps.store.agentRuns.update(parsed.runId, {
    previewState: 'stopped',
    previewPid: null,
  });
  return { url: null, state: 'stopped', pid: null };
}
