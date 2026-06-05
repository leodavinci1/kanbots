import type { Config } from '../../src/handlers/types.js';
import type { AutopilotManager } from '../../src/autopilot/orchestrator.js';
import type { ReadyToGoManager } from '../../src/ready-to-go/manager.js';
import type { AutoReviewManager } from '../../src/auto-review/manager.js';
import {
  createHandlers,
  type Handlers,
  type SubscriptionRegistry,
} from '../../src/index.js';
import { FakeIssueSource, makeStubSupervisor } from './fakes.js';
import { openStoreInMemory, type Store } from '@kanbots/local-store';

export interface FakeRegistry extends SubscriptionRegistry {
  calls: Array<{ kind: 'register' | 'unregister'; args: unknown }>;
  next: { subscriptionId: string; runStatus: 'starting' | 'running' | 'awaiting_input' | 'complete' | 'failed' | 'stopped' };
}

export function makeFakeRegistry(): FakeRegistry {
  const calls: FakeRegistry['calls'] = [];
  const reg: FakeRegistry = {
    calls,
    next: { subscriptionId: 'sub-test', runStatus: 'running' },
    register(args) {
      calls.push({ kind: 'register', args });
      return reg.next;
    },
    unregister(subscriptionId) {
      calls.push({ kind: 'unregister', args: { subscriptionId } });
    },
  };
  return reg;
}

export interface HandlerTestKit {
  source: FakeIssueSource;
  store: Store;
  supervisor: ReturnType<typeof makeStubSupervisor>;
  registry: FakeRegistry;
  config: Config;
  handlers: Handlers;
  draftIssue: (input: { description: string }) => Promise<{ title: string; body: string }>;
}

export function makeHandlerTestKit(
  configOverride: Partial<Config> = {},
): HandlerTestKit {
  const source = new FakeIssueSource();
  const store = openStoreInMemory();
  const supervisor = makeStubSupervisor(store);
  const registry = makeFakeRegistry();
  const draftIssue = async (input: { description: string }) => ({
    title: `drafted: ${input.description.slice(0, 40)}`,
    body: `# Drafted\n\n${input.description}`,
  });
  const suggestIssue = async (input: { personaPrompt: string }) => ({
    title: `suggested feature (${input.personaPrompt.slice(0, 20)})`,
    body: '# Suggested\n\nstub',
  });
  const draftPrDescription = async (input: { issueTitle: string }) => ({
    title: `PR: ${input.issueTitle.slice(0, 60)}`,
    body: '### Summary\n\nstub PR body',
  });
  const config: Config = { owner: 'octo', repo: 'hello', ...configOverride };
  const autopilot: AutopilotManager = {
    start: () => {
      throw new Error('autopilot.start not implemented in test stub');
    },
    stop: async () => {
      throw new Error('autopilot.stop not implemented in test stub');
    },
    getSession: () => null,
    getSessionByIssue: () => null,
    listActive: () => [],
    stopAllForShutdown: async () => {},
  };
  const readyToGo: ReadyToGoManager = {
    start: () => {},
    stop: () => {},
    getStatus: () => ({ running: false, config: { maxConcurrent: 3, intervalMs: 300_000 }, lastTickAt: null, lastDispatchCount: 0 }),
  };
  const autoReview: AutoReviewManager = {
    start: () => {},
    stop: () => {},
    getStatus: () => ({ running: false, config: { maxConcurrent: 2, intervalMs: 300_000 }, lastTickAt: null, lastReviewedCount: 0, activeIssues: [] }),
  };
  const analyzeSentryError = async () => ({
    verdict: 'task' as const,
    confidence: 'medium' as const,
    category: 'bug' as const,
    reasoning: 'stub',
    suggestedTitle: 'stub title',
    suggestedBody: 'stub body',
  });
  const sentry = {
    encryptToken: (plaintext: string) => ({
      buffer: Buffer.from(plaintext, 'utf8'),
      encryption: 'plain' as const,
    }),
    decryptToken: (buffer: Buffer | null) => (buffer ? buffer.toString('utf8') : null),
    envTokenOverride: () => null,
    safeStorageAvailable: () => false,
    syncNow: async () => ({
      imported: 0,
      updated: 0,
      totalSeen: 0,
      lastSyncedAt: new Date().toISOString(),
    }),
    restartPoller: () => {},
  };
  const handlers = createHandlers({
    deps: {
      source,
      store,
      config,
      supervisor,
      draftIssue,
      suggestIssue,
      draftPrDescription,
      autopilot,
      readyToGo,
      autoReview,
      analyzeSentryError,
      sentry,
      providers: {
        safeStorageAvailable: () => false,
        hasClaudeCodeCredentials: () => false,
      },
    },
    subscriptions: registry,
  });
  return { source, store, supervisor, registry, config, handlers, draftIssue };
}
