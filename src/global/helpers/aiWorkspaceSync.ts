import type { ApiChat } from '../../api/types';
import type { GlobalState } from '../types';

export const AI_WORKSPACE_TITLE_PREFIX = 'Telegram AI Workspace';

export function getAiWorkspaceTitle(ownerId: string): string {
  return `${AI_WORKSPACE_TITLE_PREFIX} · ${ownerId}`;
}

/**
 * A workspace is deliberately archived and muted, so a new device discovers
 * it from archived dialogs. The owner-specific title prevents importing an
 * unrelated forum that happens to have a similar generic title.
 */
export function findAiWorkspaceChat(chats: ApiChat[], ownerId: string): ApiChat | undefined {
  const expectedTitle = getAiWorkspaceTitle(ownerId);
  return chats
    .filter((chat) => chat.type === 'chatTypeSuperGroup' && chat.isForum && chat.title === expectedTitle)
    .sort((a, b) => (b.creationDate || 0) - (a.creationDate || 0))[0];
}

/**
 * Minimal workspace state needed when opening the AI sidebar.
 *
 * The sidebar must never auto-create the private forum workspace unless the
 * user has explicitly opted into synchronization.
 */
export function getAiSidebarOpenPlan(global: GlobalState, chatId: string) {
  const aiWorkspace = global.aiWorkspace;
  const isSyncEnabled = Boolean(aiWorkspace?.isEnabled);
  const workspaceChatId = isSyncEnabled ? aiWorkspace?.workspaceChatId : undefined;
  const topicId = isSyncEnabled ? aiWorkspace?.topicMappings[chatId] : undefined;

  return {
    isSyncEnabled,
    workspaceChatId,
    topicId: topicId ? Number(topicId) : 0,
    shouldCreateTopic: isSyncEnabled && Boolean(workspaceChatId),
  } as const;
}
