/**
 * AI Sidebar Component
 *
 * Right sidebar panel for AI conversations backed by the user's configured
 * OpenAI-compatible endpoint (e.g. https://llm.example.com/v1). Quick
 * commands and typed messages both go through `sendAiPrompt`. Streamed
 * model output and the latest error are kept in tabState so they survive
 * a re-render but don't leak across tabs or chats.
 */

import type { FC } from '../../lib/teact/teact';
import type React from '../../lib/teact/teact';
import { memo, useEffect, useRef, useState } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';
import '../../global/actions/api/aiWorkspace';

import type { ApiMessage } from '../../api/types';

import { selectChatMessages } from '../../global/selectors';
import { selectAiWorkspace } from '../../global/selectors/aiWorkspace';
import { selectTabState } from '../../global/selectors/tabs';
import buildClassName from '../../util/buildClassName';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import AiSyncSettings from '../common/AiSyncSettings';

import styles from './AiSidebar.module.scss';

const SEND_KEY = 'Enter';

const DEFAULT_ENDPOINT = 'https://llm.example.com/v1';
const DEFAULT_MODEL = 'gemma4';

const QUICK_COMMANDS = [
  { id: 'summarizeNew', labelKey: 'AiSidebar.QuickCommandSummarizeNew' },
  { id: 'summarizeAll', labelKey: 'AiSidebar.QuickCommandSummarizeAll' },
  { id: 'keyPoints', labelKey: 'AiSidebar.QuickCommandKeyPoints' },
  { id: 'actionItems', labelKey: 'AiSidebar.QuickCommandActionItems' },
  { id: 'translate', labelKey: 'AiSidebar.QuickCommandTranslate' },
] as const;

type OwnProps = {
  chatId?: string;
  isActive?: boolean;
  onClose: NoneToVoidFunction;
};

type StateProps = {
  isEnabled: boolean;
  hasWorkspace: boolean;
  isInitializing?: boolean;
  lastInitError?: string;
  topicId?: number;
  messages: ApiMessage[];
  endpoint: string;
  model: string;
  apiKeySet: boolean;
  streamText?: string;
  streamError?: string;
  streamPending?: boolean;
  streamNonce?: number;
};

