/**
 * AI workspace reducers.
 *
 * Pure state transitions for the client-only AI sidebar workspace.
 * These functions only mutate the `aiWorkspace` slice of global state and
 * never contact Telegram or read external sources.
 */

import type { AiSessionMetadata, AiWorkspaceState } from '../types/aiWorkspace';
import type { GlobalState } from '../types';

import { EMPTY_AI_WORKSPACE_STATE } from '../types/aiWorkspace';

export function ensureAiWorkspaceState<T extends GlobalState>(global: T): T {
  if (global.aiWorkspace) return global;
  return {
    ...global,
    aiWorkspace: { ...EMPTY_AI_WORKSPACE_STATE },
  };
}

export function setAiWorkspaceEnabled<T extends GlobalState>(
  global: T,
  isEnabled: boolean,
): T {
  global = ensureAiWorkspaceState(global);
  return {
    ...global,
    aiWorkspace: {
      ...global.aiWorkspace!,
      isEnabled,
      lastInitError: isEnabled ? global.aiWorkspace!.lastInitError : undefined,
      isInitializing: isEnabled ? global.aiWorkspace!.isInitializing : false,
    },
  };
}

export function setAiWorkspaceChatId<T extends GlobalState>(
  global: T,
  workspaceChatId: string | undefined,
): T {
  global = ensureAiWorkspaceState(global);
  return {
    ...global,
    aiWorkspace: {
      ...global.aiWorkspace!,
      workspaceChatId,
    },
  };
}

export function setAiWorkspaceInitializing<T extends GlobalState>(
  global: T,
  isInitializing: boolean,
): T {
  global = ensureAiWorkspaceState(global);
  return {
    ...global,
    aiWorkspace: {
      ...global.aiWorkspace!,
      isInitializing,
    },
  };
}

export function setAiWorkspaceInitError<T extends GlobalState>(
  global: T,
  message: string | undefined,
): T {
  global = ensureAiWorkspaceState(global);
  return {
    ...global,
    aiWorkspace: {
      ...global.aiWorkspace!,
      lastInitError: message,
    },
  };
}

export function setAiWorkspaceLastSync<T extends GlobalState>(
  global: T,
  timestamp: number = Date.now(),
): T {
  global = ensureAiWorkspaceState(global);
  return {
    ...global,
    aiWorkspace: {
      ...global.aiWorkspace!,
      lastSync: timestamp,
    },
  };
}

/**
 * Record a forum-topic → source-chat mapping.
 *
 * Mapping is bidirectional in the stored state: `topicMappings[sourceChatId]`
 * is the source-of-truth index, and the session metadata lives under
 * `sessionsByTopicId[topicId]`. A mapping without session metadata is treated
 * as a transient state and is cleared if metadata storage fails.
 */
export function setAiTopicMapping<T extends GlobalState>(
  global: T,
  sourceChatId: string,
  topicId: string,
  metadata?: AiSessionMetadata,
): T {
  global = ensureAiWorkspaceState(global);
  const current = global.aiWorkspace!;
  return {
    ...global,
    aiWorkspace: {
      ...current,
      topicMappings: {
        ...current.topicMappings,
        [sourceChatId]: topicId,
      },
      sessionsByTopicId: metadata
        ? { ...current.sessionsByTopicId, [topicId]: metadata }
        : current.sessionsByTopicId,
    },
  };
}

/**
 * Remove a topic mapping. Clears both the source-chat index and any
 * stored session metadata for that topic. Used to roll back half-applied
 * state when a downstream Telegram call fails.
 */
export function removeAiTopicMapping<T extends GlobalState>(
  global: T,
  sourceChatId: string,
): T {
  global = ensureAiWorkspaceState(global);
  const current = global.aiWorkspace!;
  const topicId = current.topicMappings[sourceChatId];
  if (topicId === undefined) return global;

  const { [sourceChatId]: _removedMapping, ...restMappings } = current.topicMappings;
  const { [topicId]: _removedSession, ...restSessions } = current.sessionsByTopicId;

  return {
    ...global,
    aiWorkspace: {
      ...current,
      topicMappings: restMappings,
      sessionsByTopicId: restSessions,
    },
  };
}

export function setAiSessionMetadata<T extends GlobalState>(
  global: T,
  topicId: string,
  metadata: AiSessionMetadata,
): T {
  global = ensureAiWorkspaceState(global);
  return {
    ...global,
    aiWorkspace: {
      ...global.aiWorkspace!,
      sessionsByTopicId: {
        ...global.aiWorkspace!.sessionsByTopicId,
        [topicId]: metadata,
      },
    },
  };
}
