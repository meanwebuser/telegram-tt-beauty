/**
 * AI workspace selectors.
 *
 * Provides read-only access to AI workspace state from global state.
 * Selectors are allocation-free — when no workspace exists, callers get a
 * shared frozen empty object so `withGlobal` memoization is preserved.
 */

import type { GlobalState, TabArgs } from '../types';
import type {
  AiSession,
  AiSessionMetadata,
  AiTopic,
  AiTopicInfo,
  AiWorkspaceState,
} from '../types/aiWorkspace';

import { getCurrentTabId } from '../../util/establishMultitabRole';

function selectAiWorkspaceState<T extends GlobalState>(global: T): AiWorkspaceState | undefined {
  return global.aiWorkspace;
}

/**
 * Returns the full AI workspace state, or `undefined` when the feature
 * has never been initialized on this device.
 */
export function selectAiWorkspace<T extends GlobalState>(
  global: T,
  ...[tabId = getCurrentTabId()]: TabArgs<T>
): AiWorkspaceState | undefined {
  return selectAiWorkspaceState(global);
}

/**
 * Feature flag check. Defaults to `false` when state is missing so the
 * sidebar stays closed even before initialization runs.
 */
export function selectIsAiWorkspaceEnabled<T extends GlobalState>(
  global: T,
  ...[tabId = getCurrentTabId()]: TabArgs<T>
): boolean {
  return Boolean(selectAiWorkspaceState(global)?.isEnabled);
}

/**
 * Returns the ID of the service supergroup that hosts the AI workspace.
 * `undefined` means the workspace has not been created yet.
 */
export function selectWorkspaceChatId<T extends GlobalState>(
  global: T,
  ...[tabId = getCurrentTabId()]: TabArgs<T>
): string | undefined {
  return selectAiWorkspaceState(global)?.workspaceChatId;
}

/**
 * Resolves the forum topic ID for a given source chat, or `undefined`
 * when no topic has been provisioned for that chat yet.
 */
export function selectTopicForSourceChat<T extends GlobalState>(
  global: T,
  sourceChatId: string,
  ...[tabId = getCurrentTabId()]: TabArgs<T>
): string | undefined {
  const aiWorkspace = selectAiWorkspaceState(global);
  if (!aiWorkspace) return undefined;

  return aiWorkspace.topicMappings[sourceChatId];
}

/**
 * Returns every source-chat → topic mapping as a stable reference. The
 * caller must not mutate the returned object.
 */
export function selectAllTopics<T extends GlobalState>(
  global: T,
  ...[tabId = getCurrentTabId()]: TabArgs<T>
): AiWorkspaceState['topicMappings'] {
  return selectAiWorkspaceState(global)?.topicMappings ?? EMPTY_TOPIC_MAPPINGS;
}

/**
 * Returns session metadata for a topic. Heavy parsing of message history
 * happens lazily via the envelope parser; this selector only returns the
 * denormalized metadata stored in global state.
 */
export function selectSessionMetadata<T extends GlobalState>(
  global: T,
  topicId: string,
  ...[tabId = getCurrentTabId()]: TabArgs<T>
): AiSessionMetadata | undefined {
  const aiWorkspace = selectAiWorkspaceState(global);
  if (!aiWorkspace) return undefined;

  return aiWorkspace.sessionsByTopicId[topicId];
}

/**
 * Returns all session metadata keyed by topic ID. Returns the live
 * reference when state exists, otherwise a shared frozen empty object.
 */
export function selectAllSessions<T extends GlobalState>(
  global: T,
  ...[tabId = getCurrentTabId()]: TabArgs<T>
): AiWorkspaceState['sessionsByTopicId'] {
  return selectAiWorkspaceState(global)?.sessionsByTopicId ?? EMPTY_SESSIONS;
}

/**
 * Returns every cached `AiSession` in chronological order (newest first).
 * Slow — allocates a new array. Do not call inside `withGlobal`.
 */
export function selectAllTopicInfo<T extends GlobalState>(
  global: T,
  ...[tabId = getCurrentTabId()]: TabArgs<T>
): AiTopicInfo[] {
  const aiWorkspace = selectAiWorkspaceState(global);
  if (!aiWorkspace) return [];

  const { topicMappings, sessionsByTopicId } = aiWorkspace;
  const topics: AiTopicInfo[] = [];

  for (const [sourceChatId, topicId] of Object.entries(topicMappings)) {
    const session = sessionsByTopicId[topicId];
    if (!session) continue;
    topics.push({
      topicId,
      sourceChatId,
      sessionId: session.sessionId,
      title: session.titleSnapshot,
      createdAt: new Date(session.createdAt).getTime(),
      messageCount: session.messageCount,
    });
  }

  topics.sort((a, b) => b.createdAt - a.createdAt);
  return topics;
}

