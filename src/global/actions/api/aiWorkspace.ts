/**
 * AI workspace API actions.
 *
 * Topic management and discovery for the client-only AI sidebar. All work is
 * gated behind the `aiWorkspace.isEnabled` flag and fails closed: on any
 * error the workspace state is rolled back so no false mappings remain.
 */

import type { ApiChat, ApiMessage } from '../../../api/types';
import type { ActionReturnType, GlobalState, RequiredGlobalState } from '../../types';
import type { AiSessionMetadata, AiWorkspaceState } from '../../types/aiWorkspace';

import { getCurrentTabId } from '../../../util/establishMultitabRole';
import { callApi } from '../../../api/gramjs';
import { getAiWorkspaceTitle } from '../../helpers/aiWorkspaceSync';
import { addActionHandler, getGlobal, setGlobal } from '../../index';
import {
  ensureAiWorkspaceState,
  removeAiTopicMapping,
  serializeSessionMetadata,
  setAiSessionMetadata,
  setAiTopicMapping,
  setAiWorkspaceChatId,
  setAiWorkspaceEnabled,
  setAiWorkspaceInitError,
  setAiWorkspaceInitializing,
  setAiWorkspaceLastSync,
  updateChat,
} from '../../reducers';
import { tryParseEnvelope } from '../../reducers/envelopeParser';
import {
  selectAiWorkspace,
  selectChat,
  selectIsAiWorkspaceEnabled,
  selectTopicForSourceChat,
  selectWorkspaceChatId,
} from '../../selectors';

const METADATA_SCHEMA = 1;
const METADATA_INITIAL_SEQUENCE_ID = 0;

/**
 * Build a workspace session id. Falls back to `generateUniqueId`-style output
 * on platforms without `crypto.randomUUID`; the envelope parser only
 * requires a non-empty string identifier, so the fallback stays valid.
 */
function generateWorkspaceSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function markInitializing<T extends RequiredGlobalState>(global: T, isInitializing: boolean): T {
  return setAiWorkspaceInitializing(global, isInitializing);
}

function markInitError<T extends RequiredGlobalState>(global: T, message: string | undefined): T {
  return setAiWorkspaceInitError(global, message);
}

function getActiveWorkspace<T extends RequiredGlobalState>(global: T): AiWorkspaceState | undefined {
  const tabId = getCurrentTabId();
  const workspace = selectAiWorkspace(global, tabId);
  if (!workspace || !selectIsAiWorkspaceEnabled(global, tabId)) return undefined;
  return workspace;
}

/**
 * Resolve the workspace service supergroup from local state. The chat will
 * already be present in `global.chats.byId` once the workspace-creation flow
 * has run; this helper keeps the action code free of `selectChat` calls.
 */
function selectWorkspaceChat<T extends RequiredGlobalState>(global: T): ApiChat | undefined {
  const workspaceChatId = selectWorkspaceChatId(global, getCurrentTabId());
  if (!workspaceChatId) return undefined;
  return selectChat(global, workspaceChatId);
}

/**
 * Resolve the workspace through the worker API boundary. Global actions run
 * in the UI thread, so low-level GramJS methods must not be invoked directly.
 */
export async function discoverOrCreateAiWorkspace(ownerId: string): Promise<ApiChat | undefined> {
  const discovered = await callApi('discoverWorkspace', ownerId);
  if (discovered) return discovered;

  const created = await callApi('createWorkspace', { title: getAiWorkspaceTitle(ownerId) });
  return created?.chat;
}

/**
 * Initialise the workspace on app start. Idempotent: if the workspace is
 * already created locally, this only refreshes topic mappings. Otherwise it
 * waits for the parallel workspace-creation action to populate the chat id.
 */
