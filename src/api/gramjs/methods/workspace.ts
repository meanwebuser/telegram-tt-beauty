/**
 * AI workspace Telegram API methods.
 *
 * Handles creation and management of the hidden service supergroup that stores
 * AI conversation data, as well as the per-source-chat forum topics that hold
 * individual conversation histories.
 */

import { Api as GramJs } from '../../../lib/gramjs';
import { generateRandomBigInt } from '../../../lib/gramjs/Helpers';

import type { ApiChat, ApiMessage, ApiTopicWithState } from '../../types';

import { ARCHIVED_FOLDER_ID, DEBUG } from '../../../config';
import { AI_WORKSPACE_TITLE_PREFIX, findAiWorkspaceChat } from '../../../global/helpers/aiWorkspaceSync';
import { buildApiChatFromPreview } from '../apiBuilders/chats';
import { buildApiTopicWithState } from '../apiBuilders/forums';
import { buildApiMessage } from '../apiBuilders/messages';
import { buildInputPeer, DEFAULT_PRIMITIVES } from '../gramjsBuilders';
import { fetchChats } from './chats';
import { invokeRequest } from './client';

// Marker prefix used inside topic service messages that map a topic back to
// the source chat it represents. The metadata message body looks like
// `AIWS:sourceChat=<id>` and is the only way to identify which topic belongs
// to which source chat when reconstructing state from Telegram history.
const TOPIC_METADATA_PREFIX = 'AIWS:sourceChat=';

/**
 * Result of creating the AI workspace.
 */
export interface CreateWorkspaceResult {
  chat: ApiChat;
}

export async function discoverWorkspace(ownerId: string): Promise<ApiChat | undefined> {
  const archivedDialogs = await fetchChats({ limit: 100, archived: true });
  return archivedDialogs ? findAiWorkspaceChat(archivedDialogs.chats, ownerId) : undefined;
}

/**
 * Create the AI workspace service supergroup.
 *
 * Creates a private megagroup with forum mode enabled, archives it immediately,
 * and mutes notifications. The returned chat is a regular `ApiChat` and is
 * hidden from the custom client UI by the caller (the workspace lives only in
 * Telegram cloud history).
 *
 * Returns `undefined` on error; the caller is expected to retry without
 * persisting any partial state.
 */
export async function createWorkspace({
  title = AI_WORKSPACE_TITLE_PREFIX,
  about = 'AI conversation history',
}: {
  title?: string;
  about?: string;
} = {}): Promise<CreateWorkspaceResult | undefined> {
  const result = await invokeRequest(new GramJs.channels.CreateChannel({
    title,
    about,
    megagroup: true,
    forum: true,
  }), {
    shouldThrow: true,
  });

  if (!(result instanceof GramJs.Updates)) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.error('[AI Workspace] Unexpected create channel response', result);
    }
    return undefined;
  }

  const newChannel = result.chats[0];
  if (!newChannel || !(newChannel instanceof GramJs.Channel)) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.error('[AI Workspace] Created channel not found', result);
    }
    return undefined;
  }

  const chat = buildApiChatFromPreview(newChannel)!;

  const archiveResult = await archiveWorkspaceChat(chat);
  const muteResult = await muteWorkspaceChat(chat);

  if (!archiveResult || !muteResult) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.error('[AI Workspace] Failed to hide service chat', {
        archiveResult,
        muteResult,
      });
    }
    return undefined;
  }

  return { chat };
}

/**
 * Move the workspace chat into the archive folder.
 *
 * Archiving moves the chat out of the main dialog list and into the dedicated
 * "Archived" folder. The chat is still reachable by ID; it just disappears
 * from the regular list view.
 */
export async function archiveWorkspaceChat(chat: ApiChat): Promise<boolean | undefined> {
  return invokeRequest(new GramJs.folders.EditPeerFolders({
    folderPeers: [new GramJs.InputFolderPeer({
      peer: buildInputPeer(chat.id, chat.accessHash),
      folderId: ARCHIVED_FOLDER_ID,
    })],
  }), {
    shouldReturnTrue: true,
  });
}

/**
 * Mute notifications for the workspace chat indefinitely.
 *
 * `0x7FFFFFFF` is the "muted forever" sentinel that Telegram uses when no
 * concrete un-mute timestamp is desired.
 */
export async function muteWorkspaceChat(chat: ApiChat): Promise<boolean | undefined> {
  return invokeRequest(new GramJs.account.UpdateNotifySettings({
    peer: new GramJs.InputNotifyPeer({
      peer: buildInputPeer(chat.id, chat.accessHash),
    }),
    settings: new GramJs.InputPeerNotifySettings({
      muteUntil: 0x7FFFFFFF,
    }),
  }), {
    shouldReturnTrue: true,
  });
}

/**
 * Fetch all forum topics in the workspace.
 *
 * Mirrors `fetchTopics` from `forum.ts` but lives here so the workspace
 * implementation can stay self-contained.
 */
