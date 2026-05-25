import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

import { createCliEnvironment } from './cli-env.js';
import { startPreviewProxy, type PreviewProxyHandle } from './preview-proxy.js';

export type PreviewState = 'idle' | 'booting' | 'live' | 'crashed' | 'stopped';

export interface PreviewHandle {
  pid: number;
  port: number;
  /**
   * URL the iframe should load. When the proxy is enabled (default), this
   * is the proxy origin; otherwise it equals `upstreamUrl`.
   */
  url: string;
  /**
   * Raw dev-server URL. Always points to the underlying child process so
   * the renderer can open it in an external browser (where the user has
   * native devtools and the proxy injection is unnecessary).
   */
  upstreamUrl: string;
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
  /**
   * When true (default), spawn an HTTP proxy in front of the dev server
   * and return the proxy URL from the handle. The proxy injects scripts
   * for the in-iframe devtools panel and click-to-component inspector.
   */
  proxy?: boolean;
  /**
   * Optional override forwarded to the proxy so it can locate its injection
   * assets (`eruda.js`, `eruda-init.js`, `inspect.js`). Downstream consumers
   * that re-bundle this module should pass an absolute path to where they
   * copy those files at build time.
   */
  assetsDir?: string;
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
 * port number, and resolves once we see one. When `proxy` is enabled (the
 * default) we then spawn an HTTP proxy in front so the iframe loads a
 * same-origin URL we can inject scripts into.
 *
 * If detection fails within `detectMs`, the handle is returned with state
 * `crashed` so callers can surface a hint to the user.
 */
export async function startPreview(opts: StartPreviewOptions): Promise<PreviewHandle> {
  const spawn = opts.spawn ?? nodeSpawn;
  const port = await pickPort(opts.preferredPort ?? DEFAULT_PORT);
  const env: NodeJS.ProcessEnv = createCliEnvironment({
    PORT: String(port),
    NODE_ENV: 'development',
  });
  const child = opts.startCommandLine
    ? spawn(opts.startCommandLine, [], { cwd: opts.cwd, env, shell: true } as PreviewSpawnOptions)
    : (() => {
        const cmd = opts.startCommand ?? ['pnpm', 'dev'];
        return spawn(cmd[0]!, cmd.slice(1), { cwd: opts.cwd, env });
      })();
  const pid = child.pid ?? -1;
  const stateRef: { current: PreviewState } = { current: 'booting' };

  const upstreamUrl = `http://localhost:${port}`;
  const detectionMs = opts.detectMs ?? DEFAULT_DETECT_MS;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      stateRef.current = 'crashed';
      resolve();
    }, detectionMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (PORT_RE.test(text) || text.includes(`localhost:${port}`)) {
        stateRef.current = 'live';
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', () => {
      if (stateRef.current !== 'live') stateRef.current = 'crashed';
      clearTimeout(timer);
      resolve();
    });
  });

  const wantProxy = opts.proxy !== false && stateRef.current === 'live';
  let proxyHandle: PreviewProxyHandle | null = null;
  if (wantProxy) {
    try {
      proxyHandle = await startPreviewProxy({
        upstreamUrl,
        preferredPort: port + 100,
        ...(opts.assetsDir !== undefined ? { assetsDir: opts.assetsDir } : {}),
      });
    } catch {
      // Proxy failed — degrade to the raw upstream URL so the iframe still
      // works, just without the injected devtools.
      proxyHandle = null;
    }
  }

  const url = proxyHandle?.url ?? upstreamUrl;
  const resolvedPort = proxyHandle?.port ?? port;

  return {
    pid,
    port: resolvedPort,
    url,
    upstreamUrl,
    state: stateRef.current,
    async stop() {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      if (proxyHandle) {
        try {
          await proxyHandle.stop();
        } catch {
          // ignore
        }
      }
      stateRef.current = 'stopped';
    },
  };
}
