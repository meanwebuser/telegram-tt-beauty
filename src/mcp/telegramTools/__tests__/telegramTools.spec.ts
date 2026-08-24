import { describe, expect, it, vi } from 'vitest';

import type { ApiChat } from '../../../api/types';

import { createTelegramToolRegistry, createTelegramToolRuntime } from '../index';

function makeChat(overrides: Partial<ApiChat> = {}): ApiChat {
  return {
    id: 'chat-1',
    type: 'chatTypeChannel',
    title: 'Channel 1',
    ...overrides,
  };
}

async function confirmMutation(
  registry: ReturnType<typeof createTelegramToolRegistry>,
  tool: 'send' | 'edit_message',
  args: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  const context = {
    transport: 'test',
    harness: 'test',
    actor: 'tester',
    sessionId: 'test-session',
    allowWrite: true,
    ...overrides,
  };
  const draft = await registry.createMutationDraft(tool, args);
  const evidence = await registry.confirmMutation(draft!.draft_id, draft!.confirmation_text, context);
  if (!evidence.ok) throw new Error(evidence.error.message);
  return { ...context, mutationConfirmation: evidence.data };
}

describe('telegram tool registry', () => {
  it('exposes only the canonical chats/read/send tools', () => {
    const registry = createTelegramToolRegistry({
      listChats: vi.fn(),
      resolveChat: vi.fn(),
      fetchMessagesById: vi.fn(),
      fetchMessages: vi.fn(),
      searchMessages: vi.fn(),
      fetchFullChat: vi.fn(),
      markMessageListRead: vi.fn(),
      markMessagesRead: vi.fn(),
      sendMessage: vi.fn(),
    });

    expect(registry.schemas.map((schema) => schema.function.name)).toEqual([
      'capabilities', 'chats', 'read', 'send', 'edit_message',
      'media.inspect', 'media.read', 'media.download', 'mutation.confirm',
    ]);
  });

  it('rejects read arguments that mix ids with query modes', async () => {
    const registry = createTelegramToolRegistry({
      listChats: vi.fn(),
      resolveChat: vi.fn(),
      fetchMessagesById: vi.fn(),
      fetchMessages: vi.fn(),
      searchMessages: vi.fn(),
      fetchFullChat: vi.fn(),
      markMessageListRead: vi.fn(),
      markMessagesRead: vi.fn(),
      sendMessage: vi.fn(),
    });

    const result = await registry.execute('read', {
      chat_id: 'chat-1',
      ids: [1],
      query: 'hello',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MUTUALLY_EXCLUSIVE_MODES');
  });

  it('normalizes capabilities and filters unread chats', async () => {
    const listChats = vi.fn().mockResolvedValue({
      chats: [
        makeChat({
          id: 'chat-1',
          title: 'Unread channel',
          currentUserBannedRights: { sendMessages: true },
        }),
        makeChat({
          id: 'chat-2',
          title: 'Read group',
        }),
      ],
      messages: [
        { id: 10, chatId: 'chat-1', date: 100, isUnread: true, content: {} },
        { id: 20, chatId: 'chat-2', date: 200, isUnread: false, content: {} },
      ],
      threadReadStatesById: {
        'chat-1': { unreadCount: 1 } as never,
        'chat-2': { unreadCount: 0 } as never,
      },
      orderedPinnedIds: [],
      totalChatCount: 2,
    });

    const registry = createTelegramToolRegistry({
      listChats,
      resolveChat: vi.fn(),
      fetchMessagesById: vi.fn(),
      fetchMessages: vi.fn(),
      searchMessages: vi.fn(),
      fetchFullChat: vi.fn(),
      markMessageListRead: vi.fn(),
      markMessagesRead: vi.fn(),
      sendMessage: vi.fn(),
    });

    const result = await registry.execute('chats', {
      unread_only: true,
      limit: 20,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { chats: Array<{ chat_id: string; capabilities: { can_send_text: boolean } }> };
    expect(data.chats).toHaveLength(1);
    expect(data.chats[0].chat_id).toBe('chat-1');
    expect(data.chats[0].capabilities.can_send_text).toBe(false);
  });

  it('forwards date and unread filters through the canonical read handler', async () => {
    const resolveChat = vi.fn().mockResolvedValue(makeChat({ id: 'chat-1' }));
    const searchMessages = vi.fn().mockResolvedValue({ messages: [] });
    const registry = createTelegramToolRegistry({
      listChats: vi.fn(),
      resolveChat,
      fetchMessagesById: vi.fn(),
      fetchMessages: vi.fn(),
      searchMessages,
      fetchFullChat: vi.fn(),
      markMessageListRead: vi.fn(),
      markMessagesRead: vi.fn(),
      sendMessage: vi.fn(),
    });

    await registry.execute('read', {
      chat_id: 'chat-1',
      query: 'contract',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-07T00:00:00.000Z',
      unread_only: true,
    });

    expect(searchMessages).toHaveBeenCalledWith(expect.objectContaining({
      query: 'contract',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-07T00:00:00.000Z',
      unreadOnly: true,
    }));
  });

  it('validates send target modes and resolves comment targets through the linked discussion chat', async () => {
    const resolveChat = vi.fn().mockReturnValue(makeChat({ id: 'channel-1', type: 'chatTypeChannel' }));
    const fetchFullChat = vi.fn().mockResolvedValue({
      fullInfo: { linkedChatId: 'discussion-1' },
      chats: [makeChat({ id: 'discussion-1', type: 'chatTypeSuperGroup' })],
    });
    const sendMessage = vi.fn().mockResolvedValue({ id: 99 });

    const registry = createTelegramToolRegistry({
      listChats: vi.fn(),
      resolveChat,
      fetchMessagesById: vi.fn(),
      fetchMessages: vi.fn(),
      searchMessages: vi.fn(),
      fetchFullChat,
      markMessageListRead: vi.fn(),
      markMessagesRead: vi.fn(),
      sendMessage,
    });

    const conflict = await registry.execute('send', {
      chat_id: 'channel-1',
      text: 'hi',
      reply_to: 4,
      comment_to: 8,
    }, { allowWrite: true });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error.code).toBe('MUTUALLY_EXCLUSIVE_MODES');

    const sendArgs = {
      chat_id: 'channel-1',
      text: 'hi',
      comment_to: 8,
    };
    const sendContext = await confirmMutation(registry, 'send', sendArgs);
    const result = await registry.execute('send', sendArgs, sendContext);

    expect(result.ok).toBe(true);
    expect(fetchFullChat).toHaveBeenCalledWith(expect.objectContaining({ id: 'channel-1' }));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chat: expect.objectContaining({ id: 'discussion-1' }),
      text: 'hi',
    }));
  });

  it('audits every tool boundary and preserves one correlation id through send', async () => {
    const audit = vi.fn();
    const sendMessage = vi.fn().mockResolvedValue({ id: 100 });
    const registry = createTelegramToolRegistry({
      listChats: vi.fn(),
      resolveChat: vi.fn().mockResolvedValue(makeChat({ id: 'chat-audit', type: 'chatTypeSuperGroup' })),
      fetchMessagesById: vi.fn(),
      fetchMessages: vi.fn(),
      searchMessages: vi.fn(),
      fetchFullChat: vi.fn(),
      markMessageListRead: vi.fn(),
      markMessagesRead: vi.fn(),
      sendMessage,
    }, { audit });

    const sendArgs = {
      chat_id: 'chat-audit',
      text: 'secret text must not be logged',
    };
    const sendContext = await confirmMutation(registry, 'send', sendArgs, {
      transport: 'browser-mcp',
      harness: 'browser-mcp',
    });
    const result = await registry.execute('send', sendArgs, {
      ...sendContext,
      correlationId: 'req-audit-1',
      transport: 'browser-mcp',
      harness: 'browser-mcp',
    });

    expect(result.ok).toBe(true);
    expect(audit).toHaveBeenCalledTimes(4);
    expect(audit.mock.calls[0][0]).toMatchObject({
      event: 'mcp_call_start',
      correlation_id: 'req-audit-1',
      transport: 'browser-mcp',
      tool: 'send',
      chat_id: 'chat-audit',
      text_length: 30,
    });
    expect(audit.mock.calls[1][0]).toMatchObject({
      event: 'telegram_send_start',
      correlation_id: 'req-audit-1',
      transport: 'browser-mcp',
      tool: 'send',
      chat_id: 'chat-audit',
    });
    expect(audit.mock.calls[2][0]).toMatchObject({
      event: 'telegram_send_end',
      correlation_id: 'req-audit-1',
      transport: 'browser-mcp',
      ok: true,
    });
    expect(audit.mock.calls[3][0]).toMatchObject({
      event: 'mcp_call_end',
      correlation_id: 'req-audit-1',
      ok: true,
    });
    expect(audit.mock.calls[0][0]).not.toHaveProperty('text');
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chat: expect.objectContaining({ id: 'chat-audit' }),
      text: 'secret text must not be logged',
    }));
  });

  it('blocks mark-as-read as a state mutation when write permission is denied', async () => {
    const markMessageListRead = vi.fn();
    const registry = createTelegramToolRegistry({
      listChats: vi.fn(),
      resolveChat: vi.fn().mockResolvedValue(makeChat({ id: 'chat-read-only', type: 'chatTypeSuperGroup' })),
      fetchMessagesById: vi.fn(),
      fetchMessages: vi.fn().mockResolvedValue({
        messages: [{ id: 1, chatId: 'chat-read-only', date: 1, content: {} }],
      }),
      searchMessages: vi.fn(),
      fetchFullChat: vi.fn(),
      markMessageListRead,
      markMessagesRead: vi.fn(),
      sendMessage: vi.fn(),
    });

    const result = await registry.execute('read', {
      chat_id: 'chat-read-only',
      mark_read: true,
    }, { transport: 'browser-mcp', allowWrite: false });

    expect(result).toMatchObject({ ok: false, error: { code: 'WRITE_DISABLED' } });
    expect(markMessageListRead).not.toHaveBeenCalled();
  });

  it('defaults omitted write permission to denied in the canonical registry', async () => {
    const registry = createTelegramToolRegistry({
      listChats: vi.fn(),
      resolveChat: vi.fn(),
      fetchMessagesById: vi.fn(),
      fetchMessages: vi.fn(),
      searchMessages: vi.fn(),
      fetchFullChat: vi.fn(),
      markMessageListRead: vi.fn(),
      markMessagesRead: vi.fn(),
      sendMessage: vi.fn(),
    });

    const sendResult = await registry.execute('send', { chat_id: 'chat-default-deny', text: 'blocked' });
    const readResult = await registry.execute('read', {
      chat_id: 'chat-default-deny',
      mark_read: true,
    });

    expect(sendResult).toMatchObject({ ok: false, error: { code: 'WRITE_DISABLED' } });
    expect(readResult).toMatchObject({ ok: false, error: { code: 'WRITE_DISABLED' } });
  });
});

