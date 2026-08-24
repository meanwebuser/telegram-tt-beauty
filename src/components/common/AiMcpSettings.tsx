import { memo, useEffect, useState } from '../../lib/teact/teact';
import { withGlobal } from '../../global';

import { copyTextToClipboardFromPromise } from '../../util/clipboard';
import { isCurrentTabMaster, subscribeToMasterChange } from '../../util/establishMultitabRole';
import { createBrowserTelegramMcpBridge } from '../../mcp/telegramTools/browserBridge';

import useLastCallback from '../../hooks/useLastCallback';

import Button from '../ui/Button';
import Checkbox from '../ui/Checkbox';

type StateProps = {
  currentUserId?: string;
};

type McpInfo = {
  connectionId: string;
  bearer: string;
  url: string;
  allowWrite: boolean;
  userId: string;
};

type McpConnection = Pick<McpInfo, 'connectionId' | 'bearer'>;

export type McpRuntimeStatus = {
  local: 'this-tab' | 'another-tab';
  server: 'connected' | 'disconnected';
};

/**
 * Derives the user-visible locality and ownership status for browser MCP.
 *
 * @param isMasterTab Whether this tab currently owns the Telegram worker.
 * @param isRelayConnected Whether the browser MCP relay connection is active.
 * @returns The local runtime owner and server relay states.
 */
export function getMcpRuntimeStatus(isMasterTab: boolean, isRelayConnected: boolean): McpRuntimeStatus {
  return {
    local: isMasterTab ? 'this-tab' : 'another-tab',
    server: isRelayConnected ? 'connected' : 'disconnected',
  };
}

type McpEnableAttempt = McpConnection & {
  generation: number;
  userId: string;
  bridge?: ReturnType<typeof createBrowserTelegramMcpBridge>;
  cancelled: boolean;
  remoteDisabled: boolean;
};

let activeBridge: ReturnType<typeof createBrowserTelegramMcpBridge> | undefined;
let activeInfo: McpInfo | undefined;
let inFlightEnable: McpEnableAttempt | undefined;
let lifecycleGeneration = 0;

function randomToken(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, (value) => value.toString(16).padStart(2, '0')).join('');
}

function normalizedUserId(userId?: string) {
  return userId || 'browser-user';
}

function stopActiveBridge() {
  const info = activeInfo;
  activeBridge?.stop();
  activeBridge = undefined;
  activeInfo = undefined;
  return info;
}

function revokeRemoteBridge(info: McpConnection) {
  return fetch(`/_mcp-bridge/${info.connectionId}/revoke`, {
    method: 'POST',
    headers: { authorization: info.bearer },
  }).then((response) => {
    if (!response.ok) throw new Error(`MCP revoke failed: ${response.status}`);
    return response;
  });
}

async function abandonEnableAttempt(attempt: McpEnableAttempt) {
  attempt.cancelled = true;
  attempt.bridge?.stop();
  if (attempt.connectionId && !attempt.remoteDisabled) {
    attempt.remoteDisabled = true;
    await revokeRemoteBridge(attempt).catch(() => undefined);
  }
  if (inFlightEnable === attempt) inFlightEnable = undefined;
}

