import { exec } from 'node:child_process';
import { z } from 'zod';
import {
  HOUSE_RULES_MAX_BYTES,
  readWorkspaceConfig,
  WORKSPACE_SCRIPT_MAX_BYTES,
  writeWorkspaceConfig,
  type WorkspaceConfig,
  type WorkspaceScriptKind,
  type WorkspaceScripts,
} from '@kanbots/local-store';
import type {
  Workspace,
  WorkspaceBudgets,
  WorkspaceFolderPayload,
  WorkspaceHouseRules,
} from '../bridge.js';
import { bootstrapWorkspace } from '../workspace-bootstrap.js';
import { badRequest, parseArgs } from './errors.js';
import type { HandlerDeps } from './types.js';

const SCRIPT_KIND_SET: readonly WorkspaceScriptKind[] = ['devServer', 'setup', 'cleanup'];
const RUN_SCRIPT_TIMEOUT_MS = 5 * 60 * 1000;
const RUN_SCRIPT_OUTPUT_CAP = 64 * 1024;

const addFolderSchema = z
  .object({
    name: z.string().min(1).max(120),
    path: z.string().min(1).max(2048),
    defaultBranch: z.string().min(1).max(120).optional(),
  })
  .strict();

export interface AddFolderArgs {
  name: string;
  path: string;
  defaultBranch?: string;
}

export async function getWorkspace(deps: HandlerDeps): Promise<Workspace> {
  if (!deps.config.repoPath) {
    return { id: 'default', name: 'kanbots workspace', currentFolderId: 'unknown' };
  }
  const { workspace, currentFolder } = bootstrapWorkspace(
    deps.store,
    deps.config,
    deps.config.repoPath,
  );
  return {
    id: workspace.id,
    name: workspace.name,
    currentFolderId: currentFolder.id,
  };
}

export async function listFolders(
  deps: HandlerDeps,
): Promise<WorkspaceFolderPayload[]> {
  if (!deps.config.repoPath) return [];
  const { workspace, currentFolder } = bootstrapWorkspace(
    deps.store,
    deps.config,
    deps.config.repoPath,
  );
  const rows = deps.store.folders.listByWorkspace(workspace.id);
  return rows.map((f) => ({
    id: f.id,
    workspaceId: f.workspaceId,
    name: f.name,
    path: f.path,
    defaultBranch: f.defaultBranch,
    addedAt: f.addedAt,
    current: f.id === currentFolder.id,
  }));
}

const setBudgetsSchema = z
  .object({
    runCostBudgetUsd: z.number().positive().nullable(),
    sessionCostBudgetUsd: z.number().positive().nullable(),
  })
  .strict();

export async function getBudgets(deps: HandlerDeps): Promise<WorkspaceBudgets> {
  if (!deps.budgets) {
    return { runCostBudgetUsd: null, sessionCostBudgetUsd: null };
  }
  return deps.budgets.get();
}

export async function setBudgets(
  deps: HandlerDeps,
  args: WorkspaceBudgets,
): Promise<WorkspaceBudgets> {
  const parsed = parseArgs(setBudgetsSchema, args);
  if (!deps.budgets) {
    throw badRequest('host has no active workspace');
  }
  await deps.budgets.set(parsed);
  return deps.budgets.get();
}

const setHouseRulesSchema = z
  .object({
    houseRules: z.string().nullable(),
  })
  .strict();

export async function getHouseRules(deps: HandlerDeps): Promise<WorkspaceHouseRules> {
  if (!deps.houseRules) return { houseRules: null };
  return deps.houseRules.get();
}

export async function setHouseRules(
  deps: HandlerDeps,
  args: WorkspaceHouseRules,
): Promise<WorkspaceHouseRules> {
  const parsed = parseArgs(setHouseRulesSchema, args);
  if (!deps.houseRules) throw badRequest('host has no active workspace');
  let next: string | null;
  if (parsed.houseRules === null) {
    next = null;
  } else {
    const trimmed = parsed.houseRules.trim();
    if (trimmed.length === 0) {
      next = null;
    } else if (Buffer.byteLength(trimmed, 'utf8') > HOUSE_RULES_MAX_BYTES) {
      throw badRequest(`houseRules exceeds ${HOUSE_RULES_MAX_BYTES} bytes`);
    } else {
      next = trimmed;
    }
  }
  await deps.houseRules.set({ houseRules: next });
  return deps.houseRules.get();
}

const setScriptsSchema = z
  .object({
    devServer: z.string().nullable().optional(),
    setup: z.string().nullable().optional(),
    cleanup: z.string().nullable().optional(),
  })
  .strict();

export interface WorkspaceScriptsPayload {
  scripts: WorkspaceScripts;
}

export async function getScripts(deps: HandlerDeps): Promise<WorkspaceScriptsPayload> {
  if (!deps.config.repoPath) return { scripts: {} };
  try {
    const cfg = await readWorkspaceConfig(deps.config.repoPath);
    return { scripts: cfg?.scripts ?? {} };
  } catch {
    return { scripts: {} };
  }
}

