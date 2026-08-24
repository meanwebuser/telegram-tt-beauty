import type { ApiChat } from '../../api/types/chats';
import type { ApiInputReplyInfo, ApiMessage } from '../../api/types/messages';

import {
  consoleAuditSink,
  createCorrelationId,
  emitTelegramAudit,
  type TelegramAuditSink,
  type TelegramToolExecutionContext,
} from './audit';
import {
  createDurableMutationEvidenceStore,
  createMutationConfirmationText,
  createMutationEvidenceId,
  hashBytes,
  hashPayload,
  negotiateTelegramCapabilities,
  TELEGRAM_CAPABILITIES,
  type TelegramCapability,
  type TelegramMediaContent,
  type TelegramMediaDescriptor,
  type TelegramMediaDownloadReceipt,
  type TelegramMediaType,
  type TelegramMutationConfirmation,
  type TelegramMutationDraft,
  type TelegramMutationEvidence,
  type TelegramMutationEvidenceStore,
} from './capabilities';
import { createRuntimeOwnerQueue } from './runtimeOwner';

export const TELEGRAM_TOOL_NAMES = [
  'capabilities', 'chats', 'read', 'send', 'edit_message',
  'media.inspect', 'media.read', 'media.download', 'mutation.confirm',
] as const;
export type TelegramToolName = (typeof TELEGRAM_TOOL_NAMES)[number];

export type TelegramToolErrorCode =
  | 'INVALID_ARGUMENTS'
  | 'MUTUALLY_EXCLUSIVE_MODES'
  | 'CHAT_NOT_FOUND'
  | 'COMMENTS_DISABLED'
  | 'NO_DISCUSSION_GROUP'
  | 'CHAT_WRITE_FORBIDDEN'
  | 'CHANNEL_POST_PERMISSION_REQUIRED'
  | 'WRITE_DISABLED'
  | 'MCP_DISABLED'
  | 'CAPABILITY_UNSUPPORTED'
  | 'MESSAGE_NOT_FOUND'
  | 'MEDIA_NOT_FOUND'
  | 'MEDIA_UNSUPPORTED'
  | 'MEDIA_LIMIT_EXCEEDED'
  | 'CONFIRMATION_REQUIRED'
  | 'EVIDENCE_INVALID'
  | 'REPLAY_DETECTED'
  | 'EDIT_FAILED'
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
  folder?: string;
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
  confirmation?: TelegramMutationConfirmation;
}

export interface EditMessageArgs {
  chat_id: string;
  message_id: number;
  text?: string;
  caption?: string;
  confirmation?: TelegramMutationConfirmation;
}

export interface MediaArgs {
  chat_id: string;
  message_id: number;
  max_bytes?: number;
}

export interface CapabilityArgs {
  requested?: string[];
}

export interface ToolSchemas {
  type: 'function';
  function: {
    name: TelegramToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
}

type UnknownHandler = (args: unknown) => unknown;

export interface TelegramToolRegistryOptions {
  audit?: TelegramAuditSink;
  evidenceStore?: TelegramMutationEvidenceStore;
  capabilities?: TelegramCapability[];
}

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
  editMessage?: UnknownHandler;
  downloadMedia?: UnknownHandler;
}

interface ChatListData {
  chats?: ApiChat[];
  messages?: ApiMessage[];
  threadReadStatesById?: Record<string, { unreadCount?: number; lastReadInboxMessageId?: number }>;
  lastMessageByChatId?: Record<string, number>;
  orderedPinnedIds?: string[];
}