addActionHandler('initializeAiWorkspace', async (global, actions, payload): Promise<void> => {
  const { tabId = getCurrentTabId() } = payload || {};

  global = ensureAiWorkspaceState(global);
  const workspace = selectAiWorkspace(global, tabId);
  if (!workspace || !selectIsAiWorkspaceEnabled(global, tabId)) {
    return;
  }

  global = markInitializing(global, true);
  global = markInitError(global, undefined);
  setGlobal(global);

  try {
    const workspaceChatId = selectWorkspaceChatId(global, tabId);
    if (!workspaceChatId) {
      // No workspace yet — leave it for lazy creation. Do not raise an
      // error: the user can still use the rest of the app normally.
      return;
    }

    // Workspace already exists; refresh the mapping registry from Telegram
    // by re-parsing every topic's metadata message.
    await refreshAiTopicMappings({ tabId });
  } catch (err) {
    global = getGlobal<RequiredGlobalState>();
    global = markInitError(global, toErrorMessage(err));
    setGlobal(global);
  } finally {
    global = getGlobal<RequiredGlobalState>();
    global = markInitializing(global, false);
    setGlobal(global);
  }
});

/**
 * Explicit opt-in flow used by Settings and the sidebar when the user wants
 * cross-device synchronization. Creates the private workspace only when the
 * user requests it, stores the workspace chat locally, and then refreshes the
 * topic mappings from Telegram cloud history.
 */
addActionHandler('createAndEnableAiWorkspace', async (global, actions, payload): Promise<void> => {
  const { tabId = getCurrentTabId() } = payload || {};

  global = ensureAiWorkspaceState(global);
  global = markInitializing(global, true);
  global = markInitError(global, undefined);
  setGlobal(global);

  try {
    const existingWorkspaceChatId = selectWorkspaceChatId(global, tabId);
    let workspaceChat = selectWorkspaceChat(global);

    if (!existingWorkspaceChatId) {
      const ownerId = global.currentUserId;
      if (!ownerId) {
        throw new Error('Unable to identify the current Telegram account.');
      }

      workspaceChat = await discoverOrCreateAiWorkspace(ownerId);
      if (!workspaceChat) {
        throw new Error('Failed to discover or create AI workspace.');
      }

      global = getGlobal<RequiredGlobalState>();
      global = updateChat(global, workspaceChat.id, workspaceChat);
      global = setAiWorkspaceChatId(global, workspaceChat.id);
    } else if (!workspaceChat) {
      global = getGlobal<RequiredGlobalState>();
      global = setAiWorkspaceChatId(global, existingWorkspaceChatId);
    }

    global = setAiWorkspaceEnabled(global, true);
    if (workspaceChat) {
      global = setAiWorkspaceChatId(global, workspaceChat.id);
    }
    setGlobal(global);

    if (workspaceChat) {
      await refreshAiTopicMappings({ tabId, workspaceChat });
    }
  } catch (err) {
    global = getGlobal<RequiredGlobalState>();
    global = markInitError(global, toErrorMessage(err));
    setGlobal(global);
  } finally {
    global = getGlobal<RequiredGlobalState>();
    global = markInitializing(global, false);
    setGlobal(global);
  }
});

/**
 * Re-scan every forum topic in the workspace and rebuild the
 * source-chat → topic mapping. Called on app start and after a workspace
 * is recreated on a second device. Failures roll back any new mappings.
 */
