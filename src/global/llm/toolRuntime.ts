/**
 * Internal AI adapter for the canonical Telegram tool registry.
 *
 * The external MCP/WebMCP transport uses the same registry from
 * `src/mcp/telegramTools`. This file only adapts the existing internal AI
 * function-calling API and the authenticated browser `callApi` bridge.
 */

import type { ApiChat } from '../../api/types/chats';
import { ApiMediaFormat, MAIN_THREAD_ID } from '../../api/types';

import { ARCHIVED_FOLDER_ID } from '../../config';
import { callApi } from '../../api/gramjs';
import {
  createTelegramToolRuntime,
  type TelegramToolHandlers,
  type TelegramToolResult,
} from '../../mcp/telegramTools';
import { createCorrelationId } from '../../mcp/telegramTools/audit';
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
  draftId?: string;
  payloadHash?: string;
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
    resolveChat: (chatId) => {
      const global = getGlobal();
      return selectChat(global, String(chatId));
    },
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
    sendMessage: async (args) => {
      const {
        chat, text, replyInfo, isSilent, mcpAuditContext, isActive, checkActive,
      } = args as {
        chat: ApiChat;
        text: string;
        replyInfo?: import('../../api/types/messages').ApiInputReplyInfo;
        isSilent?: boolean;
        mcpAuditContext?: {
          correlationId?: string;
          transport?: string;
          abortControllerGroup?: string;
        };
        isActive?: () => boolean;
        checkActive?: () => Promise<boolean>;
      };
      if (isActive && !isActive()) throw new Error('MCP connection is disabled');
      if (checkActive && !(await checkActive())) throw new Error('MCP connection is disabled');
      return callApi('sendMessage', {
        chat,
        text,
        replyInfo,
        isSilent,
        mcpAuditContext,
      });
    },
    editMessage: async (args) => {
      const {
        chat, message, text,
      } = args as {
        chat: ApiChat;
        message: import('../../api/types/messages').ApiMessage;
        text: string;
      };
      return callApi('editMessage', { chat, message, text });
    },
    downloadMedia: async (args) => {
      const { media, maxBytes } = args as {
        media: { source?: string };
        maxBytes: number;
      };
      if (!media.source) throw new Error('Provider has no media source');
      const result = await callApi('downloadMedia', {
        url: media.source,
        mediaFormat: ApiMediaFormat.Progressive,
        start: 0,
        end: maxBytes - 1,
      });
      return result;
    },
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
      data: JSON.stringify(result.data, undefined, 2),
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
  let parsedArguments: Record<string, unknown> | undefined;
  try {
    parsedArguments = JSON.parse(argumentsJson) as Record<string, unknown>;
  } catch {
    // The canonical runtime returns the structured invalid-arguments result.
  }
  const isMutating = toolName === 'send'
    || toolName === 'edit_message'
    || (toolName === 'read' && parsedArguments?.mark_read === true);
  if (isMutating) {
    const message = toolName === 'send'
      ? 'Tool "send" will send a Telegram message. Execute?'
      : toolName === 'edit_message'
        ? 'Tool "edit_message" will edit a Telegram message. Execute?'
        : 'Tool "read" will mark Telegram messages as read. Execute?';
    const sessionId = `internal-ai-${createCorrelationId()}`;
    const context = {
      transport: 'internal-ai',
      harness: 'internal-ai',
      actor: 'user',
      sessionId,
      allowWrite: true,
    };
    const draft = toolName === 'send' || toolName === 'edit_message'
      ? await runtime.createMutationDraft(toolName, parsedArguments || {})
      : undefined;
    if (!onConfirmationRequired) {
      return {
        success: false,
        error: 'Mutating tools require explicit user confirmation',
        requiresConfirmation: true,
        confirmationMessage: draft?.confirmation_text || message,
        draftId: draft?.draft_id,
        payloadHash: draft?.payload_hash,
      };
    }
    const exactConfirmation = draft?.confirmation_text || message;
    if (!(await onConfirmationRequired(exactConfirmation))) {
      return { success: false, error: 'Execution denied by user' };
    }
    const evidence = draft
      ? await runtime.confirmMutation(draft.draft_id, exactConfirmation, context)
      : undefined;
    if (draft && (!evidence || !evidence.ok)) {
      return { success: false, error: 'Failed to persist mutation evidence' };
    }
    const nextArguments = draft && evidence?.ok
      ? { ...parsedArguments, confirmation: evidence.data }
      : parsedArguments;
    return toToolResult(await runtime.executeToolCall(toolName, JSON.stringify(nextArguments), context));
  }

  return toToolResult(await runtime.executeToolCall(toolName, argumentsJson, {
    transport: 'internal-ai',
    harness: 'internal-ai',
    actor: 'user',
    sessionId: `internal-ai-${createCorrelationId()}`,
    allowWrite: isMutating,
  }));
}

export function isToolAvailable(toolName: string): boolean {
  return runtime.isToolAvailable(toolName);
}

export function getToolCategory(toolName: string): ToolDefinition['category'] | undefined {
  if (!runtime.isToolAvailable(toolName)) return undefined;
  return toolName === 'send' || toolName === 'edit_message' ? 'mutating' : 'read';
}

export function listTools(): Array<{ name: string; description: string; category: string }> {
  return runtime.listTools().map((tool) => ({
    ...tool,
    category: tool.name === 'send' || tool.name === 'edit_message' ? 'mutating' : 'read',
  }));
}
