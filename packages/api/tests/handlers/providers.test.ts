import { openStoreInMemory, type Store } from '@kanbots/local-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProvidersHandlers, type ProvidersHandlers } from '../../src/handlers/index.js';

function makeProvidersHandlers(acpCommand: string | null): {
  handlers: ProvidersHandlers;
  store: Store;
} {
  const store = openStoreInMemory();
  const handlers = createProvidersHandlers({
    store,
    providers: {
      safeStorageAvailable: () => false,
      hasClaudeCodeCredentials: () => false,
    },
    acpCommand: {
      get: () => ({ acpCommand }),
    },
  });
  return { handlers, store };
}

describe('providers ACP validation', () => {
  const originalAcpCommand = process.env.KANBOTS_ACP_COMMAND;

  beforeEach(() => {
    delete process.env.KANBOTS_ACP_COMMAND;
  });

  afterEach(() => {
    if (originalAcpCommand === undefined) delete process.env.KANBOTS_ACP_COMMAND;
    else process.env.KANBOTS_ACP_COMMAND = originalAcpCommand;
  });

  it('validates ACP against the workspace command before the env/default command', async () => {
    process.env.KANBOTS_ACP_COMMAND = 'definitely-missing-kanbots-acp-command';
    const { handlers, store } = makeProvidersHandlers('node --acp');

    const result = await handlers['providers:test-connection']({ id: 'acp' });

    expect(result.ok).toBe(true);
    expect(store.providers.get('acp').lastError).toBeNull();
  });

  it('treats a workspace ACP command as configured provider state', async () => {
    const { handlers } = makeProvidersHandlers('node --acp');

    const payload = await handlers['providers:get'](undefined);
    const acp = payload.providers.find((provider) => provider.id === 'acp');

    expect(acp?.hasKey).toBe(true);
  });
});
