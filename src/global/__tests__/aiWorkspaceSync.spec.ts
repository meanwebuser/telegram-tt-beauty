import { describe, expect, it } from 'vitest';

import type { GlobalState } from '../types';
import type { AiSessionMetadata, AiWorkspaceState } from '../types/aiWorkspace';
import { EMPTY_AI_WORKSPACE_STATE } from '../types/aiWorkspace';

import { findAiWorkspaceChat, getAiSidebarOpenPlan, getAiWorkspaceTitle } from '../helpers/aiWorkspaceSync';
import { setAiWorkspaceEnabled } from '../reducers';

function makeWorkspace(overrides: Partial<AiWorkspaceState> = {}): AiWorkspaceState {
  return {
    ...EMPTY_AI_WORKSPACE_STATE,
    ...overrides,
  };
}

function makeGlobal(aiWorkspace: AiWorkspaceState): GlobalState {
  return {
    aiWorkspace,
  } as GlobalState;
}

describe('ai workspace sync opt-in', () => {
  it('disables sync without deleting the stored workspace snapshot', () => {
    const session: AiSessionMetadata = {
      sessionId: 'session-1',
      sourceAccountId: 'user-1',
      sourcePeerId: 'chat-1',
      // eslint-disable-next-line no-null/no-null -- Telegram represents the main thread as null.
      sourceThreadId: null,
      createdAt: '2026-08-05T00:00:00.000Z',
      titleSnapshot: 'Example chat',
      messageCount: 1,
    };
    const global = makeGlobal(makeWorkspace({
      isEnabled: true,
      workspaceChatId: 'workspace-1',
      topicMappings: {
        'chat-1': '42',
      },
      sessionsByTopicId: {
        42: session,
      },
      lastSync: 123,
      lastInitError: 'previous error',
      isInitializing: true,
    }));

    const next = setAiWorkspaceEnabled(global, false);

    expect(next.aiWorkspace?.isEnabled).toBe(false);
    expect(next.aiWorkspace?.workspaceChatId).toBe('workspace-1');
    expect(next.aiWorkspace?.topicMappings).toEqual({ 'chat-1': '42' });
    expect(next.aiWorkspace?.sessionsByTopicId).toEqual({ 42: session });
    expect(next.aiWorkspace?.lastSync).toBe(123);
    expect(next.aiWorkspace?.lastInitError).toBeUndefined();
    expect(next.aiWorkspace?.isInitializing).toBe(false);
  });

  it('keeps the workspace absent until the user opts in', () => {
    const global = makeGlobal(makeWorkspace({
      isEnabled: false,
      topicMappings: {
        'chat-1': '42',
      },
    }));

    const plan = getAiSidebarOpenPlan(global, 'chat-1');

    expect(plan.isSyncEnabled).toBe(false);
    expect(plan.workspaceChatId).toBeUndefined();
    expect(plan.topicId).toBe(0);
    expect(plan.shouldCreateTopic).toBe(false);
  });

  it('treats a sync flag without a workspace as not ready for AI prompts', () => {
    const plan = getAiSidebarOpenPlan(makeGlobal(makeWorkspace({ isEnabled: true })), 'chat-1');

    expect(plan.workspaceChatId).toBeUndefined();
    expect(plan.shouldCreateTopic).toBe(false);
  });

  it('uses the stored topic when sync is enabled', () => {
    const global = makeGlobal(makeWorkspace({
      isEnabled: true,
      workspaceChatId: 'workspace-1',
      topicMappings: {
        'chat-1': '42',
      },
    }));

    const plan = getAiSidebarOpenPlan(global, 'chat-1');

    expect(plan.isSyncEnabled).toBe(true);
    expect(plan.workspaceChatId).toBe('workspace-1');
    expect(plan.topicId).toBe(42);
    expect(plan.shouldCreateTopic).toBe(true);
  });

  it('discovers only the owner-specific archived forum workspace on another device', () => {
    const workspace = findAiWorkspaceChat([
      { id: 'wrong-title', type: 'chatTypeSuperGroup', isForum: true, title: 'Telegram AI Workspace · another-user' },
      { id: 'not-forum', type: 'chatTypeSuperGroup', title: getAiWorkspaceTitle('user-1') },
      { id: 'workspace-1', type: 'chatTypeSuperGroup', isForum: true, title: getAiWorkspaceTitle('user-1') },
    ], 'user-1');

    expect(workspace?.id).toBe('workspace-1');
  });
});
