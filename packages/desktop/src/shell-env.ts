import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { mergePathValues } from '@kanbots/dispatcher';

const execFileAsync = promisify(execFile);

const SENTINEL = '__KANBOTS_LOGIN_SHELL_ENV__';
const ENV_TIMEOUT_MS = 1_500;

function defaultShell(): string | null {
  if (process.platform === 'win32') return null;
  const envShell = process.env.SHELL;
  if (envShell && existsSync(envShell)) return envShell;
  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function parseEnvOutput(stdout: string): Record<string, string> {
  const sentinelIndex = stdout.lastIndexOf(`${SENTINEL}\n`);
  if (sentinelIndex === -1) return {};
  const body = stdout.slice(sentinelIndex + SENTINEL.length + 1);
  const env: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const ix = line.indexOf('=');
    if (ix <= 0) continue;
    const key = line.slice(0, ix);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = line.slice(ix + 1);
  }
  return env;
}

async function readLoginShellEnv(shell: string): Promise<Record<string, string>> {
  const script = `printf '${SENTINEL}\\n'; env`;
  const attempts = [
    ['-ilc', script],
    ['-lc', script],
    ['-c', script],
  ];

  for (const args of attempts) {
    try {
      const { stdout } = await execFileAsync(shell, args, {
        timeout: ENV_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      const parsed = parseEnvOutput(String(stdout));
      if (Object.keys(parsed).length > 0) return parsed;
    } catch {}
  }
  return {};
}

export async function hydrateProcessEnvFromLoginShell(): Promise<void> {
  const shell = defaultShell();
  if (shell === null) return;
  const shellEnv = await readLoginShellEnv(shell);
  if (Object.keys(shellEnv).length === 0) return;

  const currentPath = process.env.PATH;
  if (shellEnv.PATH) {
    process.env.PATH = mergePathValues(shellEnv.PATH, currentPath);
  }

  for (const [key, value] of Object.entries(shellEnv)) {
    if (key === 'PATH') continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
}