const schemas: ToolSchemas[] = [
  {
    type: 'function',
    function: {
      name: 'capabilities',
      description: 'Negotiate the provider-neutral Telegram MCP capability contract.',
      parameters: {
        type: 'object',
        properties: {
          requested: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    },
  },
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
          confirmation: {
            type: 'object',
            properties: {
              draft_id: { type: 'string' },
              evidence_id: { type: 'string' },
              payload_hash: { type: 'string' },
              confirmation_text: { type: 'string' },
            },
            required: ['draft_id', 'evidence_id', 'payload_hash', 'confirmation_text'],
            additionalProperties: false,
          },
        },
        required: ['chat_id', 'text'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_message',
      description: 'Edit an existing Telegram message text or media caption after exact human confirmation.',
      parameters: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          message_id: { type: 'integer' },
          text: { type: 'string' },
          caption: { type: 'string' },
          confirmation: {
            type: 'object',
            properties: {
              draft_id: { type: 'string' },
              evidence_id: { type: 'string' },
              payload_hash: { type: 'string' },
              confirmation_text: { type: 'string' },
            },
            required: ['draft_id', 'evidence_id', 'payload_hash', 'confirmation_text'],
            additionalProperties: false,
          },
        },
        required: ['chat_id', 'message_id'],
        anyOf: [{ required: ['text'] }, { required: ['caption'] }],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'media.inspect',
      description: 'Inspect bounded metadata for media attached to an incoming Telegram message.',
      parameters: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          message_id: { type: 'integer' },
        },
        required: ['chat_id', 'message_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'media.read',
      description: 'Read a bounded media representation without returning unbounded binary data.',
      parameters: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          message_id: { type: 'integer' },
        },
        required: ['chat_id', 'message_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'media.download',
      description: 'Download bounded Telegram media and return only a checksum-bound opaque receipt.',
      parameters: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          message_id: { type: 'integer' },
          max_bytes: { type: 'integer', minimum: 1, maximum: 52428800, default: 10485760 },
        },
        required: ['chat_id', 'message_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mutation.confirm',
      description: 'Persist exact human confirmation evidence for one Telegram send or edit draft.',
      parameters: {
        type: 'object',
        properties: {
          draft_id: { type: 'string' },
          confirmation_text: { type: 'string' },
        },
        required: ['draft_id', 'confirmation_text'],
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
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('limit must be a positive integer');
  }
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
  const media = getMediaDescriptor(message);
  return {
    id: message.id,
    chat_id: message.chatId,
    date: new Date(message.date * 1000).toISOString(),
    text: messageText(message),
    sender_id: message.senderId,
    outgoing: message.isOutgoing,
    unread: extra.isUnread,
    media: media ? toPublicMediaDescriptor(media) : undefined,
  };
}

function extractMessages(value: unknown): ApiMessage[] {
  if (Array.isArray(value)) return value as ApiMessage[];
  const messages = asRecord(value).messages;
  return Array.isArray(messages) ? messages as ApiMessage[] : [];
}

function validateRead(args: ReadArgs): TelegramToolResult<ReadArgs> {
  if (!args || typeof args.chat_id !== 'string' || !args.chat_id) {
    return fail('INVALID_ARGUMENTS', 'chat_id is required');
  }
  const idsMode = args.ids !== undefined;
  const otherModes = args.query !== undefined
    || args.from !== undefined
    || args.to !== undefined
    || args.unread_only === true;
  if (idsMode && otherModes) {
    return fail('MUTUALLY_EXCLUSIVE_MODES', 'ids cannot be combined with query, date range, or unread_only');
  }
  if (args.ids && (!Array.isArray(args.ids) || args.ids.some((id) => !Number.isInteger(id)))) {
    return fail('INVALID_ARGUMENTS', 'ids must be an array of integers');
  }
  return { ok: true, data: args };
}

const MAX_MEDIA_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const DEFAULT_MEDIA_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const MAX_MEDIA_PREVIEW_CHARACTERS = 256 * 1024;

type InternalMediaDescriptor = TelegramMediaDescriptor & {
  source?: string;
  preview_data_uri?: string;
  metadata: Record<string, unknown>;
};

function getMediaType(key: string, value: Record<string, unknown>): TelegramMediaType {
  if (key === 'photo') return 'image';
  if (key === 'video') return 'video';
  if (key === 'audio') return 'audio';
  if (key === 'voice') return 'voice';
  if (key === 'document') {
    const mimeType = typeof value.mimeType === 'string' ? value.mimeType : '';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    return 'document';
  }
  return 'unknown';
}

function getMediaSource(type: TelegramMediaType, id: string) {
  return type === 'image' ? `photo${id}` : `document${id}`;
}

function getMediaDescriptor(message: ApiMessage): InternalMediaDescriptor | undefined {
  const content = message.content || {};
  const mediaKeys = ['photo', 'video', 'audio', 'voice', 'document'];
  const mediaEntry = mediaKeys
    .map((key) => ({ key, value: content[key as keyof typeof content] }))
    .find(({ value }) => value && typeof value === 'object');
  if (!mediaEntry) {
    const unknownEntry = Object.entries(content).find(([key, value]) => (
      key !== 'text' && value && typeof value === 'object'
    ));
    if (!unknownEntry) return undefined;
    const [key, value] = unknownEntry;
    const unknownValue = value as Record<string, unknown>;
    return {
      media_id: `${message.chatId}:${message.id}:${key}`,
      type: 'unknown',
      name: typeof unknownValue.fileName === 'string' ? unknownValue.fileName : undefined,
      mime_type: typeof unknownValue.mimeType === 'string' ? unknownValue.mimeType : undefined,
      size: typeof unknownValue.size === 'number' ? unknownValue.size : undefined,
      preview_available: false,
      metadata: { media_key: key },
    };
  }

  const { key, value } = mediaEntry;
  const media = value as Record<string, unknown>;
  const type = getMediaType(key, media);
  const id = typeof media.id === 'string' || typeof media.id === 'number'
    ? String(media.id)
    : `${message.chatId}:${message.id}`;
  const preview = media.thumbnail && typeof media.thumbnail === 'object'
    ? (media.thumbnail as Record<string, unknown>).dataUri
    : media.previewBlobUrl;
  const previewDataUri = typeof preview === 'string' ? preview : undefined;
  const metadata = Object.fromEntries(Object.entries(media).filter(([field]) => (
    ['duration', 'width', 'height', 'isRound', 'isGif', 'supportsStreaming', 'title', 'performer'].includes(field)
  )));
  return {
    media_id: `${message.chatId}:${message.id}:${id}`,
    type,
    name: typeof media.fileName === 'string' ? media.fileName : undefined,
    mime_type: typeof media.mimeType === 'string' ? media.mimeType : type === 'image' ? 'image/jpeg' : undefined,
    size: typeof media.size === 'number' ? media.size : undefined,
    preview_available: Boolean(previewDataUri),
    source: getMediaSource(type, id),
    preview_data_uri: previewDataUri,
    metadata,
  };
}

function toPublicMediaDescriptor(media: InternalMediaDescriptor): TelegramMediaDescriptor {
  return {
    media_id: media.media_id,
    type: media.type,
    name: media.name,
    mime_type: media.mime_type,
    size: media.size,
    preview_available: media.preview_available,
  };
}

function buildMediaContent(media: InternalMediaDescriptor): TelegramMediaContent {
  const boundedPreview = media.preview_data_uri && media.preview_data_uri.length <= MAX_MEDIA_PREVIEW_CHARACTERS
    ? media.preview_data_uri
    : undefined;
  if (media.type === 'audio' || media.type === 'voice') {
    return {
      kind: media.type,
      metadata: media.metadata,
      transcript: { status: 'transcription_unavailable' },
    };
  }
  if (media.type === 'unknown') {
    return { kind: media.type, status: 'unsupported' };
  }
  return {
    kind: media.type,
    preview_available: media.preview_available,
    preview_data_uri: boundedPreview,
    metadata: media.metadata,
  };
}

function asBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value && typeof value === 'object' && 'buffer' in value) {
    const buffer = (value as { buffer?: unknown }).buffer;
    if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  }
  return undefined;
}

