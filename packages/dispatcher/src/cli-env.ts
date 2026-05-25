import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const WIN32 = process.platform === 'win32';

function envPathKey(env: NodeJS.ProcessEnv): string {
  const existing = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  return existing ?? 'PATH';
}

function splitPath(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(delimiter).filter((entry) => entry.length > 0);
}

function dedupePath(entries: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    const key = WIN32 ? entry.toLowerCase() : entry;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.join(delimiter);
}

function fallbackPathEntries(): string[] {
  if (WIN32) return [];
  const home = homedir();
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/opt/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.npm-global', 'bin'),
  ];
}

export function mergePathValues(...values: Array<string | undefined>): string {
  return dedupePath(values.flatMap(splitPath));
}

export function createCliEnvironment(
  extraEnv?: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  const key = envPathKey(env);
  const explicitPath = extraEnv ? (extraEnv.PATH ?? extraEnv.Path ?? extraEnv.path) : undefined;
  env[key] = mergePathValues(
    explicitPath,
    env[key],
    process.env[envPathKey(process.env)],
    fallbackPathEntries().join(delimiter),
  );
  if (WIN32) {
    for (const other of Object.keys(env)) {
      if (other !== key && other.toLowerCase() === 'path') delete env[other];
    }
  }
  return env;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, WIN32 ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hasPathSeparator(command: string): boolean {
  return command.includes('/') || command.includes('\\');
}

function candidateExtensions(command: string, env: NodeJS.ProcessEnv): string[] {
  if (!WIN32) return [''];
  if (/\.[^\\/]+$/.test(command)) return [''];
  const raw = env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return raw
    .split(';')
    .filter((ext) => ext.length > 0)
    .map((ext) => ext.toLowerCase());
}

export function resolveCommandOnPath(
  command: string,
  env: NodeJS.ProcessEnv = createCliEnvironment(),
): string | null {
  if (command.length === 0) return null;
  if (hasPathSeparator(command)) {
    return isExecutable(command) ? command : null;
  }
  const pathValue = env[envPathKey(env)];
  const dirs = splitPath(pathValue);
  const extensions = candidateExtensions(command, env);
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, `${command}${ext}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}