function AiMcpSettings({ currentUserId }: StateProps) {
  const [info, setInfo] = useState<McpInfo | undefined>(activeInfo);
  const [error, setError] = useState<string>();
  const [allowWrite, setAllowWrite] = useState(activeInfo?.allowWrite ?? false);
  const [isMasterTab, setIsMasterTab] = useState(() => isCurrentTabMaster());
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const runtimeStatus = getMcpRuntimeStatus(isMasterTab, Boolean(info));

  useEffect(() => subscribeToMasterChange(setIsMasterTab), []);

  useEffect(() => {
    if (copyState === 'idle') return undefined;
    const timeoutId = setTimeout(() => setCopyState('idle'), 2000);
    return () => clearTimeout(timeoutId);
  }, [copyState]);

  useEffect(() => () => {
    lifecycleGeneration += 1;
    if (inFlightEnable) void abandonEnableAttempt(inFlightEnable);
    const cleanupInfo = activeInfo;
    if (!cleanupInfo || cleanupInfo.userId !== normalizedUserId(currentUserId)) return;
    stopActiveBridge();
    void revokeRemoteBridge(cleanupInfo).catch(() => undefined);
  }, [currentUserId]);

  const handleEnable = useLastCallback(async () => {
    setError(undefined);
    const bearer = `Bearer ${randomToken()}`;
    const browserConnectionId = randomToken(16);
    const attempt: McpEnableAttempt = {
      generation: lifecycleGeneration + 1,
      userId: normalizedUserId(currentUserId),
      bearer,
      connectionId: '',
      cancelled: false,
      remoteDisabled: false,
    };
    lifecycleGeneration = attempt.generation;
    inFlightEnable = attempt;
    try {
      const response = await fetch('/_mcp-bridge/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          user_id: currentUserId || 'browser-user',
          bearer,
          browser_connection_id: browserConnectionId,
          allow_write: allowWrite,
        }),
      });
      if (!response.ok) throw new Error(`MCP enable failed: ${response.status}`);
      const { connection_id: connectionId } = await response.json() as { connection_id: string };
      attempt.connectionId = connectionId;
      if (!connectionId) throw new Error('MCP enable returned no connection id');
      if (attempt.cancelled || attempt.generation !== lifecycleGeneration) {
        await abandonEnableAttempt(attempt);
        return;
      }
      const bridge = createBrowserTelegramMcpBridge({
        baseUrl: window.location.origin,
        connectionId,
        bearer,
        browserConnectionId,
        allowWrite,
      });
      attempt.bridge = bridge;
      await bridge.start();
      if (attempt.cancelled || attempt.generation !== lifecycleGeneration) {
        await abandonEnableAttempt(attempt);
        return;
      }
      activeBridge = attempt.bridge;
      activeInfo = {
        connectionId,
        bearer,
        url: `${window.location.origin}/_mcp-bridge/${connectionId}/mcp`,
        allowWrite,
        userId: normalizedUserId(currentUserId),
      };
      setInfo(activeInfo);
    } catch (err) {
      await abandonEnableAttempt(attempt);
      if (!attempt.cancelled) setError(err instanceof Error ? err.message : 'MCP enable failed');
    } finally {
      if (inFlightEnable === attempt) inFlightEnable = undefined;
    }
  });

  const handleDisable = useLastCallback(async () => {
    const disableInfo = activeInfo;
    if (!disableInfo) return;
    stopActiveBridge();
    setInfo(undefined);
    setAllowWrite(false);
    setCopyState('idle');
    try {
      await revokeRemoteBridge(disableInfo);
    } catch (err) {
      activeInfo = disableInfo;
      setInfo(disableInfo);
      setError(err instanceof Error ? err.message : 'MCP disable failed');
    }
  });

  const handleCopyEndpoint = useLastCallback(() => {
    if (!info?.url) return;
    void copyTextToClipboardFromPromise(
      Promise.resolve(info.url),
      () => setCopyState('copied'),
      () => setCopyState('failed'),
    );
  });

  return (
    <div className="settings-ai-mcp">
      <p className="settings-item-description" dir="auto">
        Temporary external browser MCP exposes the already authenticated session only while this tab stays open.
        The relay proxy is required because the tab is behind NAT; the MCP client cannot connect to the tab directly.
      </p>
      <p className="settings-item-description" dir="auto">
        Local browser runtime:
        {' '}
        <code>{runtimeStatus.local === 'this-tab' ? 'owned by this tab' : 'owned by another tab'}</code>
      </p>
      <p className="settings-item-description" dir="auto">
        Server relay:
        {' '}
        <code>{runtimeStatus.server}</code>
      </p>
      {!info ? (
        <>
          <Checkbox
            label="Allow MCP to send messages"
            subLabel="Disabled by default. Reading remains available; mark-as-read and sending are blocked."
            checked={allowWrite}
            onChange={(event) => setAllowWrite(event.target.checked)}
          />
          <Button onClick={handleEnable}>Enable browser MCP</Button>
        </>
      ) : (
        <>
          <p className="settings-item-description" dir="auto">
            MCP URL:
            {' '}
            <code>{info.url}</code>
            {' '}
            <Button size="smaller" iconName="copy" onClick={handleCopyEndpoint} ariaLabel="Copy MCP endpoint">
              {copyState === 'copied' ? 'Copied' : 'Copy endpoint'}
            </Button>
          </p>
          <p className="settings-item-description" dir="auto">
            Write permission:
            {' '}
            <code>{info.allowWrite ? 'enabled' : 'disabled'}</code>
          </p>
          {copyState === 'failed' && (
            <p className="settings-item-description" dir="auto">Could not copy MCP endpoint.</p>
          )}
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