function isMutationTool(name: string, args?: Record<string, unknown>) {
  return name === 'send'
    || name === 'edit_message'
    || name === 'mutation.confirm'
    || (name === 'read' && args?.mark_read === true);
}

function mutationAction(name: string): TelegramMutationDraft['action'] | undefined {
  if (name === 'send' || name === 'edit_message') return name;
  return undefined;
}

function mutationPayload(name: string, args: Record<string, unknown>) {
  if (name === 'send') {
    return {
      chat_id: args.chat_id,
      text: args.text,
      reply_to: args.reply_to,
      comment_to: args.comment_to,
      topic_id: args.topic_id,
      silent: args.silent,
    };
  }
  return {
    chat_id: args.chat_id,
    message_id: args.message_id,
    text: args.text === undefined ? args.caption : args.text,
  };
}

export function createTelegramToolRegistry(
  handlers: TelegramToolHandlers,
  options: TelegramToolRegistryOptions = {},
) {
  const audit = options.audit || consoleAuditSink;
  const evidenceStore = options.evidenceStore || createDurableMutationEvidenceStore();
  const drafts = new Map<string, { draft: TelegramMutationDraft; payload: Record<string, unknown> }>();
  const supportedCapabilities = options.capabilities || [
    ...TELEGRAM_CAPABILITIES.filter((capability) => {
      if (capability === 'messages.edit') return Boolean(handlers.editMessage);
      if (capability === 'media.download') return Boolean(handlers.downloadMedia);
      return true;
    }),
  ];

  async function createDraft(
    action: TelegramMutationDraft['action'],
    payload: Record<string, unknown>,
  ): Promise<TelegramMutationDraft> {
    const payloadHash = await hashPayload(payload);
    const draft = {
      draft_id: `draft-${createCorrelationId()}`,
      action,
      payload_hash: payloadHash,
      confirmation_text: createMutationConfirmationText(action, payloadHash),
      created_at: new Date().toISOString(),
    } satisfies TelegramMutationDraft;
    drafts.set(draft.draft_id, { draft, payload });
    return draft;
  }

  async function confirmDraft(
    draftId: string,
    confirmationText: string,
    context: TelegramToolExecutionContext,
  ): Promise<TelegramToolResult<TelegramMutationConfirmation>> {
    const stored = drafts.get(draftId);
    if (!stored || stored.draft.confirmation_text !== confirmationText) {
      return fail('EVIDENCE_INVALID', 'Draft or exact confirmation text is invalid');
    }
    const actor = context.actor;
    const sessionId = context.sessionId;
    const harness = context.harness || context.transport;
    if (!actor || !sessionId || !harness) {
      return fail('EVIDENCE_INVALID', 'Actor, session, and harness are required for confirmation evidence');
    }
    const evidenceId = createMutationEvidenceId();
    const evidence: TelegramMutationEvidence = {
      evidence_id: evidenceId,
      draft_id: stored.draft.draft_id,
      action: stored.draft.action,
      payload_hash: stored.draft.payload_hash,
      actor,
      session_id: sessionId,
      harness,
      confirmation_text: confirmationText,
      ts: new Date().toISOString(),
      state: 'confirmed',
    };
    await evidenceStore.append(evidence);
    return {
      ok: true,
      data: {
        draft_id: stored.draft.draft_id,
        evidence_id: evidenceId,
        payload_hash: stored.draft.payload_hash,
        confirmation_text: confirmationText,
      },
    };
  }

  async function claimEvidence(
    action: TelegramMutationDraft['action'],
    payload: Record<string, unknown>,
    confirmation: TelegramMutationConfirmation | undefined,
    context: TelegramToolExecutionContext,
  ): Promise<TelegramToolResult<TelegramMutationEvidence>> {
    if (!confirmation) {
      const draft = await createDraft(action, payload);
      return { ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: JSON.stringify({ draft }) } };
    }
    const evidence = await evidenceStore.read(confirmation.evidence_id);
    const payloadHash = await hashPayload(payload);
    if (!evidence || evidence.state !== 'confirmed') {
      return fail('REPLAY_DETECTED', 'Missing or already consumed mutation evidence');
    }
    if (
      evidence.draft_id !== confirmation.draft_id
      || evidence.action !== action
      || evidence.payload_hash !== payloadHash
      || confirmation.payload_hash !== payloadHash
      || evidence.confirmation_text !== confirmation.confirmation_text
      || evidence.confirmation_text !== createMutationConfirmationText(action, payloadHash)
      || evidence.actor !== context.actor
      || evidence.session_id !== context.sessionId
      || evidence.harness !== (context.harness || context.transport)
    ) {
      return fail('EVIDENCE_INVALID', 'Mutation payload, actor, session, harness, or confirmation does not match');
    }
    const claimed = { ...evidence, state: 'claimed' as const, ts: new Date().toISOString() };
    await evidenceStore.append(claimed);
    return { ok: true, data: claimed };
  }

  async function completeEvidence(evidence: TelegramMutationEvidence, ok: boolean, receipt?: string) {
    await evidenceStore.append({
      ...evidence,
      state: ok ? 'completed' : 'failed',
      result_receipt: receipt,
      ts: new Date().toISOString(),
    });
  }

  async function auditTool(
    event: 'mcp_call_start' | 'mcp_call_end',
    name: string,
    input: Record<string, unknown>,
    context: TelegramToolExecutionContext,
    result?: TelegramToolResult,
  ) {
    await emitTelegramAudit(audit, {
      event,
      context,
      tool: name,
      chat_id: typeof input.chat_id === 'string' ? input.chat_id : undefined,
      text: typeof input.text === 'string' ? input.text : undefined,
      payload_hash: typeof input.payload_hash === 'string' ? input.payload_hash : undefined,
      ok: result?.ok,
      error_code: result && !result.ok ? result.error.code : undefined,
    });
  }

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
        const lastMessage = messages.find((message) => (
          message.chatId === chat.id && (lastMessageId === undefined || message.id === lastMessageId)
        ));
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
        raw = await handlers.fetchMessages({
          chat,
          limit,
          order: args.order || 'newest',
          from: args.from,
          to: args.to,
          unreadOnly: args.unread_only,
        });
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
      return {
        ok: true,
        data: {
          chat_id: chat.id,
          messages: messages.map(serializeMessage),
          marked_read: Boolean(args.mark_read && messages.length),
        },
      };
    } catch (error) {
      return fail('EXECUTION_FAILED', error instanceof Error ? error.message : 'read failed');
    }
  }

  async function resolveMessage(chatId: string, messageId: number) {
    const chat = await handlers.resolveChat(chatId) as ApiChat | undefined;
    if (!chat) return { chat: undefined, message: undefined };
    const raw = await handlers.fetchMessagesById({ chat, messageIds: [messageId] });
    const message = extractMessages(raw).find((candidate) => candidate.id === messageId);
    return { chat, message };
  }

  function executeCapabilities(input: CapabilityArgs = {}): TelegramToolResult {
    const requested = input.requested;
    if (requested && (!Array.isArray(requested) || requested.some((capability) => typeof capability !== 'string'))) {
      return fail('INVALID_ARGUMENTS', 'requested must be an array of capability names');
    }
    return {
      ok: true,
      data: negotiateTelegramCapabilities(supportedCapabilities, requested),
    };
  }

  async function executeMediaInspect(input: MediaArgs): Promise<TelegramToolResult> {
    if (!input || typeof input.chat_id !== 'string' || !Number.isInteger(input.message_id)) {
      return fail('INVALID_ARGUMENTS', 'chat_id and message_id are required');
    }
    if (!supportedCapabilities.includes('media.inspect')) {
      return fail('CAPABILITY_UNSUPPORTED', 'media.inspect is unsupported');
    }
    try {
      const { chat, message } = await resolveMessage(input.chat_id, input.message_id);
      if (!chat) return fail('CHAT_NOT_FOUND', `Chat not found: ${input.chat_id}`);
      if (!message) return fail('MESSAGE_NOT_FOUND', `Message not found: ${input.message_id}`);
      const media = getMediaDescriptor(message);
      if (!media) return fail('MEDIA_NOT_FOUND', `Message ${input.message_id} has no media`);
      return { ok: true, data: { chat_id: chat.id, message_id: message.id, media: toPublicMediaDescriptor(media) } };
    } catch (error) {
      return fail('EXECUTION_FAILED', error instanceof Error ? error.message : 'media inspect failed');
    }
  }

  async function executeMediaRead(input: MediaArgs): Promise<TelegramToolResult> {
    if (!input || typeof input.chat_id !== 'string' || !Number.isInteger(input.message_id)) {
      return fail('INVALID_ARGUMENTS', 'chat_id and message_id are required');
    }
    if (!supportedCapabilities.includes('media.read')) {
      return fail('CAPABILITY_UNSUPPORTED', 'media.read is unsupported');
    }
    try {
      const { chat, message } = await resolveMessage(input.chat_id, input.message_id);
      if (!chat) return fail('CHAT_NOT_FOUND', `Chat not found: ${input.chat_id}`);
      if (!message) return fail('MESSAGE_NOT_FOUND', `Message not found: ${input.message_id}`);
      const media = getMediaDescriptor(message);
      if (!media) return fail('MEDIA_NOT_FOUND', `Message ${input.message_id} has no media`);
      return {
        ok: true,
        data: {
          chat_id: chat.id,
          message_id: message.id,
          media: toPublicMediaDescriptor(media),
          content: buildMediaContent(media),
        },
      };
    } catch (error) {
      return fail('EXECUTION_FAILED', error instanceof Error ? error.message : 'media read failed');
    }
  }

  async function executeMediaDownload(
    input: MediaArgs,
    context: TelegramToolExecutionContext,
  ): Promise<TelegramToolResult<TelegramMediaDownloadReceipt>> {
    if (!input || typeof input.chat_id !== 'string' || !Number.isInteger(input.message_id)) {
      return fail('INVALID_ARGUMENTS', 'chat_id and message_id are required');
    }
    if (!supportedCapabilities.includes('media.download') || !handlers.downloadMedia) {
      return fail('CAPABILITY_UNSUPPORTED', 'media.download is unsupported by this provider');
    }
    try {
      const maxBytes = boundedInteger(input.max_bytes, DEFAULT_MEDIA_DOWNLOAD_BYTES, MAX_MEDIA_DOWNLOAD_BYTES);
      const { chat, message } = await resolveMessage(input.chat_id, input.message_id);
      if (!chat) return fail('CHAT_NOT_FOUND', `Chat not found: ${input.chat_id}`);
      if (!message) return fail('MESSAGE_NOT_FOUND', `Message not found: ${input.message_id}`);
      const media = getMediaDescriptor(message);
      if (!media) return fail('MEDIA_NOT_FOUND', `Message ${input.message_id} has no media`);
      if (media.type === 'unknown') return fail('MEDIA_UNSUPPORTED', 'This media type is unsupported');
      await emitTelegramAudit(audit, {
        event: 'telegram_media_download_start',
        context,
        tool: 'media.download',
        chat_id: chat.id,
      });
      try {
        const raw = await handlers.downloadMedia({ chat, message, media, maxBytes });
        const rawRecord = asRecord(raw);
        const bytes = asBytes(rawRecord.arrayBuffer || rawRecord.data || raw);
        if (!bytes) throw new Error('Provider returned no bounded media bytes');
        if (bytes.byteLength > maxBytes) throw new Error('Media exceeds the requested byte limit');
        const checksum = await hashBytes(bytes);
        const receipt = `download-${createCorrelationId()}`;
        await emitTelegramAudit(audit, {
          event: 'telegram_media_download_end',
          context,
          tool: 'media.download',
          chat_id: chat.id,
          ok: true,
        });
        return {
          ok: true,
          data: {
            media_id: media.media_id,
            type: media.type,
            name: media.name,
            mime_type: media.mime_type,
            size: bytes.byteLength,
            checksum: { algorithm: 'sha256', value: checksum },
            receipt,
            local_path: typeof rawRecord.localPath === 'string' ? rawRecord.localPath : undefined,
          },
        };
      } catch (error) {
        await emitTelegramAudit(audit, {
          event: 'telegram_media_download_end',
          context,
          tool: 'media.download',
          chat_id: chat.id,
          ok: false,
          error_code: error instanceof Error && error.message.includes('limit')
            ? 'MEDIA_LIMIT_EXCEEDED' : 'DOWNLOAD_FAILED',
        });
        throw error;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'media download failed';
      return fail(message.includes('exceeds') ? 'MEDIA_LIMIT_EXCEEDED' : 'EXECUTION_FAILED', message);
    }
  }

  async function executeEdit(
    input: EditMessageArgs,
    context: TelegramToolExecutionContext,
  ): Promise<TelegramToolResult> {
    if (!input || typeof input.chat_id !== 'string' || !Number.isInteger(input.message_id)) {
      return fail('INVALID_ARGUMENTS', 'chat_id and message_id are required');
    }
    if ((input.text === undefined) === (input.caption === undefined)) {
      return fail('INVALID_ARGUMENTS', 'Exactly one of text or caption is required');
    }
    if (!supportedCapabilities.includes('messages.edit') || !handlers.editMessage) {
      return fail('CAPABILITY_UNSUPPORTED', 'messages.edit is unsupported by this provider');
    }
    const text = input.text === undefined ? input.caption! : input.text;
    const payload = {
      chat_id: input.chat_id,
      message_id: input.message_id,
      text,
    };
    const confirmation = input.confirmation || context.mutationConfirmation;
    const claimed = await claimEvidence('edit_message', payload, confirmation, context);
    if (!claimed.ok) return claimed;
    try {
      const { chat, message } = await resolveMessage(input.chat_id, input.message_id);
      if (!chat) {
        await completeEvidence(claimed.data, false);
        return fail('CHAT_NOT_FOUND', `Chat not found: ${input.chat_id}`);
      }
      if (!message) {
        await completeEvidence(claimed.data, false);
        return fail('MESSAGE_NOT_FOUND', `Message not found: ${input.message_id}`);
      }
      await emitTelegramAudit(audit, {
        event: 'telegram_edit_start',
        context,
        tool: 'edit_message',
        chat_id: chat.id,
        payload_hash: claimed.data.payload_hash,
      });
      const edited = await handlers.editMessage({ chat, message, text, mcpAuditContext: context });
      const receipt = `edit-${createCorrelationId()}`;
      await completeEvidence(claimed.data, true, receipt);
      await emitTelegramAudit(audit, {
        event: 'telegram_edit_end',
        context,
        tool: 'edit_message',
        chat_id: chat.id,
        payload_hash: claimed.data.payload_hash,
        ok: true,
      });
      return { ok: true, data: { chat_id: chat.id, message_id: message.id, message: edited, receipt } };
    } catch (error) {
      await completeEvidence(claimed.data, false);
      await emitTelegramAudit(audit, {
        event: 'telegram_edit_end',
        context,
        tool: 'edit_message',
        chat_id: input.chat_id,
        payload_hash: claimed.data.payload_hash,
        ok: false,
        error_code: 'EDIT_FAILED',
      });
      return fail('EDIT_FAILED', error instanceof Error ? error.message : 'edit failed');
    }
  }

  async function executeMutationConfirm(
    input: { draft_id?: string; confirmation_text?: string },
    context: TelegramToolExecutionContext,
  ): Promise<TelegramToolResult> {
    if (typeof input.draft_id !== 'string' || typeof input.confirmation_text !== 'string') {
      return fail('INVALID_ARGUMENTS', 'draft_id and confirmation_text are required');
    }
    return confirmDraft(input.draft_id, input.confirmation_text, context);
  }

  async function executeSend(
    input: SendArgs,
    context: TelegramToolExecutionContext,
  ): Promise<TelegramToolResult> {
    if (!input || typeof input.chat_id !== 'string' || typeof input.text !== 'string' || !input.text) {
      return fail('INVALID_ARGUMENTS', 'chat_id and text are required');
    }
    if (input.reply_to !== undefined && input.comment_to !== undefined) {
      return fail('MUTUALLY_EXCLUSIVE_MODES', 'reply_to and comment_to cannot be combined');
    }
    const payload = {
      chat_id: input.chat_id,
      text: input.text,
      reply_to: input.reply_to,
      comment_to: input.comment_to,
      topic_id: input.topic_id,
      silent: input.silent,
    };
    const claimed = await claimEvidence('send', payload, input.confirmation || context.mutationConfirmation, context);
    if (!claimed.ok) return claimed;
    try {
      const sourceChat = await handlers.resolveChat(input.chat_id) as ApiChat | undefined;
      if (!sourceChat) {
        await completeEvidence(claimed.data, false);
        return fail('CHAT_NOT_FOUND', `Chat not found: ${input.chat_id}`);
      }
      let targetChat = sourceChat;
      let replyId = input.reply_to;
      if (input.comment_to !== undefined) {
        const full = asRecord(await handlers.fetchFullChat(sourceChat));
        const fullInfo = asRecord(full.fullInfo);
        const linkedChatId = fullInfo.linkedChatId;
        const linkedChat = Array.isArray(full.chats)
          ? (full.chats as ApiChat[]).find((chat) => chat.id === linkedChatId)
          : undefined;
        if (!linkedChatId || !linkedChat) {
          await completeEvidence(claimed.data, false);
          return fail('NO_DISCUSSION_GROUP', 'Channel has no linked discussion group');
        }
        targetChat = linkedChat;
        replyId = input.comment_to;
      }
      if (!canSendText(targetChat)) {
        await completeEvidence(claimed.data, false);
        return fail(targetChat.type === 'chatTypeChannel' && !input.comment_to
          ? 'CHANNEL_POST_PERMISSION_REQUIRED' : 'CHAT_WRITE_FORBIDDEN', 'Writing is not allowed in this chat');
      }
      const replyInfo: ApiInputReplyInfo | undefined = replyId === undefined && input.topic_id === undefined
        ? undefined
        : { type: 'message', replyToMsgId: replyId || input.topic_id!, replyToTopId: input.topic_id };
      if (context.checkActive && !(await context.checkActive())) {
        await completeEvidence(claimed.data, false);
        return fail('MCP_DISABLED', 'MCP connection is disabled');
      }
      if (context.isActive && !context.isActive()) {
        await completeEvidence(claimed.data, false);
        return fail('MCP_DISABLED', 'MCP connection is disabled');
      }
      await emitTelegramAudit(audit, {
        event: 'telegram_send_start',
        context,
        tool: 'send',
        chat_id: targetChat.id,
        text: input.text,
        payload_hash: claimed.data.payload_hash,
      });
      try {
        const sent = await handlers.sendMessage({
          chat: targetChat,
          text: input.text,
          replyInfo,
          topicId: input.topic_id,
          isSilent: input.silent,
          mcpAuditContext: {
            correlationId: context.correlationId,
            transport: context.transport,
            abortControllerGroup: context.abortControllerGroup,
          },
          isActive: context.isActive,
          checkActive: context.checkActive,
        });
        await emitTelegramAudit(audit, {
          event: 'telegram_send_end',
          context,
          tool: 'send',
          chat_id: targetChat.id,
          text: input.text,
          payload_hash: claimed.data.payload_hash,
          ok: true,
        });
        await completeEvidence(claimed.data, true, `send-${createCorrelationId()}`);
        return { ok: true, data: { chat_id: targetChat.id, message: sent } };
      } catch (error) {
        await emitTelegramAudit(audit, {
          event: 'telegram_send_end',
          context,
          tool: 'send',
          chat_id: targetChat.id,
          text: input.text,
          payload_hash: claimed.data.payload_hash,
          ok: false,
          error_code: 'SEND_FAILED',
        });
        throw error;
      }
    } catch (error) {
      await completeEvidence(claimed.data, false);
      return fail('EXECUTION_FAILED', error instanceof Error ? error.message : 'send failed');
    }
  }

  return {
    schemas,
    createMutationDraft: async (toolName: string, args: Record<string, unknown>) => {
      const action = mutationAction(toolName);
      if (!action) return undefined;
      return createDraft(action, mutationPayload(toolName, args));
    },
    confirmMutation: (draftId: string, confirmationText: string, context: TelegramToolExecutionContext) => (
      confirmDraft(draftId, confirmationText, context)
    ),
    execute: async (
      name: string,
      args: Record<string, unknown>,
      context: TelegramToolExecutionContext = {},
    ): Promise<TelegramToolResult> => {
      const executionContext = {
        ...context,
        allowWrite: context.allowWrite === true,
        correlationId: context.correlationId || createCorrelationId(),
      };
      await auditTool('mcp_call_start', name, args || {}, executionContext);
      let result: TelegramToolResult;
      const deniedMutation = executionContext.allowWrite === false && isMutationTool(name, args);
      if (deniedMutation) result = fail('WRITE_DISABLED', 'MCP write permission is disabled');
      else if (name === 'capabilities') result = executeCapabilities(args as CapabilityArgs);
      else if (name === 'chats') result = await executeChats(args as ChatsArgs);
      else if (name === 'read') result = await executeRead(args as unknown as ReadArgs);
      else if (name === 'send') result = await executeSend(args as unknown as SendArgs, executionContext);
      else if (name === 'edit_message') {
        result = await executeEdit(args as unknown as EditMessageArgs, executionContext);
      } else if (name === 'media.inspect') result = await executeMediaInspect(args as unknown as MediaArgs);
      else if (name === 'media.read') result = await executeMediaRead(args as unknown as MediaArgs);
      else if (name === 'media.download') {
        result = await executeMediaDownload(args as unknown as MediaArgs, executionContext);
      } else if (name === 'mutation.confirm') {
        result = await executeMutationConfirm(
          args as { draft_id?: string; confirmation_text?: string },
          executionContext,
        );
      } else result = fail('UNKNOWN_TOOL', `Unknown Telegram tool: ${name}`);
      await auditTool('mcp_call_end', name, args || {}, executionContext, result);
      return result;
    },
  };
}

export function createTelegramToolRuntime(handlers: TelegramToolHandlers) {
  const registry = createTelegramToolRegistry(handlers);
  const ownerQueue = createRuntimeOwnerQueue();
  return {
    getToolSchemas: () => registry.schemas,
    executeToolCall: (
      toolName: string,
      argumentsJson: string,
      context?: TelegramToolExecutionContext,
    ) => ownerQueue.enqueue(async () => {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(argumentsJson) as Record<string, unknown>;
      } catch {
        return fail('INVALID_ARGUMENTS', 'Tool arguments must be valid JSON');
      }
      return registry.execute(toolName, args, context);
    }),
    execute: (
      toolName: string,
      args: Record<string, unknown>,
      context?: TelegramToolExecutionContext,
    ) => ownerQueue.enqueue(
      () => registry.execute(toolName, args, context),
    ),
    createMutationDraft: registry.createMutationDraft,
    confirmMutation: registry.confirmMutation,
    isToolAvailable: (toolName: string) => TELEGRAM_TOOL_NAMES.includes(toolName as TelegramToolName),
    listTools: () => registry.schemas.map((schema) => ({
      name: schema.function.name,
      description: schema.function.description,
    })),
  };
}
