import type { ApiChat } from '../../api/types/chats';
import type { ApiMessage, ApiInputReplyInfo } from '../../api/types/messages';

export const TELEGRAM_TOOL_NAMES = ['chats', 'read', 'send'] as const;
export type TelegramToolName = (typeof TELEGRAM_TOOL_NAMES)[number];

export type TelegramToolErrorCode =
  | 'INVALID_ARGUMENTS'
  | 'MUTUALLY_EXCLUSIVE_MODES'
  | 'CHAT_NOT_FOUND'
  | 'COMMENTS_DISABLED'
  | 'NO_DISCUSSION_GROUP'
  | 'CHAT_WRITE_FORBIDDEN'
  | 'CHANNEL_POST_PERMISSION_REQUIRED'
  | 'UNKNOWN_TOOL'
  | 'EXECUTION_FAILED';

export interface TelegramToolError {
  code: TelegramToolErrorCode;
  message: string;
}

export type TelegramToolResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: TelegramToolError };

export interface ChatsArgs {
  query?: string;
  unread_only?: boolean;
  kind?: 'all' | 'private' | 'group' | 'channel' | 'bot';
  folder?: 'main' | 'archive' | string;
  sort?: 'recent' | 'unread_first';
  limit?: number;
}

export interface ReadArgs {
  chat_id: string;
  limit?: number;
  ids?: number[];
  from?: string;
  to?: string;
  query?: string;
  unread_only?: boolean;
  order?: 'newest' | 'oldest';
  mark_read?: boolean;
}

export interface SendArgs {
  chat_id: string;
  text: string;
  reply_to?: number;
  comment_to?: number;
  topic_id?: number;
  silent?: boolean;
}

export interface ToolSchemas {
  type: 'function';
  function: {
    name: TelegramToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
}

type UnknownHandler = (args: unknown) => unknown | Promise<unknown>;

export interface TelegramToolHandlers {
  listChats: UnknownHandler;
  resolveChat: UnknownHandler;
  fetchMessagesById: UnknownHandler;
  fetchMessages: UnknownHandler;
  searchMessages: UnknownHandler;
  fetchFullChat: UnknownHandler;
  markMessageListRead: UnknownHandler;
  markMessagesRead: UnknownHandler;
  sendMessage: UnknownHandler;
}

interface ChatListData {
  chats?: ApiChat[];
  messages?: ApiMessage[];
  threadReadStatesById?: Record<string, { unreadCount?: number; lastReadInboxMessageId?: number }>;
  lastMessageByChatId?: Record<string, number>;
  orderedPinnedIds?: string[];
}

interface MessageCollection {
  messages?: ApiMessage[];
}

const schemas: ToolSchemas[] = [
  {
    type: 'function',
    function: {
      name: 'chats',
      description: 'Find Telegram chats using query, unread, kind, folder, and ordering filters.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Chat title or username filter.' },
          unread_only: { type: 'boolean', default: false },
          kind: { type: 'string', enum: ['all', 'private', 'group', 'channel', 'bot'], default: 'all' },
          folder: { type: 'string', description: 'main, archive, or a Telegram folder id.' },
          sort: { type: 'string', enum: ['recent', 'unread_first'], default: 'recent' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 50 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read messages from one Telegram chat, optionally filtering by ids, range, text, or unread state.',
      parameters: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
          ids: { type: 'array', items: { type: 'integer' }, minItems: 1 },
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
          query: { type: 'string' },
          unread_only: { type: 'boolean', default: false },
          order: { type: 'string', enum: ['newest', 'oldest'], default: 'newest' },
          mark_read: { type: 'boolean', default: false },
        },
        required: ['chat_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send',
      description: 'Send a Telegram message, reply, forum topic message, or channel comment.',
      parameters: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          text: { type: 'string', minLength: 1 },
          reply_to: { type: 'integer' },
          comment_to: { type: 'integer' },
          topic_id: { type: 'integer' },
          silent: { type: 'boolean', default: false },
        },
        required: ['chat_id', 'text'],
        additionalProperties: false,
      },
    },
  },
];