async function refreshAiTopicMappings({
  tabId,
  workspaceChat: providedWorkspaceChat,
}: {
  tabId: number;
  workspaceChat?: ApiChat;
}): Promise<void> {
  let global = ensureAiWorkspaceState(getGlobal<RequiredGlobalState>());
  const workspaceChat = providedWorkspaceChat || selectWorkspaceChat(global);
  if (!workspaceChat) return;

  // Capture the existing state so a partial run can be undone.
  const previous = {
    topicMappings: { ...global.aiWorkspace!.topicMappings },
    sessionsByTopicId: { ...global.aiWorkspace!.sessionsByTopicId },
  };

  try {
    const topicsResult = await callApi('fetchTopics', { chat: workspaceChat, limit: 100 });
    if (!topicsResult) return;

    for (const topic of topicsResult.topics) {
      if (!topic.lastMessageId) continue;
      const message = topicsResult.messages.find((m) => m.id === topic.lastMessageId);
      if (!message) continue;
      // Use `unknown` so we can detect the source chat id without committing to
      // a specific sourceChat type — the metadata carries just the id string.
      const parsed = parseMetadataSourcePeer(message);
      if (!parsed) continue;

      const existingTopicId = global.aiWorkspace!.topicMappings[parsed.sourcePeerId];
      if (existingTopicId !== undefined && existingTopicId !== String(topic.topic.id)) {
        // Duplicate topic race: prefer the existing mapping and leave the
        // extra topic as orphaned (cleaned up by an explicit user action).
        continue;
      }

      global = setAiTopicMapping(global, parsed.sourcePeerId, String(topic.topic.id), {
        sessionId: parsed.sessionId,
        sourceAccountId: parsed.sourceAccountId,
        sourcePeerId: parsed.sourcePeerId,
        sourceThreadId: parsed.sourceThreadId,
        createdAt: parsed.createdAt,
        titleSnapshot: parsed.titleSnapshot,
        messageCount: 1,
      });
    }

    global = setAiWorkspaceLastSync(global);
    setGlobal(global);
  } catch (err) {
    // Rollback to the previous snapshot and surface the error to the user.
    global = getGlobal<RequiredGlobalState>();
    global = setAiTopicMappingRollback(global, previous);
    global = markInitError(global, toErrorMessage(err));
    setGlobal(global);
    void tabId; // Reserved for future per-tab diagnostics.
  }
}

/**
 * Create a new forum topic in the workspace for the given source chat.
 *
 * Validates that the workspace exists, creates the topic, posts the session
 * metadata envelope as the topic's first message, and stores the mapping in
 * global state. On any failure the partial state (topic and/or mapping) is
 * rolled back so the workspace stays consistent.
 */
addActionHandler('createAiTopic', async (global, actions, payload): Promise<void> => {
  const { sourceChat, titleSnapshot, tabId = getCurrentTabId() } = payload;

  global = ensureAiWorkspaceState(global);
  const workspace = getActiveWorkspace(global);
  if (!workspace || !workspace.workspaceChatId) {
    return;
  }

  const existingTopicId = selectTopicForSourceChat(global, sourceChat.id, tabId);
  if (existingTopicId !== undefined) {
    // Mapping already exists; nothing to create. This is the dedup path
    // that protects against duplicate-topic races between devices.
    return;
  }

  const workspaceChat = selectWorkspaceChat(global);
  if (!workspaceChat) {
    return;
  }

  const topicTitle = buildTopicTitle(sourceChat.title ?? sourceChat.id);

  let topicId: number | undefined;
  try {
    topicId = await callApi('createTopic', {
      chat: workspaceChat,
      title: topicTitle,
    });
  } catch (err) {
    actions.showDialog({
      data: {
        type: 'error',
        message: toErrorMessage(err),
      },
      tabId,
    });
    return;
  }

  if (!topicId) {
    return;
  }

  // Persist the mapping immediately so a partial send below can be retried
  // by id rather than re-creating a duplicate topic.
  global = getGlobal<RequiredGlobalState>();
  global = setAiTopicMapping(global, sourceChat.id, topicId.toString());
  setGlobal(global);

  const sessionId = generateWorkspaceSessionId();
  const createdAt = new Date().toISOString();
  const sourceAccountId = global.currentUserId ?? '';

  const metadata: AiSessionMetadata = {
    sessionId,
    sourceAccountId,
    sourcePeerId: sourceChat.id,
    sourceThreadId: null,
    createdAt,
    titleSnapshot,
    messageCount: 1,
  };

  const envelopeText = serializeSessionMetadata({
    schema: METADATA_SCHEMA,
    sequenceId: METADATA_INITIAL_SEQUENCE_ID,
    sessionId,
    sourceAccountId,
    sourcePeerId: sourceChat.id,
    sourceThreadId: null,
    createdAt,
    titleSnapshot,
  });

  if (!envelopeText) {
    // The envelope serializer fails closed: an unusable envelope means
    // the topic itself can't be reconstructed later, so we tear the topic
    // and the mapping back down.
    global = getGlobal<RequiredGlobalState>();
    global = removeAiTopicMapping(global, sourceChat.id);
    setGlobal(global);
    await safeDeleteTopic(workspaceChat, topicId);
    return;
  }

  try {
    await callApi('sendMessage', {
      chat: workspaceChat,
      text: envelopeText,
      isSilent: true,
    });
  } catch (err) {
    global = getGlobal<RequiredGlobalState>();
    global = removeAiTopicMapping(global, sourceChat.id);
    setGlobal(global);
    await safeDeleteTopic(workspaceChat, topicId);
    actions.showDialog({
      data: {
        type: 'error',
        message: toErrorMessage(err),
      },
      tabId,
    });
    return;
  }

  global = getGlobal<RequiredGlobalState>();
  global = setAiSessionMetadata(global, topicId.toString(), metadata);
  global = setAiWorkspaceLastSync(global);
  setGlobal(global);
});

