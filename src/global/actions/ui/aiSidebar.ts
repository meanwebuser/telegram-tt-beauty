/**
 * AI Sidebar prompt actions.
 *
 * Owns the "user clicked a quick command or typed a message → call the model →
 * stream the response into the sidebar tabState" loop. Lives in the UI slice
 * because the streaming buffer is per-tab, not global.
 */

import type { ActionReturnType, GlobalState } from '../../types';

import { getCurrentTabId } from '../../../util/establishMultitabRole';
import { addActionHandler, setGlobal } from '../../index';
import {
  convertMessagesToLlmFormat,
  normalizeChatCompletionsUrl,
  sendLlmRequest,
} from '../../llm/transport';
import { executeToolCall, getToolSchemas } from '../../llm/toolRuntime';
// `updateTabState` is used by `patchAiSidebar`.
import { selectChat, selectChatMessages } from '../../selectors';

const DEFAULT_ENDPOINT = 'https://llm.example.com/v1';
const DEFAULT_MODEL = 'gemma4';
const DEFAULT_TEMPERATURE = 0.4;
const DEFAULT_MAX_TOKENS = 2048;

function buildLlmMessages(global: GlobalState, chatId: string, prompt: string) {
  const messages = selectChatMessages(global, chatId);
  const conversationSource = messages ? Object.values(messages).slice(-40) : [];
  return convertMessagesToLlmFormat(conversationSource, prompt);
}

function readAssistantSettings(global: GlobalState) {
  const ai = global.settings.byKey.aiAssistant;
  return {
    endpointUrl: ai?.endpoint?.trim() || DEFAULT_ENDPOINT,
    apiKey: ai?.apiKey?.trim() || '',
    model: ai?.model?.trim() || DEFAULT_MODEL,
    temperature: ai?.temperature ?? DEFAULT_TEMPERATURE,
    maxTokens: ai?.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
}

function patchAiSidebar<T extends GlobalState>(global: T, tabId: number, patch: Record<string, unknown>): T {
  const tab = global.byTabId[tabId];
  if (!tab) return global;
  const current = tab.aiSidebar;
  const aiSidebar = {
    ...(current ?? {}),
    chatId: current?.chatId || '',
    topicId: current?.topicId || 0,
    ...patch,
  };
  return {
    ...global,
    byTabId: {
      ...global.byTabId,
      [tabId]: {
        ...tab,
        aiSidebar,
      },
    },
  };
}

addActionHandler('sendAiPrompt', (global, actions, payload): ActionReturnType => {
  const { sourceChatId, text } = payload;
  const tabId = getCurrentTabId();

  if (!sourceChatId) return;
  if (!text?.trim()) return;
  if (!global.aiWorkspace?.isEnabled || !global.aiWorkspace?.workspaceChatId) {
    global = patchAiSidebar(global, tabId, {
      streamText: '',
      streamError: 'Cross-device sync is off. Enable synchronization in Settings first.',
      streamPending: false,
    });
    setGlobal(global);
    return;
  }

  const settings = readAssistantSettings(global);
  if (!settings.apiKey) {
    global = patchAiSidebar(global, tabId, {
      streamText: '',
      streamError: 'API key is empty. Open AI settings in the sidebar and paste your key.',
      streamPending: false,
    });
    setGlobal(global);
    return;
  }

  const messages = buildLlmMessages(global, sourceChatId, text.trim());
  const chat = selectChat(global, sourceChatId);
  if (!chat && messages.length <= 1) {
    global = patchAiSidebar(global, tabId, {
      streamText: '',
      streamError: 'Open a chat first so the model can see messages.',
      streamPending: false,
    });
    setGlobal(global);
    return;
  }

  // Reset stream and bump nonce so the sidebar clears the previous buffer.
  global = patchAiSidebar(global, tabId, {
    streamText: '',
    streamError: undefined,
    streamPending: true,
    streamNonce: (global.byTabId[tabId]?.aiSidebar?.streamNonce ?? 0) + 1,
  });
  setGlobal(global);

  // Spawn the streaming call; progress is dispatched back through dedicated
  // actions so each call site follows the setGlobal(global) idiom the
  // multi-tab linter requires.
  void (async () => {
    const streamRequest = {
      endpointUrl: settings.endpointUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      stream: true,
      tools: getToolSchemas(),
      executeToolCall: (toolName: string, argumentsJson: string) => executeToolCall(toolName, argumentsJson),
    };
    await sendLlmRequest(streamRequest, messages, (chunk, isDone, err) => {
      if (err) {
        actions.reportAiStreamError({ error: err, tabId });
      } else {
        actions.appendAiStreamChunk({
          text: chunk,
          isDone,
          tabId,
        });
      }
    });
  })();

  return undefined;
});

addActionHandler('appendAiStreamChunk', (global, actions, payload): ActionReturnType => {
  const { text, isDone, tabId = getCurrentTabId() } = payload;
  global = patchAiSidebar(global, tabId, {
    streamText: text,
    streamPending: !isDone,
    streamError: undefined,
  });
  setGlobal(global);
  return undefined;
});

addActionHandler('reportAiStreamError', (global, actions, payload): ActionReturnType => {
  const { error, tabId = getCurrentTabId() } = payload;
  global = patchAiSidebar(global, tabId, {
    streamError: error,
    streamPending: false,
  });
  setGlobal(global);
  return undefined;
});

addActionHandler('cancelAiPrompt', (global): ActionReturnType => {
  const tabId = getCurrentTabId();
  global = patchAiSidebar(global, tabId, { streamPending: false });
  setGlobal(global);
  return undefined;
});

export const __testHelpers = {
  buildLlmMessages,
  readAssistantSettings,
  normalizeChatCompletionsUrl,
};