function fail<T = never>(code: TelegramToolErrorCode, message: string): TelegramToolResult<T> {
  return { ok: false, error: { code, message } };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedInteger(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error('limit must be a positive integer');
  return Math.min(value, max);
}

function chatKind(chat: ApiChat): ChatsArgs['kind'] {
  if (chat.type === 'chatTypeChannel') return 'channel';
  if (chat.type === 'chatTypeBasicGroup' || chat.type === 'chatTypeSuperGroup') return 'group';
  if ((chat as ApiChat & { isBot?: boolean }).isBot) return 'bot';
  return 'private';
}

function canSendText(chat: ApiChat): boolean {
  if (chat.isForbidden || chat.isRestricted || chat.currentUserBannedRights?.sendMessages) return false;
  if (chat.type === 'chatTypeChannel') return Boolean(chat.isCreator || chat.adminRights?.postMessages);
  return true;
}

function capabilities(chat: ApiChat) {
  const canSend = canSendText(chat);
  return {
    can_send_text: canSend,
    can_publish_posts: chat.type === 'chatTypeChannel' ? canSend : false,
    can_comment: canSend,
    can_manage_topics: Boolean(chat.adminRights?.manageTopics),
  };
}

function messageText(message: ApiMessage | undefined): string | undefined {
  return message?.content?.text?.text;
}

function serializeMessage(message: ApiMessage) {
  const extra = message as ApiMessage & { isUnread?: boolean };
  return {
    id: message.id,
    chat_id: message.chatId,
    date: new Date(message.date * 1000).toISOString(),
    text: messageText(message),
    sender_id: message.senderId,
    outgoing: message.isOutgoing,
    unread: extra.isUnread,
  };
}

function extractMessages(value: unknown): ApiMessage[] {
  if (Array.isArray(value)) return value as ApiMessage[];
  const messages = asRecord(value).messages;
  return Array.isArray(messages) ? messages as ApiMessage[] : [];
}

function validateRead(args: ReadArgs): TelegramToolResult<ReadArgs> {
  if (!args || typeof args.chat_id !== 'string' || !args.chat_id) return fail('INVALID_ARGUMENTS', 'chat_id is required');
  const idsMode = args.ids !== undefined;
  const otherModes = args.query !== undefined || args.from !== undefined || args.to !== undefined || args.unread_only === true;
  if (idsMode && otherModes) return fail('MUTUALLY_EXCLUSIVE_MODES', 'ids cannot be combined with query, date range, or unread_only');
  if (args.ids && (!Array.isArray(args.ids) || args.ids.some((id) => !Number.isInteger(id)))) {
    return fail('INVALID_ARGUMENTS', 'ids must be an array of integers');
  }
  return { ok: true, data: args };
}

export function createTelegramToolRegistry(handlers: TelegramToolHandlers) {
  async function executeChats(input: ChatsArgs = {}): Promise<TelegramToolResult> {
    try {
      const args = asRecord(input) as ChatsArgs;
      const limit = boundedInteger(args.limit, 50, 50);
      const data = asRecord(await handlers.listChats({ folder: args.folder, limit }));
      let chats = Array.isArray(data.chats) ? data.chats as ApiChat[] : [];
      const messages = Array.isArray(data.messages) ? data.messages as ApiMessage[] : [];
      const readStates = data.threadReadStatesById as ChatListData['threadReadStatesById'] || {};
      const query = args.query?.trim().toLowerCase();

      const rows = chats.map((chat) => {
        const lastMessageId = (data.lastMessageByChatId as Record<string, number> | undefined)?.[chat.id];
        const lastMessage = messages.find((message) => message.chatId === chat.id && (lastMessageId === undefined || message.id === lastMessageId));
        const unreadCount = readStates[chat.id]?.unreadCount || 0;
        return {
          chat_id: chat.id,
          title: chat.title,
          type: chatKind(chat),
          last_message: lastMessage ? serializeMessage(lastMessage) : undefined,
          date: lastMessage ? new Date(lastMessage.date * 1000).toISOString() : undefined,
          unread_count: unreadCount,
          capabilities: capabilities(chat),
          _chat: chat,
        };
      }).filter((row) => {
        const kindMatches = !args.kind || args.kind === 'all' || row.type === args.kind;
        const queryMatches = !query || row.title.toLowerCase().includes(query);
        const unreadMatches = !args.unread_only || row.unread_count > 0;
        return kindMatches && queryMatches && unreadMatches;
      });

      if (args.sort === 'unread_first') {
        rows.sort((left, right) => right.unread_count - left.unread_count);
      }
      chats = rows.slice(0, limit).map((row) => row._chat);
      return { ok: true, data: { chats: rows.slice(0, limit).map(({ _chat, ...row }) => row) } };
    } catch (error) {
      return fail('EXECUTION_FAILED', error instanceof Error ? error.message : 'chats failed');
    }
  }

  async function executeRead(input: ReadArgs): Promise<TelegramToolResult> {
    const validation = validateRead(input);
    if (!validation.ok) return validation;
    try {
      const args = validation.data;
      const chat = await handlers.resolveChat(args.chat_id) as ApiChat | undefined;
      if (!chat) return fail('CHAT_NOT_FOUND', `Chat not found: ${args.chat_id}`);
      const limit = boundedInteger(args.limit, 30, 100);
      let raw: unknown;
      if (args.ids) {
        raw = await handlers.fetchMessagesById({ chat, messageIds: args.ids });
      } else if (args.query !== undefined) {
        raw = await handlers.searchMessages({
          chat,
          query: args.query,
          limit,
          from: args.from,
          to: args.to,
          unreadOnly: args.unread_only,
        });
      } else {
        raw = await handlers.fetchMessages({ chat, limit, order: args.order || 'newest', from: args.from, to: args.to, unreadOnly: args.unread_only });
      }
      let messages = extractMessages(raw).filter((message) => {
        const extra = message as ApiMessage & { isUnread?: boolean };
        return !args.unread_only || extra.isUnread;
      });
      if (args.from) messages = messages.filter((message) => message.date * 1000 >= Date.parse(args.from!));
      if (args.to) messages = messages.filter((message) => message.date * 1000 <= Date.parse(args.to!));
      if (args.order === 'oldest') messages.reverse();
      messages = messages.slice(0, limit);

      if (args.mark_read && messages.length) {
        const maxId = Math.max(...messages.map((message) => message.id));
        if (args.ids) await handlers.markMessagesRead({ chat, messageIds: messages.map((message) => message.id) });
        else await handlers.markMessageListRead({ chat, maxId });
      }
      return { ok: true, data: { chat_id: chat.id, messages: messages.map(serializeMessage), marked_read: Boolean(args.mark_read && messages.length) } };
    } catch (error) {
      return fail('EXECUTION_FAILED', error instanceof Error ? error.message : 'read failed');
    }
  }

  async function executeSend(input: SendArgs): Promise<TelegramToolResult> {
    if (!input || typeof input.chat_id !== 'string' || typeof input.text !== 'string' || !input.text) {
      return fail('INVALID_ARGUMENTS', 'chat_id and text are required');
    }
    if (input.reply_to !== undefined && input.comment_to !== undefined) {
      return fail('MUTUALLY_EXCLUSIVE_MODES', 'reply_to and comment_to cannot be combined');
    }
    try {
      const sourceChat = await handlers.resolveChat(input.chat_id) as ApiChat | undefined;
      if (!sourceChat) return fail('CHAT_NOT_FOUND', `Chat not found: ${input.chat_id}`);
      let targetChat = sourceChat;
      let replyId = input.reply_to;
      if (input.comment_to !== undefined) {
        const full = asRecord(await handlers.fetchFullChat(sourceChat));
        const fullInfo = asRecord(full.fullInfo);
        const linkedChatId = fullInfo.linkedChatId;
        const linkedChat = Array.isArray(full.chats)
          ? (full.chats as ApiChat[]).find((chat) => chat.id === linkedChatId)
          : undefined;
        if (!linkedChatId || !linkedChat) return fail('NO_DISCUSSION_GROUP', 'Channel has no linked discussion group');
        targetChat = linkedChat;
        replyId = input.comment_to;
      }
      if (!canSendText(targetChat)) {
        return fail(targetChat.type === 'chatTypeChannel' && !input.comment_to
          ? 'CHANNEL_POST_PERMISSION_REQUIRED' : 'CHAT_WRITE_FORBIDDEN', 'Writing is not allowed in this chat');
      }
      const replyInfo: ApiInputReplyInfo | undefined = replyId === undefined && input.topic_id === undefined
        ? undefined
        : { type: 'message', replyToMsgId: replyId || input.topic_id!, replyToTopId: input.topic_id };
      const sent = await handlers.sendMessage({
        chat: targetChat,
        text: input.text,
        replyInfo,
        topicId: input.topic_id,
        isSilent: input.silent,
      });
      return { ok: true, data: { chat_id: targetChat.id, message: sent } };
    } catch (error) {
      return fail('EXECUTION_FAILED', error instanceof Error ? error.message : 'send failed');
    }
  }

  return {
    schemas,
    execute: async (name: string, args: Record<string, unknown>): Promise<TelegramToolResult> => {
      if (name === 'chats') return executeChats(args as ChatsArgs);
      if (name === 'read') return executeRead(args as unknown as ReadArgs);
      if (name === 'send') return executeSend(args as unknown as SendArgs);
      return fail('UNKNOWN_TOOL', `Unknown Telegram tool: ${name}`);
    },
  };
}

export function createTelegramToolRuntime(handlers: TelegramToolHandlers) {
  const registry = createTelegramToolRegistry(handlers);
  return {
    getToolSchemas: () => registry.schemas,
    executeToolCall: async (toolName: string, argumentsJson: string) => {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(argumentsJson) as Record<string, unknown>;
      } catch {
        return fail('INVALID_ARGUMENTS', 'Tool arguments must be valid JSON');
      }
      return registry.execute(toolName, args);
    },
    execute: registry.execute,
    isToolAvailable: (toolName: string) => TELEGRAM_TOOL_NAMES.includes(toolName as TelegramToolName),
    listTools: () => registry.schemas.map((schema) => ({
      name: schema.function.name,
      description: schema.function.description,
    })),
  };
}
