import type { ChangeEvent } from 'react';
import { memo } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { AiAssistantSettings } from '../../../types';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import AiMcpSettings from '../../common/AiMcpSettings';
import AiSyncSettings from '../../common/AiSyncSettings';
import TelegramProxySettings from '../../common/TelegramProxySettings';
import Island, { IslandTitle } from '../../gili/layout/Island';
import Checkbox from '../../ui/Checkbox';
import InputText from '../../ui/InputText';

import './SettingsAiAssistant.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: NoneToVoidFunction;
};

type StateProps = {
  aiAssistant?: AiAssistantSettings;
};

const DEFAULT_AI_ASSISTANT_SETTINGS: Required<AiAssistantSettings> = {
  isEnabled: false,
  apiKey: '',
  endpoint: 'https://llm.example.com/v1',
  model: 'gemma4',
  stream: false,
  temperature: 0.4,
  maxTokens: 2048,
};

function normalizeSettings(settings?: AiAssistantSettings): Required<AiAssistantSettings> {
  return {
    ...DEFAULT_AI_ASSISTANT_SETTINGS,
    ...settings,
  };
}

const SettingsAiAssistant = ({
  isActive,
  aiAssistant,
  onReset,
}: OwnProps & StateProps) => {
  const { setSettingOption } = getActions();
  const lang = useLang();
  const settings = normalizeSettings(aiAssistant);

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  const updateAiSettings = useLastCallback((update: Partial<AiAssistantSettings>) => {
    setSettingOption({
      aiAssistant: {
        ...settings,
        ...update,
      },
    });
  });

  const handleEnabledChange = useLastCallback((isEnabled: boolean) => {
    updateAiSettings({ isEnabled });
  });

  const handleApiKeyChange = useLastCallback((event: ChangeEvent<HTMLInputElement>) => {
    updateAiSettings({ apiKey: event.currentTarget.value.trim() });
  });

  const handleEndpointChange = useLastCallback((event: ChangeEvent<HTMLInputElement>) => {
    updateAiSettings({ endpoint: event.currentTarget.value.trim() });
  });

  const handleModelChange = useLastCallback((event: ChangeEvent<HTMLInputElement>) => {
    updateAiSettings({ model: event.currentTarget.value.trim() });
  });

  return (
    <div className="settings-content custom-scroll">
      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>BYOK</IslandTitle>
      <Island>
        <Checkbox
          label="Enable AI Assistant"
          subLabel="Use your own API key for summaries, chat questions, and future AI tools."
          checked={settings.isEnabled}
          onCheck={handleEnabledChange}
        />
      </Island>

      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>Provider</IslandTitle>
      <Island>
        <div className="settings-ai-assistant-form">
          <div className="settings-ai-assistant-secret input-group with-label touched">
            <input
              className="form-control"
              type="password"
              dir="auto"
              value={settings.apiKey}
              placeholder="sk-..."
              autoComplete="off"
              onChange={handleApiKeyChange}
              aria-label="API key"
            />
            <label>API key</label>
          </div>
          <InputText
            value={settings.endpoint}
            label="Base URL / Endpoint"
            placeholder="https://llm.example.com/v1"
            inputMode="url"
            onChange={handleEndpointChange}
          />
          <InputText
            value={settings.model}
            label="Model"
            placeholder="gemma4"
            onChange={handleModelChange}
          />
        </div>
      </Island>

      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>Cross-device sync</IslandTitle>
      <Island>
        <AiSyncSettings />
      </Island>

      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>Browser MCP</IslandTitle>
      <Island>
        <AiMcpSettings />
      </Island>

      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>Telegram connection</IslandTitle>
      <Island>
        <TelegramProxySettings />
      </Island>

      <p className="settings-item-description" dir="auto">
        The key is stored in this browser account cache. AI actions are disabled until this is enabled.
        Sending or changing messages will require explicit confirmation in later steps.
        See the network and locality contract for the exact difference between Telegram proxy,
        browser MCP relay, and direct BYOK traffic.
      </p>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    return {
      aiAssistant: global.settings.byKey.aiAssistant,
    };
  },
)(SettingsAiAssistant));
