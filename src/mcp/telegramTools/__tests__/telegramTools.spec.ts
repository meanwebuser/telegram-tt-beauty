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

    expect(registry.schemas.map((schema) => schema.function.name)).toEqual(['chats', 'read', 'send']);
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
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error.code).toBe('MUTUALLY_EXCLUSIVE_MODES');

    const result = await registry.execute('send', {
      chat_id: 'channel-1',
      text: 'hi',
      comment_to: 8,
    });

    expect(result.ok).toBe(true);
    expect(fetchFullChat).toHaveBeenCalledWith(expect.objectContaining({ id: 'channel-1' }));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chat: expect.objectContaining({ id: 'discussion-1' }),
      text: 'hi',
    }));
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

    expect(runtime.getToolSchemas().map((schema) => schema.function.name)).toEqual(['chats', 'read', 'send']);
    expect(runtime.isToolAvailable('chats')).toBe(true);
    expect(runtime.isToolAvailable('read')).toBe(true);
    expect(runtime.isToolAvailable('send')).toBe(true);
  });
});
