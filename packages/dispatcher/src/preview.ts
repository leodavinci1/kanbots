import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

export type PreviewState = 'idle' | 'booting' | 'live' | 'crashed' | 'stopped';

export interface PreviewHandle {
  pid: number;
  port: number;
  url: string;
  state: PreviewState;
  stop: () => Promise<void>;
}

export interface PreviewSpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Internal: passed to node:child_process.spawn for shell-mode commands. */
  shell?: boolean;
}

export interface StartPreviewOptions {
  cwd: string;
  startCommand?: string[];
  /**
   * Raw shell command string (e.g. `pnpm dev --host`). When set, takes
   * precedence over `startCommand` and is executed via `{ shell: true }`
   * so pipes / env-vars / multi-token args work the way users expect.
   * Used by the per-repo dev-server-script config from Settings.
   */
  startCommandLine?: string;
  preferredPort?: number;
  detectMs?: number;
  spawn?: (command: string, args: readonly string[], options: PreviewSpawnOptions) => ChildProcess;
}

const DEFAULT_DETECT_MS = 60_000;
const DEFAULT_PORT = 3041;

async function isPortFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function pickPort(start: number, attempts = 12): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    const candidate = start + i;
    if (await isPortFree(candidate)) return candidate;
  }
  throw new Error(`no free port near ${start}`);
}

const PORT_RE = /(?:https?:\/\/[^\s]*?:|listening on(?:[^\d]+))(\d{2,5})/i;

/**
 * Spawns `pnpm dev` (or a custom command) inside `cwd`, watches stdout for a
 * port number, and resolves once we see one.
 *
 * If detection fails within `detectMs`, the handle is returned with state
 * `crashed` so callers can surface a hint to the user.
 */
export async function startPreview(opts: StartPreviewOptions): Promise<PreviewHandle> {
  const spawn = opts.spawn ?? nodeSpawn;
  const port = await pickPort(opts.preferredPort ?? DEFAULT_PORT);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'development',
  };
  const child = opts.startCommandLine
    ? spawn(opts.startCommandLine, [], { cwd: opts.cwd, env, shell: true } as PreviewSpawnOptions)
    : (() => {
        const cmd = opts.startCommand ?? ['pnpm', 'dev'];
        return spawn(cmd[0]!, cmd.slice(1), { cwd: opts.cwd, env });
      })();
  const pid = child.pid ?? -1;
  let state: PreviewState = 'booting';

  const url = `http://localhost:${port}`;
  const detectionMs = opts.detectMs ?? DEFAULT_DETECT_MS;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      state = 'crashed';
      resolve();
    }, detectionMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (PORT_RE.test(text) || text.includes(`localhost:${port}`)) {
        state = 'live';
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', () => {
      if (state !== 'live') state = 'crashed';
      clearTimeout(timer);
      resolve();
    });
  });

  return {
    pid,
    port,
    url,
    state,
    async stop() {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      state = 'stopped';
    },
  };
}