/**
 * Returns lightweight `AiTopic` summaries for the sidebar header.
 * Slow — allocates a new array. Do not call inside `withGlobal`.
 */
export function selectAiTopicsSlow<T extends GlobalState>(
  global: T,
  ...[tabId = getCurrentTabId()]: TabArgs<T>
): AiTopic[] {
  const aiWorkspace = selectAiWorkspaceState(global);
  if (!aiWorkspace) return [];

  const { topicMappings, sessionsByTopicId } = aiWorkspace;
  const topics: AiTopic[] = [];

  for (const [sourceChatId, topicId] of Object.entries(topicMappings)) {
    const metadata = sessionsByTopicId[topicId];
    topics.push({
      topicId,
      sourceChatId,
      title: metadata?.titleSnapshot,
      createdAt: metadata ? new Date(metadata.createdAt).getTime() : 0,
      messageCount: metadata?.messageCount ?? 0,
    });
  }

  return topics;
}

/**
 * Returns the full session including parsed messages, if one has been
 * materialized in the cache. Heavy session parsing lives in the parser
 * module; this selector only reads what is already in global state.
 */
export function selectSession<T extends GlobalState>(
  global: T,
  topicId: string,
  ...[tabId = getCurrentTabId()]: TabArgs<T>
): AiSession | undefined {
  const metadata = selectSessionMetadata(global, topicId, tabId);
  if (!metadata) return undefined;

  return {
    sessionId: metadata.sessionId,
    topicId,
    sourceChatId: metadata.sourcePeerId,
    sourceThreadId: metadata.sourceThreadId,
    createdAt: metadata.createdAt,
    messageCount: metadata.messageCount,
    messages: [], // Hydrated lazily by the parser; kept empty in global state.
  };
}

/**
 * Whether the workspace is currently being created. UI uses this to
 * disable the open-sidebar button while initialization is running.
 */
export function selectIsWorkspaceInitializing<T extends GlobalState>(
  global: T,
  ...[tabId = getCurrentTabId()]: TabArgs<T>
): boolean {
  return Boolean(selectAiWorkspaceState(global)?.isInitializing);
}

/**
 * Last initialization error message, if any. Surfaced to the user via
 * the sidebar's error banner.
 */
export function selectWorkspaceInitError<T extends GlobalState>(
  global: T,
  ...[tabId = getCurrentTabId()]: TabArgs<T>
): string | undefined {
  return selectAiWorkspaceState(global)?.lastInitError;
}

/**
 * Timestamp (ms) of the last successful sync. Used by the sidebar to
 * detect stale reads from another device and trigger a refresh.
 */
export function selectWorkspaceLastSync<T extends GlobalState>(
  global: T,
  ...[tabId = getCurrentTabId()]: TabArgs<T>
): number | undefined {
  return selectAiWorkspaceState(global)?.lastSync;
}

/**
 * `true` once the service supergroup has been created on this device.
 */
export function selectIsWorkspaceCreated<T extends GlobalState>(
  global: T,
  ...[tabId = getCurrentTabId()]: TabArgs<T>
): boolean {
  return Boolean(selectAiWorkspaceState(global)?.workspaceChatId);
}

/**
 * Returns the cached message count for a topic, or `0` when no metadata
 * is cached yet. Mirrors the counter the sidebar renders in the header.
 */
export function selectTopicMessageCount<T extends GlobalState>(
  global: T,
  topicId: string,
  ...[tabId = getCurrentTabId()]: TabArgs<T>
): number {
  return selectAiWorkspaceState(global)?.sessionsByTopicId[topicId]?.messageCount ?? 0;
}

// Shared frozen empty sentinels — guarantees allocation-free reads when
// the workspace has not been initialized. Returning a fresh `{}` would
// defeat `withGlobal` memoization and re-render the sidebar on every
// unrelated global change.
const EMPTY_TOPIC_MAPPINGS: AiWorkspaceState['topicMappings'] = Object.freeze(
  {},
) as AiWorkspaceState['topicMappings'];
const EMPTY_SESSIONS: AiWorkspaceState['sessionsByTopicId'] = Object.freeze(
  {},
) as AiWorkspaceState['sessionsByTopicId'];
