import { getTelegramTransportContext } from '../lib/gramjs/extensions/PromisedWebSockets';
import { getGlobal } from '../global';

import {
  APP_CODE_NAME,
  DEBUG, IS_MOCKED_CLIENT,
} from '../config';
import { selectSharedSettings } from '../global/selectors/sharedState';
import { IS_TAURI } from './browser/globalEnvironment';
import { hasStoredSession } from './sessions';

const WEBSYNC_DOMAINS = [
  't.me',
  'telegram.me',
  'telegram.dog',
];
const WEBSYNC_VERSION = `${APP_VERSION} ${APP_CODE_NAME}`;
const WEBSYNC_KEY = 'tgme_sync';
const WEBSYNC_TIMEOUT = 86400;

const getTs = () => {
  return Math.floor(Number(new Date()) / 1000);
};

const saveSync = (authed: boolean) => {
  const ts = getTs();
  localStorage.setItem(WEBSYNC_KEY, JSON.stringify({
    canRedirect: authed,
    ts,
  }));
};

let lastTimeout: number | undefined;

function getWebsyncUrls() {
  const { shouldUseTelegramProxy } = selectSharedSettings(getGlobal());
  const context = getTelegramTransportContext(
    import.meta.env.TG_USE_TELEGRAM_PROXY,
    globalThis.location,
  );
  const useProxy = shouldUseTelegramProxy ?? context.useProxy;
  if (!useProxy) {
    return WEBSYNC_DOMAINS.map((domain) => `https://${domain}/_websync_?`);
  }

  const protocol = context.protocol === 'https:' ? 'https:' : 'http:';
  return WEBSYNC_DOMAINS.map((domain) => (
    `${protocol}//${context.host}/proxy/websync/${domain}/_websync_?`
  ));
}

export const forceWebsync = (authed: boolean) => {
  if (IS_MOCKED_CLIENT || IS_TAURI) return undefined;
  const currentTs = getTs();

  const { canRedirect, ts } = JSON.parse(localStorage.getItem(WEBSYNC_KEY) || '{}');

  if (canRedirect !== authed || ts + WEBSYNC_TIMEOUT <= currentTs) {
    return Promise.all(getWebsyncUrls().map((url) => {
      return new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');

        const removeElement = () => Boolean(document.body.removeChild(script));

        script.src = url + new URLSearchParams({
          authed: Number(authed).toString(),
          version: WEBSYNC_VERSION,
        }).toString();

        document.body.appendChild(script);

        script.onload = () => {
          saveSync(authed);
          removeElement();
          if (lastTimeout) {
            clearTimeout(lastTimeout);
            lastTimeout = undefined;
          }
          startWebsync();
          resolve();
        };

        script.onerror = () => {
          removeElement();
          reject();
        };
      });
    }));
  } else {
    return Promise.resolve();
  }
};

export function stopWebsync() {
  if (DEBUG || IS_TAURI) return;

  if (lastTimeout) clearTimeout(lastTimeout);
}

export function startWebsync() {
  if (DEBUG || IS_TAURI) {
    return;
  }

  if (lastTimeout !== undefined) return;
  const currentTs = getTs();

  const { ts } = JSON.parse(localStorage.getItem(WEBSYNC_KEY) || '{}');

  const timeout = WEBSYNC_TIMEOUT - (currentTs - ts);

  lastTimeout = setTimeout(() => {
    const { auth } = getGlobal();

    const authed = auth.state === 'authorizationStateReady' || hasStoredSession();
    forceWebsync(authed);
  }, Math.max(0, timeout * 1000));
}

export function clearWebsync() {
  localStorage.removeItem(WEBSYNC_KEY);
}