/**
 * Discover the forum topic for a source chat.
 *
 * Looks in the local mapping first; if missing, scans the workspace topics
 * for a session metadata record pointing back at the source chat. The
 * discovered mapping is stored so future lookups stay local.
 */
addActionHandler('discoverAiTopic', async (global, actions, payload): Promise<void> => {
  const { sourceChat, tabId = getCurrentTabId() } = payload;

  global = ensureAiWorkspaceState(global);
  const workspace = getActiveWorkspace(global);
  if (!workspace || !workspace.workspaceChatId) {
    return;
  }

  const known = selectTopicForSourceChat(global, sourceChat.id, tabId);
  if (known !== undefined) {
    // Mapping is already known; caller can read it via selectors.
    return;
  }

  const workspaceChat = selectWorkspaceChat(global);
  if (!workspaceChat) {
    return;
  }

  // Fetch every workspace topic in one shot. Discovery only runs for the
  // single source chat the user is viewing, so a full scan is acceptable.
  const topicsResult = await callApi('fetchTopics', { chat: workspaceChat, limit: 100 });
  if (!topicsResult) {
    return;
  }

  // Re-derive the source-id used by metadata envelopes. The wire format
  // stores `sourcePeerId` as the chat id (a string), which matches
  // `sourceChat.id` directly.
  for (const topic of topicsResult.topics) {
    if (!topic.lastMessageId) continue;
    const message = topicsResult.messages.find((m) => m.id === topic.lastMessageId);
    if (!message) continue;
    const parsed = parseMetadataFromMessage(message, sourceChat.id);
    if (!parsed) continue;

    const metadata: AiSessionMetadata = {
      sessionId: parsed.sessionId,
      sourceAccountId: parsed.sourceAccountId,
      sourcePeerId: parsed.sourcePeerId,
      sourceThreadId: parsed.sourceThreadId,
      createdAt: parsed.createdAt,
      titleSnapshot: parsed.titleSnapshot,
      messageCount: 1,
    };

    global = getGlobal<RequiredGlobalState>();
    global = setAiTopicMapping(global, sourceChat.id, String(topic.topic.id), metadata);
    global = setAiWorkspaceLastSync(global);
    setGlobal(global);

    void tabId; // Reserved for future per-tab diagnostics.
    return;
  }

  return undefined;
});

/**
 * Manually store a topic mapping. Useful for tests and for explicit user
 * repair from the diagnostics page; the runtime should prefer
 * `createAiTopic` / `discoverAiTopic`.
 */
