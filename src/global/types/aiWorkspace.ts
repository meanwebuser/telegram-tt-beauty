/**
 * AI Workspace types for the client-only AI sidebar.
 *
 * The AI workspace is a private Telegram supergroup with forum mode that stores
 * all AI conversation data. Each source chat maps to a single forum topic.
 */

/**
 * AI workspace state stored in the global state.
 */
export interface AiWorkspaceState {
  /**
   * The service supergroup chat ID where AI conversations are stored.
   * This is a hidden, archived, muted private supergroup with forum mode enabled.
   */
  workspaceChatId?: string;

  /**
   * Maps source chat IDs to their corresponding forum topic IDs in the workspace.
   * Key: Source chat ID (user, chat, or channel)
   * Value: Forum topic ID in the workspace, stored as string for IndexedDB safety.
   */
  topicMappings: Record<string, string>;

  /**
   * Session metadata keyed by topic ID (stringified for IndexedDB compatibility).
   * Contains info about each AI conversation session.
   */
  sessionsByTopicId: Record<string, AiSessionMetadata>;

  /**
   * Last successful sync timestamp.
   * Used to trigger refresh when workspace is accessed from another device.
   */
  lastSync?: number;

  /**
   * Whether the AI sidebar feature is enabled.
   * Defaults to false; user can enable in settings when feature is ready.
   */
  isEnabled: boolean;

  /**
   * Whether workspace initialization is in progress.
   * Prevents multiple concurrent initialization attempts.
   */
  isInitializing?: boolean;

  /**
   * Last initialization error message.
   * Shown to user when workspace setup fails.
   */
  lastInitError?: string;
}

/**
 * Metadata for an AI session stored in the workspace.
 */
export interface AiSessionMetadata {
  /**
   * Unique session identifier (UUID v4).
   */
  sessionId: string;

  /**
   * Source account ID (current user).
   */
  sourceAccountId: string;

  /**
   * Source peer ID (chat, user, or channel) this session is associated with.
   */
  sourcePeerId: string;

  /**
   * Source thread ID (for group threads) or null for main chat.
   */
  sourceThreadId: number | null;

  /**
   * ISO 8601 timestamp when the session was created.
   */
  createdAt: string;

  /**
   * Snapshot of the source chat title at session creation.
   * Used for display in the sidebar.
   */
  titleSnapshot?: string;

  /**
   * Number of messages in this session.
   */
  messageCount: number;
}

/**
 * Lightweight AI topic metadata cached on the client.
 * The authoritative conversation lives in the workspace supergroup; this is
 * a derived view used by the sidebar for listing and selection.
 */
export interface AiTopic {
  /**
   * Forum topic ID inside the workspace supergroup.
   */
  topicId: string;

  /**
   * Source chat ID this topic corresponds to.
   */
  sourceChatId: string;

  /**
   * Optional friendly title for the sidebar.
   */
  title?: string;

  /**
   * UNIX timestamp (ms) when this topic was created.
   */
  createdAt: number;

  /**
   * Number of AI records currently visible in this topic.
   */
  messageCount: number;

  /**
   * True when this topic represents the currently active AI session for its
   * source chat. Mutually exclusive across the workspace.
   */
  isActive?: boolean;
}

/**
 * AI conversation session, reconstructed from envelope records inside a
 * single forum topic. Sessions are immutable once parsed; revoking and
 * resending a prompt creates a new session on the same topic.
 */
export interface AiSession {
  /**
   * Unique session identifier (UUID v4).
   */
  sessionId: string;

  /**
   * Forum topic ID inside the workspace where this session lives.
   */
  topicId: string;

  /**
   * Source chat (user/chat/channel) this AI session belongs to.
   */
  sourceChatId: string;

  /**
   * Source thread ID for group messages, `null` for main chat scope.
   */
  sourceThreadId: number | null;

  /**
   * ISO 8601 timestamp when the session was created.
   */
  createdAt: string;

  /**
   * Parsed envelope records for the session in chronological order.
   */
  messages: AiSessionMessage[];

  /**
   * Cached count, equal to `messages.length`. Kept denormalized to avoid
   * recomputing in render selectors that must stay allocation-free.
   */
  messageCount: number;
}

/**
 * Single message inside an AI session, decoded from the envelope protocol.
 */
export interface AiSessionMessage {
  /**
   * Telegram message ID this envelope was parsed from.
   */
  telegramMessageId: number;

  /**
   * Discriminated payload carried by the envelope.
   */
  kind: 'user' | 'assistant' | 'toolCall' | 'toolResult' | 'metadata';

  /**
   * ISO 8601 timestamp when the original Telegram message was sent.
   */
  sentAt: string;

  /**
   * Decoded payload — opaque to the workspace layer; typed envelopes live
   * alongside the parser in the envelope protocol module.
   */
  payload: unknown;
}

/**
 * Configuration for the AI workspace.
 * Stored in settings for user customization. Endpoint and credentials never
 * leave the client.
 */
export interface AiWorkspaceConfig {
  /**
   * OpenAI-compatible API endpoint URL.
   * Never stored in Telegram; only in client settings.
   */
  endpointUrl?: string;

  /**
   * API key / bearer token for the endpoint. Held only in memory by the
   * local transport; must never be persisted to Telegram or IndexedDB.
   */
  apiKey?: string;

  /**
   * Model to use for completions.
   */
  model?: string;

  /**
   * Maximum tokens for responses.
   */
  maxTokens?: number;

  /**
   * Temperature for sampling (0.0 to 2.0).
   */
  temperature?: number;

  /**
   * Whether to stream responses.
   */
  stream?: boolean;

  /**
   * System prompt prepended to every request, in addition to the envelope
   * framing the sidebar derives per topic.
   */
  systemPrompt?: string;
}

/**
 * Source chat identification for AI workspace.
 */
export interface AiSourceChat {
  id: string;
  type: 'user' | 'chat' | 'channel';
  title?: string;
}

/**
 * Topic information for an AI conversation.
 */
export interface AiTopicInfo {
  topicId: string;
  title?: string;
  sourceChatId: string;
  sessionId: string;
  createdAt: number;
  messageCount: number;
}

/**
 * Envelope protocol constants.
 * Imported from envelopeProtocol to avoid circular dependencies.
 */
export interface EnvelopeProtocolConstants {
  prefix: string;
  versionMarker: string;
  fieldSeparator: string;
}

/**
 * Default empty AI workspace state.
 * Used by `initialState.ts` and the migration path.
 */
export const EMPTY_AI_WORKSPACE_STATE: AiWorkspaceState = {
  topicMappings: {},
  sessionsByTopicId: {},
  isEnabled: false,
};