export async function setScripts(
  deps: HandlerDeps,
  args: { devServer?: string | null; setup?: string | null; cleanup?: string | null },
): Promise<WorkspaceScriptsPayload> {
  const parsed = parseArgs(setScriptsSchema, args);
  if (!deps.config.repoPath) throw badRequest('host has no active workspace');

  const next: WorkspaceScripts = {};
  for (const kind of SCRIPT_KIND_SET) {
    const v = parsed[kind];
    if (v === undefined) continue;
    if (v === null) continue; // null → unset
    const trimmed = v.trim();
    if (trimmed.length === 0) continue;
    if (Buffer.byteLength(trimmed, 'utf8') > WORKSPACE_SCRIPT_MAX_BYTES) {
      throw badRequest(`script "${kind}" exceeds ${WORKSPACE_SCRIPT_MAX_BYTES} bytes`);
    }
    next[kind] = trimmed;
  }

  // Merge into existing config so we don't overwrite other workspace fields.
  // If config.json doesn't exist yet we can't safely write — workspace
  // bootstrap is the source of truth for the mode/owner/name fields.
  const existing = await readWorkspaceConfig(deps.config.repoPath);
  if (!existing) throw badRequest('workspace config has not been initialised yet');

  // Merge into the existing config, preserving the discriminated-union
  // mode. Only include the scripts key when at least one script is set —
  // otherwise we'd violate `exactOptionalPropertyTypes`.
  const hasScripts = Object.keys(next).length > 0;
  const merged: WorkspaceConfig =
    existing.mode === 'github'
      ? hasScripts
        ? { ...existing, scripts: next }
        : (() => {
            const { scripts: _omit, ...rest } = existing;
            return rest;
          })()
      : hasScripts
        ? { ...existing, scripts: next }
        : (() => {
            const { scripts: _omit, ...rest } = existing;
            return rest;
          })();

  await writeWorkspaceConfig(deps.config.repoPath, merged);
  return { scripts: hasScripts ? next : {} };
}

const runScriptSchema = z
  .object({
    kind: z.enum(['setup', 'cleanup']),
  })
  .strict();

export interface RunScriptResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: string;
}

export async function runScript(
  deps: HandlerDeps,
  args: { kind: 'setup' | 'cleanup' },
): Promise<RunScriptResult> {
  const parsed = parseArgs(runScriptSchema, args);
  if (!deps.config.repoPath) throw badRequest('host has no active workspace');
  const cfg = await readWorkspaceConfig(deps.config.repoPath);
  const script = cfg?.scripts?.[parsed.kind];
  if (!script) {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      error: `no ${parsed.kind} script is configured`,
    };
  }
  return await new Promise<RunScriptResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const child = exec(
      script,
      {
        cwd: deps.config.repoPath,
        timeout: RUN_SCRIPT_TIMEOUT_MS,
        maxBuffer: RUN_SCRIPT_OUTPUT_CAP * 2,
        env: { ...process.env },
      },
      (err) => {
        if (err && (err as unknown as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
          resolve({
            ok: false,
            exitCode: null,
            stdout,
            stderr,
            stdoutTruncated,
            stderrTruncated,
            error: `script timed out after ${Math.round(RUN_SCRIPT_TIMEOUT_MS / 1000)}s`,
          });
          return;
        }
        const exitCode = child.exitCode ?? (err ? 1 : 0);
        resolve({
          ok: exitCode === 0,
          exitCode,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          ...(err && exitCode !== 0 ? { error: err.message } : {}),
        });
      },
    );
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (stdout.length + text.length > RUN_SCRIPT_OUTPUT_CAP) {
        stdout = (stdout + text).slice(0, RUN_SCRIPT_OUTPUT_CAP);
        stdoutTruncated = true;
      } else {
        stdout += text;
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (stderr.length + text.length > RUN_SCRIPT_OUTPUT_CAP) {
        stderr = (stderr + text).slice(0, RUN_SCRIPT_OUTPUT_CAP);
        stderrTruncated = true;
      } else {
        stderr += text;
      }
    });
  });
}

export async function addFolder(
  deps: HandlerDeps,
  args: AddFolderArgs,
): Promise<WorkspaceFolderPayload> {
  const parsed = parseArgs(addFolderSchema, args);
  if (!deps.config.repoPath) {
    throw badRequest('host has no active workspace');
  }
  const { workspace } = bootstrapWorkspace(
    deps.store,
    deps.config,
    deps.config.repoPath,
  );
  const id = `manual-${Date.now()}`;
  const folder = deps.store.folders.ensure({
    id,
    workspaceId: workspace.id,
    name: parsed.name,
    path: parsed.path,
    ...(parsed.defaultBranch !== undefined
      ? { defaultBranch: parsed.defaultBranch }
      : {}),
  });
  return {
    id: folder.id,
    workspaceId: folder.workspaceId,
    name: folder.name,
    path: folder.path,
    defaultBranch: folder.defaultBranch,
    addedAt: folder.addedAt,
    current: false,
  };
}
