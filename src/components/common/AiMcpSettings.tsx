import { memo, useState } from '../../lib/teact/teact';
import { withGlobal } from '../../global';

import { copyTextToClipboard } from '../../util/clipboard';
import { createBrowserTelegramMcpBridge } from '../../mcp/telegramTools/browserBridge';

import useLastCallback from '../../hooks/useLastCallback';

import Button from '../ui/Button';

type StateProps = {
  currentUserId?: string;
};

type McpInfo = {
  connectionId: string;
  bearer: string;
  url: string;
};

let activeBridge: ReturnType<typeof createBrowserTelegramMcpBridge> | undefined;
let activeInfo: McpInfo | undefined;

function randomToken(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, (value) => value.toString(16).padStart(2, '0')).join('');
}

function AiMcpSettings({ currentUserId }: StateProps) {
  const [info, setInfo] = useState<McpInfo | undefined>(activeInfo);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState<'url' | 'bearer'>();

  const handleCopy = useLastCallback((kind: 'url' | 'bearer') => {
    if (!activeInfo) return;
    copyTextToClipboard(activeInfo[kind]);
    setCopied(kind);
    setTimeout(() => setCopied(undefined), 1500);
  });

  const handleEnable = useLastCallback(async () => {
    setError(undefined);
    const bearer = `Bearer ${randomToken()}`;
    const browserConnectionId = randomToken(16);
    try {
      const response = await fetch('/_mcp-bridge/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          user_id: currentUserId || 'browser-user',
          bearer,
          browser_connection_id: browserConnectionId,
        }),
      });
      if (!response.ok) throw new Error(`MCP enable failed: ${response.status}`);
      const { connection_id: connectionId } = await response.json() as { connection_id: string };
      const bridge = createBrowserTelegramMcpBridge({
        baseUrl: window.location.origin,
        connectionId,
        bearer,
        browserConnectionId,
      });
      await bridge.start();
      activeBridge = bridge;
      activeInfo = {
        connectionId,
        bearer,
        url: `${window.location.origin}/_mcp-bridge/${connectionId}/mcp`,
      };
      setInfo(activeInfo);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'MCP enable failed');
    }
  });

  const handleDisable = useLastCallback(async () => {
    if (!activeInfo) return;
    try {
      await fetch(`/_mcp-bridge/${activeInfo.connectionId}/disable`, {
        method: 'POST',
        headers: { authorization: activeInfo.bearer },
      });
    } finally {
      activeBridge?.stop();
      activeBridge = undefined;
      activeInfo = undefined;
      setInfo(undefined);
    }
  });

  return (
    <div className="settings-ai-mcp">
      <p className="settings-item-description" dir="auto">
        Expose the already authenticated browser Telegram session to an MCP client while this tab stays open.
      </p>
      {!info ? (
        <Button onClick={handleEnable}>Enable browser MCP</Button>
      ) : (
        <>
          <div className="settings-ai-mcp-secret" dir="ltr">
            <p className="settings-item-description">MCP URL:</p>
            <div className="settings-ai-mcp-value-row">
              <code className="settings-ai-mcp-value" tabIndex={0}>{info.url}</code>
              <Button
                size="smaller"
                color="secondary"
                noForcedUpperCase
                onClick={() => handleCopy('url')}
              >
                {copied === 'url' ? 'Copied' : 'Copy URL'}
              </Button>
            </div>
          </div>
          <div className="settings-ai-mcp-secret" dir="ltr">
            <p className="settings-item-description">Bearer:</p>
            <div className="settings-ai-mcp-value-row">
              <code className="settings-ai-mcp-value" tabIndex={0}>{info.bearer}</code>
              <Button
                size="smaller"
                color="secondary"
                noForcedUpperCase
                onClick={() => handleCopy('bearer')}
              >
                {copied === 'bearer' ? 'Copied' : 'Copy Bearer'}
              </Button>
            </div>
          </div>
          <Button onClick={handleDisable}>Disable browser MCP</Button>
        </>
      )}
      {error && <p className="settings-item-description" dir="auto">{error}</p>}
    </div>
  );
}

export default memo(withGlobal((global): StateProps => ({
  currentUserId: global.currentUserId,
}))(AiMcpSettings));