describe('telegram tool runtime', () => {
  it('delegates to the canonical registry and keeps the schema names', () => {
    const runtime = createTelegramToolRuntime({
      listChats: vi.fn(),
      resolveChat: vi.fn(),
      fetchMessagesById: vi.fn(),
      fetchMessages: vi.fn(),
      searchMessages: vi.fn(),
      fetchFullChat: vi.fn(),
      markMessageListRead: vi.fn(),
      markMessagesRead: vi.fn(),
      sendMessage: vi.fn(),
    });

    expect(runtime.getToolSchemas().map((schema) => schema.function.name)).toEqual([
      'capabilities', 'chats', 'read', 'send', 'edit_message',
      'media.inspect', 'media.read', 'media.download', 'mutation.confirm',
    ]);
    expect(runtime.isToolAvailable('chats')).toBe(true);
    expect(runtime.isToolAvailable('read')).toBe(true);
    expect(runtime.isToolAvailable('send')).toBe(true);
  });

  it('serializes canonical executeToolCall operations FIFO', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runtime = createTelegramToolRuntime({
      listChats: vi.fn(async () => {
        events.push('first:start');
        await firstGate;
        events.push('first:end');
        return { chats: [] };
      }),
      resolveChat: vi.fn(), fetchMessagesById: vi.fn(), fetchMessages: vi.fn(),
      searchMessages: vi.fn(), fetchFullChat: vi.fn(), markMessageListRead: vi.fn(),
      markMessagesRead: vi.fn(), sendMessage: vi.fn(),
    });

    const first = runtime.executeToolCall('chats', '{}');
    const second = runtime.executeToolCall('chats', '{}');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'first:start', 'first:end']);
  });
});
