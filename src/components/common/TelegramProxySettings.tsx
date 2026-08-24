import { shouldUseTelegramProxy as getDefaultTelegramProxy } from '../../lib/gramjs/extensions/PromisedWebSockets';
import { memo } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import Checkbox from '../ui/Checkbox';

type StateProps = {
  shouldUseTelegramProxy?: boolean;
};

const TelegramProxySettings = ({ shouldUseTelegramProxy }: StateProps) => {
  const { setSharedSettingOption } = getActions();
  const defaultUseProxy = getDefaultTelegramProxy(
    import.meta.env.TG_USE_TELEGRAM_PROXY,
    globalThis.location?.host || '',
  );
  const useProxy = shouldUseTelegramProxy ?? defaultUseProxy;
  const subLabel = useProxy
    ? [
      'Telegram messages and account traffic use the app’s one configured proxy. ',
      'This is separate from browser MCP and Boyk AI/BYOK.',
    ].join('')
    : [
      'Telegram traffic connects directly from this browser. Browser MCP may still use its ',
      'external NAT relay, and Boyk AI/BYOK does not use this proxy.',
    ].join('');

  return (
    <Checkbox
      label="Route Telegram traffic through this proxy"
      subLabel={subLabel}
      checked={useProxy}
      onCheck={() => setSharedSettingOption({ shouldUseTelegramProxy: !useProxy })}
    />
  );
};

export default memo(withGlobal(
  (global): Complete<StateProps> => ({
    shouldUseTelegramProxy: (global).sharedState.settings.shouldUseTelegramProxy,
  }),
)(TelegramProxySettings));