addActionHandler('storeAiTopicMapping', (global, actions, payload): ActionReturnType => {
  const { sourceChatId, topicId } = payload;
  if (!sourceChatId || !Number.isFinite(topicId)) return undefined;

  global = ensureAiWorkspaceState(global);
  global = setAiTopicMapping(global, sourceChatId, topicId.toString());
  global = setAiWorkspaceLastSync(global);
  setGlobal(global);
  return undefined;
});

/**
 * Toggle the workspace feature on or off. Disabling keeps the stored
 * workspace id so the user can re-enable without re-discovery.
 */

addActionHandler('setAiWorkspaceEnabled', (global, actions, payload): ActionReturnType => {
  const { isEnabled } = payload;
  global = ensureAiWorkspaceState(global);
  global = setAiWorkspaceEnabled(global, isEnabled);
  if (!isEnabled) {
    global = setAiWorkspaceInitError(global, undefined);
  }
  setGlobal(global);
  return undefined;
});

/**
 * Internal helper used by the parallel workspace-creation action: assign
 * the chat id once the supergroup has been created locally.
 *
 * Exposed as an action so the workspace creation flow (lives in the
 * telegram-protocol agent) can hand control back here without importing
 * reducers directly.
 */
export function setAiWorkspaceChatIdAction(global: GlobalState, workspaceChatId: string): GlobalState {
  return setAiWorkspaceChatId(global, workspaceChatId);
}

function buildTopicTitle(sourceTitle: string): string {
  // Forum topic titles are capped at 128 Unicode characters by Telegram.
  // Truncate the snapshot defensively and prefix with a marker so users
  // browsing the (hidden) workspace can recognise AI topics.
  const MAX_TITLE_LENGTH = 120;
  const trimmed = sourceTitle.slice(0, MAX_TITLE_LENGTH);
  return `AI · ${trimmed}`;
}

async function safeDeleteTopic(workspaceChat: ApiChat, topicId: number): Promise<void> {
  try {
    await callApi('deleteTopic', { chat: workspaceChat, topicId });
  } catch {
    // Best-effort cleanup. The user can delete orphaned topics from the
    // diagnostics page; failing here would mask the real error.
  }
}

function parseMetadataFromMessage(
  message: ApiMessage,
  sourceChatId: string,
): {
  sessionId: string;
  sourceAccountId: string;
  sourcePeerId: string;
  sourceThreadId: number | null;
  createdAt: string;
  titleSnapshot?: string;
} | undefined {
  const metadata = parseMetadataSourcePeer(message);
  if (!metadata) return undefined;
  if (metadata.sourcePeerId !== sourceChatId) return undefined;
  return metadata;
}

function parseMetadataSourcePeer(message: ApiMessage): {
  sessionId: string;
  sourceAccountId: string;
  sourcePeerId: string;
  sourceThreadId: number | null;
  createdAt: string;
  titleSnapshot?: string;
} | undefined {
  const record = tryParseEnvelope(message, 0);
  if (!record) return undefined;
  if (record.type !== 'M') return undefined;

  return {
    sessionId: record.sessionId,
    sourceAccountId: record.sourceAccountId,
    sourcePeerId: record.sourcePeerId,
    sourceThreadId: record.sourceThreadId,
    createdAt: record.createdAt,
    titleSnapshot: record.titleSnapshot,
  };
}

function setAiTopicMappingRollback<T extends RequiredGlobalState>(
  global: T,
  previous: { topicMappings: Record<string, string>; sessionsByTopicId: Record<string, AiSessionMetadata> },
): T {
  global = ensureAiWorkspaceState(global);
  return {
    ...global,
    aiWorkspace: {
      ...global.aiWorkspace!,
      topicMappings: previous.topicMappings,
      sessionsByTopicId: previous.sessionsByTopicId,
    },
  } as T;
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}
