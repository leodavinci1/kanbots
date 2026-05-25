import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { toIpcError } from './errors.js';
import type { OwnedSubscriptionRegistry } from './subscriptions.js';
import type { Handlers } from '@kanbots/api';

export const CHANNEL_PREFIX = 'kanbots:invoke:';
export const SUBSCRIBE_CHANNEL = 'agent-runs:events:subscribe';
export const UNSUBSCRIBE_CHANNEL = 'agent-runs:events:unsubscribe';

interface SubscribeArgs {
  runId: number;
  sinceSeq?: number;
  scope?: 'workspace' | 'chat';
}

interface UnsubscribeArgs {
  subscriptionId: string;
}

function wrapHandler(
  fn: (event: IpcMainInvokeEvent, args: unknown) => Promise<unknown> | unknown,
): (event: IpcMainInvokeEvent, args: unknown) => Promise<unknown> {
  return async (event, args) => {
    try {
      // Local-first launch: workspace-scoped handlers run without a
      // cloud session. Channels that genuinely require cloud (e.g.
      // `kanbots:cloud:*` in main.ts, and the cloud-run dispatcher
      // which calls `requireCloudAuth` directly) gate themselves.
      return await fn(event, args);
    } catch (err) {
      // ipcMain only ships the message field across the IPC boundary, so we
      // serialize the structured error into the message and let the renderer
      // parse it back into a typed Error.
      throw new Error(JSON.stringify(toIpcError(err)));
    }
  };
}

export interface RegisterHandlersOptions {
  registerEventStreams?: boolean;
}

export function registerHandlers(
  handlers: Handlers,
  registry: OwnedSubscriptionRegistry,
  opts: RegisterHandlersOptions = {},
): () => void {
  const registered: string[] = [];
  const registerEventStreams = opts.registerEventStreams ?? true;

  for (const channel of Object.keys(handlers) as Array<keyof Handlers>) {
    if (channel === SUBSCRIBE_CHANNEL || channel === UNSUBSCRIBE_CHANNEL) {
      // Stream 2 owns the streaming wiring — needs event.sender.id for
      // window-scoped cleanup, which the generic Handlers map can't carry.
      continue;
    }
    if (channel.startsWith('providers:')) {
      // Provider config is per-user; registered once at app startup against
      // the app-level store. See providers-ipc.ts.
      continue;
    }
    if (channel.startsWith('chat:')) {
      // Chat state is per-device (lives at userData/device-chats.db),
      // registered once at app startup so the chat UI works in both
      // workspace and cloud-only mode. See registerChatIpc in main.ts.
      continue;
    }
    const handler = handlers[channel] as (args: unknown) => Promise<unknown>;
    ipcMain.handle(
      `${CHANNEL_PREFIX}${channel}`,
      wrapHandler((_event, args) => handler(args)),
    );
    registered.push(channel);
  }

  if (registerEventStreams) {
    ipcMain.handle(
      `${CHANNEL_PREFIX}${SUBSCRIBE_CHANNEL}`,
      wrapHandler((event, args) => {
        const a = args as SubscribeArgs;
        return registry.register({
          runId: a.runId,
          ownerId: event.sender.id,
          ...(a.sinceSeq !== undefined ? { sinceSeq: a.sinceSeq } : {}),
        });
      }),
    );
    registered.push(SUBSCRIBE_CHANNEL);

    ipcMain.handle(
      `${CHANNEL_PREFIX}${UNSUBSCRIBE_CHANNEL}`,
      wrapHandler((_event, args) => {
        const a = args as UnsubscribeArgs;
        registry.unregister(a.subscriptionId);
        return undefined;
      }),
    );
    registered.push(UNSUBSCRIBE_CHANNEL);
  }

  return () => {
    for (const channel of registered) {
      ipcMain.removeHandler(`${CHANNEL_PREFIX}${channel}`);
    }
  };
}
