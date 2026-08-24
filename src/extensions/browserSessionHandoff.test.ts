import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Api as GramJs } from '../lib/gramjs';

import {
  authorizeBrowserSession,
  type BrowserSessionHandoffInvoke,
  getBrowserHandoffAutoAuthorizeUrl,
} from './browserSessionHandoff';

const HANDSHAKE_BYTES = new Uint8Array([1, 2, 3, 4]);

type FetchMock = ReturnType<typeof vi.fn>;

function buildInvokeMock(overrides: Partial<GramJs.auth.LoginToken | GramJs.auth.LoginTokenMigrateTo> = {}) {
  return vi.fn(() => {
    return new GramJs.auth.LoginToken({
      token: HANDSHAKE_BYTES,
      ...overrides,
    } as ConstructorParameters<typeof GramJs.auth.LoginToken>[0]);
  });
}

function buildFetchMock(handlers: Array<{ ok: boolean; body: unknown }>) {
  const mock = vi.fn<Parameters<typeof fetch>, Promise<Response>>();
  let index = 0;
  mock.mockImplementation(() => {
    const handler = handlers[Math.min(index, handlers.length - 1)];
    index += 1;
    return {
      ok: handler.ok,
      json: () => Promise.resolve(handler.body),
    } as Response;
  });
  return mock;
}

describe('authorizeBrowserSession', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('exports a function that resolves to undefined when the invoke result has no token', async () => {
    const invoke: BrowserSessionHandoffInvoke = vi.fn(() => undefined) as unknown as BrowserSessionHandoffInvoke;
    const fetchMock: FetchMock = buildFetchMock([{ ok: true, body: { redirect_url: 'https://example.com' } }]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await authorizeBrowserSession({ handoffId: 'abc', invoke });

    expect(result).toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reuses the injected invoke function and skips the lazy client.ts import', async () => {
    const invoke: BrowserSessionHandoffInvoke = buildInvokeMock() as unknown as BrowserSessionHandoffInvoke;
    const fetchMock: FetchMock = buildFetchMock([{ ok: true, body: { redirect_url: 'https://oauth.example.com/x' } }]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await authorizeBrowserSession({ handoffId: 'handoff-1', invoke });

    expect(result).toEqual({ redirectUrl: 'https://oauth.example.com/x' });
    expect(invoke).toHaveBeenCalledTimes(1);
    const [requestArg] = (invoke as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(requestArg).toBeInstanceOf(GramJs.auth.ExportLoginToken);
  });

  it('returns undefined when the handoff endpoint responds with a non-2xx status', async () => {
    const invoke: BrowserSessionHandoffInvoke = buildInvokeMock() as unknown as BrowserSessionHandoffInvoke;
    const fetchMock: FetchMock = buildFetchMock([{ ok: false, body: { error: 'forbidden' } }]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await authorizeBrowserSession({ handoffId: 'handoff-2', invoke });

    expect(result).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [urlArg, initArg] = fetchMock.mock.calls[0];
    expect(String(urlArg)).toContain('/oauth/authorize/browser-session');
    expect(initArg.method).toBe('POST');
    expect(initArg.credentials).toBe('same-origin');
    expect(JSON.parse(initArg.body)).toEqual({
      handoff_id: 'handoff-2',
      token: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      dc_id: undefined,
    });
  });

  it('rejects redirect URLs that are not http or https', async () => {
    const invoke: BrowserSessionHandoffInvoke = buildInvokeMock() as unknown as BrowserSessionHandoffInvoke;
    const fetchMock: FetchMock = buildFetchMock([{ ok: true, body: { redirect_url: 'javascript:alert(1)' } }]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await authorizeBrowserSession({ handoffId: 'handoff-3', invoke });

    expect(result).toBeUndefined();
  });

  it('rejects payloads that do not match the redirect contract', async () => {
    const invoke: BrowserSessionHandoffInvoke = buildInvokeMock() as unknown as BrowserSessionHandoffInvoke;
    const fetchMock: FetchMock = buildFetchMock([{ ok: true, body: { foo: 'bar' } }]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await authorizeBrowserSession({ handoffId: 'handoff-4', invoke });

    expect(result).toBeUndefined();
  });
});

describe('browser handoff continuation', () => {
  it('adds an explicit auto-authorize marker without dropping the account slot or handoff id', () => {
    const result = getBrowserHandoffAutoAuthorizeUrl(
      'https://tgb.example.com/?handoff_id=test-handoff&account=2#login',
    );
    const url = new URL(result);

    expect(url.searchParams.get('handoff_id')).toBe('test-handoff');
    expect(url.searchParams.get('account')).toBe('2');
    expect(url.searchParams.get('handoff_auto')).toBe('1');
    expect(url.hash).toBe('#login');
  });
});