export async function getWorkspaceTopics({
  chat, limit = 100,
}: {
  chat: ApiChat;
  limit?: number;
}): Promise<ApiTopicWithState[] | undefined> {
  const { id, accessHash } = chat;

  const result = await invokeRequest(new GramJs.messages.GetForumTopics({
    peer: buildInputPeer(id, accessHash),
    limit,
    offsetTopic: DEFAULT_PRIMITIVES.INT,
    offsetId: DEFAULT_PRIMITIVES.INT,
    offsetDate: DEFAULT_PRIMITIVES.INT,
  }));

  if (!result) {
    return undefined;
  }

  return result.topics.map(buildApiTopicWithState).filter(Boolean);
}

/**
 * Create a new forum topic in the workspace and stamp it with a metadata
 * message that records the source chat ID it represents.
 *
 * The metadata message is what allows another device, or a future session,
 * to discover which topic corresponds to which source chat: Telegram does
 * not otherwise expose a mapping between topics and external identifiers.
 */
export async function createWorkspaceTopic({
  chat, title, sourceChatId, iconColor,
}: {
  chat: ApiChat;
  title: string;
  sourceChatId: string;
  iconColor?: number;
}): Promise<number | undefined> {
  const { id, accessHash } = chat;

  const updates = await invokeRequest(new GramJs.messages.CreateForumTopic({
    peer: buildInputPeer(id, accessHash),
    title,
    iconColor,
    randomId: generateRandomBigInt(),
  }));

  if (!(updates instanceof GramJs.Updates) || !updates.updates.length) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.error('[AI Workspace] Failed to create topic');
    }
    return undefined;
  }

  const topicId = updates.updates.find((update): update is GramJs.UpdateMessageID => (
    update instanceof GramJs.UpdateMessageID
  ))?.id;

  if (!topicId) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.error('[AI Workspace] Topic id not found in create response');
    }
    return undefined;
  }

  await sendTopicMetadata(chat, topicId, sourceChatId);

  return topicId;
}

/**
 * Find the existing workspace topic that represents a given source chat.
 *
 * Walks every topic in the workspace, reads the first message of each one,
 * and returns the first topic whose metadata message maps to `sourceChatId`.
 *
 * Returns `undefined` when no matching topic exists, so the caller can decide
 * whether to create one.
 */
export async function findTopicForSourceChat({
  chat, sourceChatId,
}: {
  chat: ApiChat;
  sourceChatId: string;
}): Promise<number | undefined> {
  const topics = await getWorkspaceTopics({ chat });
  if (!topics?.length) {
    return undefined;
  }

  const target = String(sourceChatId);
  for (const topic of topics) {
    const metadata = await fetchTopicMetadataMessage(chat, topic.topic.id);
    if (!metadata) {
      continue;
    }
    const text = metadata.content.text?.text;
    if (!text) {
      continue;
    }
    if (parseSourceChatIdFromMetadata(text) === target) {
      return topic.topic.id;
    }
  }

  return undefined;
}

/**
 * Persist the source-chat metadata for a freshly created topic.
 *
 * The marker is sent as a regular text message in the topic; it is invisible
 * to the user because the workspace chat is hidden from the custom UI.
 */
async function sendTopicMetadata(chat: ApiChat, topicId: number, sourceChatId: string): Promise<void> {
  const { id, accessHash } = chat;

  await invokeRequest(new GramJs.messages.SendMessage({
    peer: buildInputPeer(id, accessHash),
    message: `${TOPIC_METADATA_PREFIX}${sourceChatId}`,
    randomId: generateRandomBigInt(),
    replyTo: new GramJs.InputReplyToMessage({
      replyToMsgId: topicId,
      topMsgId: topicId,
    }),
  }));
}

/**
 * Read the metadata message at the top of a topic.
 *
 * The first message in any workspace topic is expected to be the metadata
 * record written by `sendTopicMetadata`. If the topic has no such message
 * (for example because it was created by an older client), `undefined` is
 * returned so the caller can skip it.
 */
async function fetchTopicMetadataMessage(chat: ApiChat, topicId: number): Promise<ApiMessage | undefined> {
  const { id, accessHash } = chat;

  const result = await invokeRequest(new GramJs.messages.GetReplies({
    peer: buildInputPeer(id, accessHash),
    msgId: topicId,
    offsetId: DEFAULT_PRIMITIVES.INT,
    offsetDate: DEFAULT_PRIMITIVES.INT,
    addOffset: DEFAULT_PRIMITIVES.INT,
    limit: 1,
    maxId: DEFAULT_PRIMITIVES.INT,
    minId: DEFAULT_PRIMITIVES.INT,
    hash: DEFAULT_PRIMITIVES.BIGINT,
  }));

  if (
    !result
    || result instanceof GramJs.messages.MessagesNotModified
    || !result.messages?.length
  ) {
    return undefined;
  }

  return buildApiMessage(result.messages[0]);
}

/**
 * Extract the source chat ID from a topic metadata message body.
 *
 * The metadata message is a plain text message with the format
 * `AIWS:sourceChat=<chat-id>`. Any deviation is treated as "not a metadata
 * message" and returns `undefined`, so a malformed or forged marker cannot
 * cause us to associate a topic with the wrong source chat.
 */
function parseSourceChatIdFromMetadata(text: string): string | undefined {
  if (!text.startsWith(TOPIC_METADATA_PREFIX)) {
    return undefined;
  }
  return text.slice(TOPIC_METADATA_PREFIX.length) || undefined;
}
