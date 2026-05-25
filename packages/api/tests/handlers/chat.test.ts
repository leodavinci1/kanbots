import { describe, expect, it } from 'vitest';
import { makeHandlerTestKit } from '../helpers/make-handlers.js';

function lastStartArgs(supervisor: ReturnType<typeof makeHandlerTestKit>['supervisor']) {
  let call: (typeof supervisor.calls)[number] | undefined;
  for (let index = supervisor.calls.length - 1; index >= 0; index -= 1) {
    const entry = supervisor.calls[index];
    if (entry?.type === 'start') {
      call = entry;
      break;
    }
  }
  expect(call).toBeDefined();
  return call?.args as { provider?: string; model?: string };
}

describe('chat:post-message provider/model overrides', () => {
  it('inherits the pinned session model when the provider is not overridden', async () => {
    const { handlers, supervisor } = makeHandlerTestKit();
    const chat = await handlers['chat:create']({});
    const session = await handlers['chat:sessions:create']({
      conversationId: chat.conversation.id,
      agentProvider: 'claude-code',
      agentModel: 'claude-sonnet-4-6',
    });

    await handlers['chat:post-message']({
      conversationId: chat.conversation.id,
      sessionId: session.id,
      body: 'hello',
    });

    expect(lastStartArgs(supervisor)).toMatchObject({
      provider: 'claude-code',
      model: 'claude-sonnet-4-6',
    });
  });

  it('does not carry a pinned session model across provider overrides', async () => {
    const { handlers, supervisor } = makeHandlerTestKit();
    const chat = await handlers['chat:create']({});
    const session = await handlers['chat:sessions:create']({
      conversationId: chat.conversation.id,
      agentProvider: 'claude-code',
      agentModel: 'claude-sonnet-4-6',
    });

    await handlers['chat:post-message']({
      conversationId: chat.conversation.id,
      sessionId: session.id,
      provider: 'codex-cli',
      body: 'hello',
    });

    const args = lastStartArgs(supervisor);
    expect(args.provider).toBe('codex-cli');
    expect(args.model).toBeUndefined();
  });

  it('uses an explicit model from a provider override', async () => {
    const { handlers, supervisor } = makeHandlerTestKit();
    const chat = await handlers['chat:create']({});
    const session = await handlers['chat:sessions:create']({
      conversationId: chat.conversation.id,
      agentProvider: 'claude-code',
      agentModel: 'claude-sonnet-4-6',
    });

    await handlers['chat:post-message']({
      conversationId: chat.conversation.id,
      sessionId: session.id,
      provider: 'codex-cli',
      model: 'gpt-5.5',
      body: 'hello',
    });

    expect(lastStartArgs(supervisor)).toMatchObject({
      provider: 'codex-cli',
      model: 'gpt-5.5',
    });
  });
});

describe('chat:delete', () => {
  it('removes a conversation and returns ok', async () => {
    const { handlers, store } = makeHandlerTestKit();
    const chat = await handlers['chat:create']({ title: 'Delete me' });

    await handlers['chat:post-message']({
      conversationId: chat.conversation.id,
      body: 'hello',
      dispatch: false,
    });

    expect(store.chatConversations.findById(chat.conversation.id)).not.toBeNull();

    await expect(
      handlers['chat:delete']({ conversationId: chat.conversation.id }),
    ).resolves.toEqual({ ok: true });

    expect(store.chatConversations.findById(chat.conversation.id)).toBeNull();
    expect(store.messages.list(chat.conversation.threadId)).toEqual([]);
    expect(store.chatSessions.listByConversation(chat.conversation.id)).toEqual([]);
    expect(await handlers['chat:list'](undefined)).toEqual([]);
    await expect(handlers['chat:get']({ conversationId: chat.conversation.id })).rejects.toThrow(
      `chat conversation ${chat.conversation.id} not found`,
    );
  });

  it('is idempotent for a missing conversation', async () => {
    const { handlers } = makeHandlerTestKit();

    await expect(handlers['chat:delete']({ conversationId: 99_999 })).resolves.toEqual({
      ok: true,
    });
  });

  it('stops an active run before deleting the conversation', async () => {
    const { handlers, store, supervisor } = makeHandlerTestKit();
    const chat = await handlers['chat:create']({});

    await handlers['chat:post-message']({
      conversationId: chat.conversation.id,
      body: 'start a run',
    });

    const active = store.agentRuns.findActiveForThread(chat.conversation.threadId);
    expect(active).not.toBeNull();

    const originalStop = supervisor.stop.bind(supervisor);
    let stoppedRunId: number | null = null;
    let sawConversationDuringStop = false;
    supervisor.stop = async (runId) => {
      stoppedRunId = runId;
      sawConversationDuringStop = store.chatConversations.findById(chat.conversation.id) !== null;
      return originalStop(runId);
    };

    await expect(
      handlers['chat:delete']({ conversationId: chat.conversation.id }),
    ).resolves.toEqual({ ok: true });

    expect(stoppedRunId).toBe(active?.id);
    expect(sawConversationDuringStop).toBe(true);
    expect(store.chatConversations.findById(chat.conversation.id)).toBeNull();
  });
});
