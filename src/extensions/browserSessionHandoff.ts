import { Api as GramJs } from '../lib/gramjs';

import type { invokeRequest as InvokeRequestFn } from '../api/gramjs/methods/client';

import { TELEGRAM_API_HASH, TELEGRAM_API_ID } from '../config';

export type BrowserSessionHandoffResult = {
  redirectUrl: string;
};

export type BrowserSessionHandoffInvoke = typeof InvokeRequestFn;

async function resolveBrowserSessionHandoffInvoke(
  invoke?: BrowserSessionHandoffInvoke,
): Promise<BrowserSessionHandoffInvoke> {
  if (invoke) return invoke;
  // Lazy resolution avoids a static import from extensions into the gramjs
  // client module and keeps both layers independently loadable.
  const module = await import('../api/gramjs/methods/client');
  return module.invokeRequest;
}

export const BROWSER_HANDOFF_CLAIM_PREFIX = 'tt-browser-handoff-claim:';
export const BROWSER_HANDOFF_AUTO_AUTHORIZE_PREFIX = 'tt-browser-handoff-auto:';
export const BROWSER_HANDOFF_AUTO_AUTHORIZE_QUERY = 'handoff_auto';

export function getBrowserHandoffStorageKey(prefix: string, handoffId: string) {
  return `${prefix}${handoffId}`;
}

export function getBrowserHandoffAutoAuthorizeUrl(url: string) {
  const target = new URL(url);
  target.searchParams.set(BROWSER_HANDOFF_AUTO_AUTHORIZE_QUERY, '1');
  return target.toString();
}

export type AuthorizeBrowserSessionOptions = {
  handoffId: string;
  invoke?: BrowserSessionHandoffInvoke;
};

export async function authorizeBrowserSession({
  handoffId,
  invoke,
}: AuthorizeBrowserSessionOptions): Promise<BrowserSessionHandoffResult | undefined> {
  const invokeFn = await resolveBrowserSessionHandoffInvoke(invoke);
  const result = await invokeFn(new GramJs.auth.ExportLoginToken({
    apiId: TELEGRAM_API_ID,
    apiHash: TELEGRAM_API_HASH!,
    exceptIds: [],
  }));

  let token: Uint8Array | undefined;
  let dcId: number | undefined;
  if (result instanceof GramJs.auth.LoginToken) {
    token = result.token;
  } else if (result instanceof GramJs.auth.LoginTokenMigrateTo) {
    token = result.token;
    dcId = result.dcId;
  }

  if (!token) return undefined;

  const response = await fetch(new URL('/oauth/authorize/browser-session', self.location.origin), {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      handoff_id: handoffId,
      token: encodeBase64Url(token),
      dc_id: dcId,
    }),
  });
  if (!response.ok) return undefined;

  const payload: unknown = await response.json();
  if (!isBrowserSessionRedirect(payload)) return undefined;

  return { redirectUrl: payload.redirect_url };
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function isBrowserSessionRedirect(payload: unknown): payload is { redirect_url: string } {
  if (!payload || typeof payload !== 'object' || !('redirect_url' in payload)) return false;

  const redirectUrl = payload.redirect_url;
  if (typeof redirectUrl !== 'string' || !redirectUrl) return false;

  try {
    const parsedUrl = new URL(redirectUrl);
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
  } catch {
    return false;
  }
}
