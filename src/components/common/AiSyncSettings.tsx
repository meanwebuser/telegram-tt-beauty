import { memo } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';
import '../../global/actions/api/aiWorkspace';

import type { AiWorkspaceState } from '../../global/types/aiWorkspace';

import useLastCallback from '../../hooks/useLastCallback';

import Button from '../ui/Button';
import Checkbox from '../ui/Checkbox';

import './AiSyncSettings.scss';

type StateProps = {
  aiWorkspace?: AiWorkspaceState;
};

function AiSyncSettings({ aiWorkspace }: StateProps) {
  const { createAndEnableAiWorkspace, setAiWorkspaceEnabled } = getActions();
  const isSyncEnabled = Boolean(aiWorkspace?.isEnabled);
  const hasWorkspace = Boolean(aiWorkspace?.workspaceChatId);

  const handleSyncToggle = useLastCallback((isChecked: boolean) => {
    if (isChecked) {
      createAndEnableAiWorkspace();
      return;
    }

    setAiWorkspaceEnabled({ isEnabled: false });
  });

  const handleEnableSync = useLastCallback(() => {
    createAndEnableAiWorkspace();
  });

  return (
    <div className="ai-sync-settings">
      <Checkbox
        label="Synchronize AI history between devices"
        subLabel="Your AI history stays local by default. Turn this on to create a private Telegram forum workspace."
        checked={isSyncEnabled}
        onCheck={handleSyncToggle}
      />
      <p className="ai-sync-settings__hint" dir="auto">
        Disabling sync keeps existing history intact and only stops future synchronization.
      </p>
      {!isSyncEnabled && (
        <Button onClick={handleEnableSync}>
          {hasWorkspace ? 'Enable synchronization' : 'Create and enable synchronization'}
        </Button>
      )}
    </div>
  );
}

export default memo(withGlobal((global): StateProps => ({
  aiWorkspace: global.aiWorkspace,
}))(AiSyncSettings));