const AiSidebar: FC<OwnProps & StateProps> = ({
  chatId,
  isEnabled,
  hasWorkspace,
  isInitializing,
  lastInitError,
  onClose,
  messages,
  endpoint,
  model,
  apiKeySet,
  streamText,
  streamError,
  streamPending,
  streamNonce,
}) => {
  const {
    createAndEnableAiWorkspace,
    initializeAiWorkspace,
    sendAiPrompt,
    cancelAiPrompt,
    setAiAssistantSettings,
  } = getActions();
  const lang = useLang();
  const [inputText, setInputText] = useState('');
  const [endpointDraft, setEndpointDraft] = useState(endpoint);
  const [modelDraft, setModelDraft] = useState(model);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [showSettings, setShowSettings] = useState(!apiKeySet);
  const containerRef = useRef<HTMLDivElement>();
  const messagesEndRef = useRef<HTMLDivElement>();

  const areMessagesLoaded = Boolean(streamText) || Boolean(streamError) || messages.length > 0;

  useEffect(() => {
    if (!isEnabled || !hasWorkspace || isInitializing) return;
    initializeAiWorkspace();
  }, [hasWorkspace, isEnabled, isInitializing, initializeAiWorkspace]);

  useEffect(() => {
    setEndpointDraft(endpoint);
    setModelDraft(model);
  }, [endpoint, model]);

  // Reset local draft key when the prompt changes so a new quick-command
  // doesn't lock onto the previous prompt's stream.
  useEffect(() => {
    setInputText('');
  }, [streamNonce]);

  // Auto-scroll streamed output into view as it arrives.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [streamText, streamError]);

  const submitText = useLastCallback((text: string) => {
    if (!text.trim() || !chatId) return;
    sendAiPrompt({ sourceChatId: chatId, text });
  });

  const handleQuickCommand = useLastCallback((commandId: string) => {
    if (!chatId) return;
    if (!apiKeySet) {
      setShowSettings(true);
      return;
    }
    const prompts: Record<string, string> = {
      summarizeNew: lang('AiSidebar.PromptSummarizeNew'),
      summarizeAll: lang('AiSidebar.PromptSummarizeAll'),
      keyPoints: lang('AiSidebar.PromptKeyPoints'),
      actionItems: lang('AiSidebar.PromptActionItems'),
      translate: lang('AiSidebar.PromptTranslate'),
    };
    const prompt = prompts[commandId] || commandId;
    submitText(prompt);
  });

  const handleSendPrompt = useLastCallback(() => {
    if (!apiKeySet) {
      setShowSettings(true);
      return;
    }
    submitText(inputText);
    setInputText('');
  });

  const handleKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === SEND_KEY && !e.shiftKey) {
      e.preventDefault();
      handleSendPrompt();
    }
  });

  const handleSaveSettings = useLastCallback(() => {
    setAiAssistantSettings({
      endpoint: endpointDraft.trim() || DEFAULT_ENDPOINT,
      model: modelDraft.trim() || DEFAULT_MODEL,
      apiKey: apiKeyDraft.trim() || undefined,
    });
    setApiKeyDraft('');
    setShowSettings(false);
  });

  const handleCancelPrompt = useLastCallback(() => {
    cancelAiPrompt();
  });

  const handleRetry = useLastCallback(() => {
    initializeAiWorkspace();
  });

  const handleEnableSync = useLastCallback(() => {
    createAndEnableAiWorkspace();
  });

  const renderHeader = (rightSlot?: React.ReactNode) => (
    <header className={styles.header}>
      <h2 className={styles.headerTitle}>AI Assistant</h2>
      <div className={styles.headerRight}>
        {rightSlot}
        <button
          type="button"
          className={styles.headerClose}
          onClick={onClose}
          aria-label={lang('Close')}
        >
          ×
        </button>
      </div>
    </header>
  );

  if (!isEnabled || !hasWorkspace) {
    return (
      <div className={styles.container}>
        {renderHeader()}
        <div className={styles.emptyState}>
          <div className={styles.emptyStateTitle}>
            {isEnabled ? 'Create your sync workspace' : 'Cross-device sync is off'}
          </div>
          <div className={styles.emptyStateText}>
            {/* eslint-disable-next-line @stylistic/max-len */}
            Local AI stays on this device. Create a private Telegram forum workspace to synchronize your AI history between devices.
          </div>
          {lastInitError && <div className={styles.errorText}>{lastInitError}</div>}
          <button type="button" className={styles.retryButton} onClick={handleEnableSync}>
            Create and enable synchronization
          </button>
        </div>
      </div>
    );
  }

  if (isInitializing) {
    return (
      <div className={styles.container} ref={containerRef}>
        {renderHeader()}
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <div className={styles.loadingText}>{lang('AiSidebar.Loading')}</div>
        </div>
      </div>
    );
  }

  if (lastInitError) {
    return (
      <div className={styles.container} ref={containerRef}>
        {renderHeader()}
        <div className={styles.errorState}>
          <div className={styles.errorText}>{lastInitError}</div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container} ref={containerRef}>
      {renderHeader(
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => setShowSettings((v) => !v)}
          aria-label={lang('AiSidebar.OpenSettings')}
        >
          ⚙
        </button>,
      )}

      {showSettings && (
        <div className={styles.settingsPanel}>
          <label className={styles.settingsLabel}>
            <span>{lang('AiSidebar.SettingsEndpoint')}</span>
            <input
              className={styles.settingsInput}
              value={endpointDraft}
              onChange={(e) => setEndpointDraft(e.target.value)}
              placeholder={DEFAULT_ENDPOINT}
              inputMode="url"
              autoComplete="off"
            />
          </label>
          <label className={styles.settingsLabel}>
            <span>{lang('AiSidebar.SettingsModel')}</span>
            <input
              className={styles.settingsInput}
              value={modelDraft}
              onChange={(e) => setModelDraft(e.target.value)}
              placeholder={DEFAULT_MODEL}
              autoComplete="off"
            />
          </label>
          <label className={styles.settingsLabel}>
            <span>{lang('AiSidebar.SettingsApiKey')}</span>
            <input
              className={styles.settingsInput}
              type="password"
              value={apiKeyDraft}
              onChange={(e) => setApiKeyDraft(e.target.value)}
              placeholder={apiKeySet ? '•••••••' : 'sk-...'}
              autoComplete="off"
            />
          </label>
          <AiSyncSettings />
          <div className={styles.settingsActions}>
            <button
              type="button"
              className={styles.retryButton}
              onClick={handleSaveSettings}
            >
              {lang('AiSidebar.SettingsSave')}
            </button>
            {!apiKeySet && (
              <span className={styles.settingsHint}>{lang('AiSidebar.SettingsHint')}</span>
            )}
          </div>
        </div>
      )}

      {!apiKeySet && !showSettings && (
        <div className={styles.emptyState}>
          <div className={styles.emptyStateTitle}>{lang('AiSidebar.ApiKeyRequiredTitle')}</div>
          <div className={styles.emptyStateText}>{lang('AiSidebar.ApiKeyRequiredText')}</div>
          <button
            type="button"
            className={styles.retryButton}
            onClick={() => setShowSettings(true)}
          >
            {lang('AiSidebar.OpenSettings')}
          </button>
        </div>
      )}

      {apiKeySet && !areMessagesLoaded && (
        <div className={styles.quickCommands}>
          <div className={styles.quickCommandsTitle}>{lang('AiSidebar.QuickCommandsTitle')}</div>
          <div className={styles.quickCommandsList}>
            {QUICK_COMMANDS.map(({ id, labelKey }) => (
              <button
                key={id}
                type="button"
                className={styles.quickCommand}
                onClick={() => handleQuickCommand(id)}
              >
                {lang(labelKey)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className={styles.messagesList}>
        {streamError && (
          <div className={styles.errorBanner}>
            <span>{streamError}</span>
            <button
              type="button"
              className={styles.errorBannerRetry}
              onClick={handleRetry}
            >
              {lang('AiSidebar.Retry')}
            </button>
          </div>
        )}
        {streamText && (
          <div className={buildClassName(styles.message, styles.messageAssistant)}>
            <div className={styles.messageHeader}>
              <span className={styles.messageSender}>{lang('AiSidebar.Assistant')}</span>
              {streamPending && (
                <span className={styles.messageStreaming}>{lang('AiSidebar.Streaming')}</span>
              )}
            </div>
            <div className={styles.messageText}>{streamText}</div>
          </div>
        )}
        {!streamText && !streamError && messages.length === 0 && (
          <div className={styles.emptyState}>
            <div className={styles.emptyStateTitle}>{lang('AiSidebar.EmptyTitle')}</div>
            <div className={styles.emptyStateText}>{lang('AiSidebar.EmptyText')}</div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {streamPending && (
        <button
          type="button"
          className={styles.cancelButton}
          onClick={handleCancelPrompt}
        >
          {lang('AiSidebar.Cancel')}
        </button>
      )}

      <div className={styles.inputArea}>
        <textarea
          className={styles.input}
          placeholder={lang('AiSidebar.InputPlaceholder')}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        <button
          type="button"
          className={buildClassName(
            styles.sendButton,
            (!inputText.trim() || !apiKeySet) && styles.sendButtonDisabled,
          )}
          onClick={handleSendPrompt}
          disabled={!inputText.trim() || !apiKeySet}
        >
          {lang('AiSidebar.Send')}
        </button>
      </div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>((global, { chatId }) => {
  const aiWorkspace = selectAiWorkspace(global);
  const chatMessages = chatId ? selectChatMessages(global, chatId) : undefined;
  const loadedMessages = chatMessages
    ? Object.values(chatMessages).filter((m) => m.content?.text?.text)
    : [];
  const ai = global.settings.byKey.aiAssistant || {};
  const tabState = selectTabState(global);
  const stream = (tabState.aiSidebar ?? {}) as NonNullable<typeof tabState.aiSidebar>;

  return {
    isEnabled: aiWorkspace?.isEnabled ?? false,
    hasWorkspace: Boolean(aiWorkspace?.workspaceChatId),
    isInitializing: aiWorkspace?.isInitializing,
    lastInitError: aiWorkspace?.lastInitError,
    topicId: chatId ? aiWorkspace?.topicMappings?.[chatId] : undefined,
    messages: loadedMessages as unknown as ApiMessage[],
    endpoint: ai.endpoint?.trim() || DEFAULT_ENDPOINT,
    model: ai.model?.trim() || DEFAULT_MODEL,
    apiKeySet: Boolean(ai.apiKey?.trim()),
    streamText: stream.streamText,
    streamError: stream.streamError,
    streamPending: stream.streamPending,
    streamNonce: stream.streamNonce,
  };
})(AiSidebar));
