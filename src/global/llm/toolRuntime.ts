/**
 * Internal AI adapter for the canonical Telegram tool registry.
 *
 * The external MCP/WebMCP transport uses the same registry from
 * `src/mcp/telegramTools`. This file only adapts the existing internal AI
 * function-calling API and the authenticated browser `callApi` bridge.
 */

import { callApi } from '../../api/gramjs';
import type { ApiChat } from '../../api/types/chats';
import { MAIN_THREAD_ID } from '../../api/types';
import { ARCHIVED_FOLDER_ID } from '../../config';
import {
  createTelegramToolRuntime,
  type TelegramToolHandlers,
  type TelegramToolResult,
} from '../../mcp/telegramTools';
import { getGlobal } from '../index';
import { selectChat } from '../selectors';

export interface ToolDefinition {
  name: string;
  description: string;
  category: 'read' | 'mutating';
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  data?: string;
  error?: string;
  requiresConfirmation?: boolean;
  confirmationMessage?: string;
}

export interface OpenAiTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

function createBrowserHandlers(): TelegramToolHandlers {
  async function addUnreadFlags(chat: ApiChat, raw: unknown, enabled: boolean) {
    if (!enabled || !raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const chatList = await callApi('fetchChats', {
      limit: 100,
      folderId: chat.folderId === ARCHIVED_FOLDER_ID ? ARCHIVED_FOLDER_ID : undefined,
      withPinned: false,
    });
    const lastReadInboxMessageId = chatList?.threadReadStatesById?.[chat.id]?.lastReadInboxMessageId;
    const messages = Array.isArray((raw as { messages?: unknown }).messages)
      ? (raw as { messages: Array<Record<string, unknown>> }).messages
      : [];
    return {
      ...raw,
      messages: messages.map((message) => ({
        ...message,
        isUnread: lastReadInboxMessageId !== undefined
          && !message.isOutgoing
          && Number(message.id) > lastReadInboxMessageId,
      })),
    };
  }

  return {
    listChats: (args) => {
      const { folder, limit } = args as { folder?: string; limit: number };
      const folderId = folder && folder !== 'main' && folder !== 'archive'
        ? Number(folder)
        : undefined;
      if (folderId !== undefined && (!Number.isInteger(folderId) || folderId < 1)) {
        throw new Error('folder must be main, archive, or a positive Telegram folder id');
      }
      return callApi('fetchChats', {
        limit,
        archived: folder === 'archive',
        folderId: folder === 'archive' ? ARCHIVED_FOLDER_ID : folderId,
        withPinned: true,
      });
    },
    resolveChat: (chatId) => selectChat(getGlobal(), String(chatId)),
    fetchMessagesById: (args) => callApi('fetchMessagesById', args as {
      chat: ApiChat;
      messageIds: number[];
    }),
    fetchMessages: (args) => {
      const { chat, limit, from, to, unreadOnly } = args as {
        chat: ApiChat; limit: number; from?: string; to?: string; unreadOnly?: boolean;
      };
      const result = from || to
        ? callApi('searchMessagesInChat', {
          peer: chat,
          query: '',
          limit,
          threadId: MAIN_THREAD_ID,
          minDate: from ? Math.floor(Date.parse(from) / 1000) : undefined,
          maxDate: to ? Math.floor(Date.parse(to) / 1000) : undefined,
        })
        : callApi('fetchMessages', {
          chat,
          threadId: MAIN_THREAD_ID,
          limit,
        });
      return result.then((raw) => addUnreadFlags(chat, raw, Boolean(unreadOnly)));
    },
    searchMessages: (args) => {
      const { chat, query, limit, from, to, unreadOnly } = args as {
        chat: ApiChat; query: string; limit: number; from?: string; to?: string; unreadOnly?: boolean;
      };
      const result = callApi('searchMessagesInChat', {
        peer: chat,
        query,
        limit,
        threadId: MAIN_THREAD_ID,
        minDate: from ? Math.floor(Date.parse(from) / 1000) : undefined,
        maxDate: to ? Math.floor(Date.parse(to) / 1000) : undefined,
      });
      return result.then((raw) => addUnreadFlags(chat, raw, Boolean(unreadOnly)));
    },
    fetchFullChat: (chat) => callApi('fetchFullChat', chat as ApiChat),
    markMessageListRead: (args) => {
      const { chat, maxId } = args as { chat: ApiChat; maxId: number };
      return callApi('markMessageListRead', { chat, threadId: MAIN_THREAD_ID, maxId });
    },
    markMessagesRead: (args) => callApi('markMessagesRead', args as {
      chat: ApiChat;
      messageIds: number[];
    }),
    sendMessage: (args) => callApi('sendMessage', args as {
      chat: ApiChat;
      text: string;
      replyInfo?: import('../../api/types/messages').ApiInputReplyInfo;
      isSilent?: boolean;
    }),
  };
}

const runtime = createTelegramToolRuntime(createBrowserHandlers());

/** Canonical runtime used by both the internal AI and browser MCP bridge. */
export function getCanonicalTelegramToolRuntime() {
  return runtime;
}

function toToolResult(result: TelegramToolResult): ToolResult {
  if (result.ok) {
    return {
      success: true,
      data: JSON.stringify(result.data, null, 2),
    };
  }
  return {
    success: false,
    error: `${result.error.code}: ${result.error.message}`,
  };
}

export function getToolSchemas(): OpenAiTool[] {
  return runtime.getToolSchemas();
}

export async function executeToolCall(
  toolName: string,
  argumentsJson: string,
  onConfirmationRequired?: (message: string) => Promise<boolean>,
): Promise<ToolResult> {
  if (toolName === 'send') {
    const message = 'Tool "send" will send a Telegram message. Execute?';
    if (!onConfirmationRequired) {
      return {
        success: false,
        error: 'Mutating tools require explicit user confirmation',
        requiresConfirmation: true,
        confirmationMessage: message,
      };
    }
    if (!(await onConfirmationRequired(message))) {
      return { success: false, error: 'Execution denied by user' };
    }
  }

  return toToolResult(await runtime.executeToolCall(toolName, argumentsJson));
}

export function isToolAvailable(toolName: string): boolean {
  return runtime.isToolAvailable(toolName);
}

export function getToolCategory(toolName: string): ToolDefinition['category'] | undefined {
  if (!runtime.isToolAvailable(toolName)) return undefined;
  return toolName === 'send' ? 'mutating' : 'read';
}

export function listTools(): Array<{ name: string; description: string; category: string }> {
  return runtime.listTools().map((tool) => ({
    ...tool,
    category: tool.name === 'send' ? 'mutating' : 'read',
  }));
}
