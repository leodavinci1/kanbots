import { join } from 'node:path';
import { app, ipcMain } from 'electron';
import {
  createProvidersHandlers,
  type ProvidersHandlerDeps,
  type ProvidersHandlers,
  type ProvidersRuntime,
} from '@kanbots/api';
import { openStore, type Store } from '@kanbots/local-store';
import { CHANNEL_PREFIX } from './ipc/register.js';
import { toIpcError } from './ipc/errors.js';
import { hasClaudeCodeCredentials, safeStorageAvailable } from './providers-key.js';

/**
 * Provider config (Claude Code / Codex CLI defaults + last-validated state)
 * is per-user, not per-workspace — the underlying credentials live in
 * ~/.claude/ and ~/.codex/ regardless of which project is open. We therefore
 * register the four `providers:*` IPC handlers once at app startup against an
 * app-level SQLite at `userData/app-store.sqlite`. They stay registered for
 * the app lifetime so the Providers modal works in both cloud-only mode
 * (no active local workspace) and legacy local mode.
 */

let appStore: Store | null = null;

export interface RegisterProvidersIpcOptions {
  getAcpCommand?: () => string | null | undefined;
}

function getAppStore(): Store {
  if (appStore !== null) return appStore;
  const path = join(app.getPath('userData'), 'app-store.sqlite');
  appStore = openStore({ path });
  return appStore;
}

export function registerProvidersIpc(opts: RegisterProvidersIpcOptions = {}): void {
  const runtime: ProvidersRuntime = {
    safeStorageAvailable,
    hasClaudeCodeCredentials,
  };
  const deps: ProvidersHandlerDeps = {
    get store() {
      return getAppStore();
    },
    providers: runtime,
    acpCommand: { get: () => ({ acpCommand: opts.getAcpCommand?.() ?? null }) },
  };
  const handlers: ProvidersHandlers = createProvidersHandlers(deps);

  const channels = Object.keys(handlers) as ReadonlyArray<keyof ProvidersHandlers & string>;
  for (const channel of channels) {
    const handler = handlers[channel] as (args: unknown) => Promise<unknown>;
    ipcMain.handle(`${CHANNEL_PREFIX}${channel}`, async (_event, args) => {
      try {
        return await handler(args);
      } catch (err) {
        // Mirror ipc/register.ts: ipcMain only ships `message` across the
        // boundary, so encode structured error info into it.
        throw new Error(JSON.stringify(toIpcError(err)));
      }
    });
  }
}

export function closeProvidersStoreForShutdown(): void {
  if (appStore === null) return;
  try {
    appStore.close();
  } catch {
    // best-effort
  }
  appStore = null;
}
