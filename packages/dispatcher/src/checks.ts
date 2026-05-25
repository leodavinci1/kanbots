import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createCliEnvironment } from './cli-env.js';

export type CheckKind = 'typecheck' | 'tests' | 'lint' | 'e2e';
export type CheckStatus = 'idle' | 'running' | 'pass' | 'fail';

export interface CheckCommand {
  kind: CheckKind;
  command: string;
  args: string[];
}

export interface CheckResult {
  kind: CheckKind;
  status: 'pass' | 'fail';
  durationMs: number;
  summary: string;
}

export interface RunCheckOptions {
  cwd: string;
  command: CheckCommand;
  timeoutMs?: number;
  spawn?: (
    command: string,
    args: readonly string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv },
  ) => ChildProcess;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export function defaultCheckCommand(kind: CheckKind): CheckCommand {
  switch (kind) {
    case 'typecheck':
      return { kind, command: 'pnpm', args: ['typecheck'] };
    case 'tests':
      return { kind, command: 'pnpm', args: ['test'] };
    case 'lint':
      return { kind, command: 'pnpm', args: ['lint'] };
    case 'e2e':
      return { kind, command: 'pnpm', args: ['e2e'] };
  }
}

export type CheckCommandOverride = { command: string; args: string[] };
export type CheckCommandOverrides = Partial<Record<CheckKind, CheckCommandOverride>>;

export function resolveCheckCommand(
  kind: CheckKind,
  overrides?: CheckCommandOverrides | null,
): CheckCommand {
  const override = overrides?.[kind];
  if (override && typeof override.command === 'string' && Array.isArray(override.args)) {
    return { kind, command: override.command, args: [...override.args] };
  }
  return defaultCheckCommand(kind);
}

export async function runCheck(opts: RunCheckOptions): Promise<CheckResult> {
  const spawn = opts.spawn ?? nodeSpawn;
  const start = Date.now();
  return await new Promise<CheckResult>((resolve) => {
    const child = spawn(opts.command.command, opts.command.args, {
      cwd: opts.cwd,
      env: createCliEnvironment(),
    });
    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        kind: opts.command.kind,
        status: 'fail',
        durationMs: Date.now() - start,
        summary: `spawn error: ${err.message}`,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const status: 'pass' | 'fail' = !killed && code === 0 ? 'pass' : 'fail';
      const summary = summarize(stdout, stderr, code, killed);
      resolve({ kind: opts.command.kind, status, durationMs, summary });
    });
  });
}

function summarize(stdout: string, stderr: string, code: number | null, killed: boolean): string {
  if (killed) return 'timed out';
  const tailOut = stdout.split('\n').slice(-6).join('\n').trim();
  const tailErr = stderr.split('\n').slice(-3).join('\n').trim();
  const head = `exit ${code}`;
  return [head, tailOut, tailErr].filter(Boolean).join(' · ').slice(0, 600);
}
