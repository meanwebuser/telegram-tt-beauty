import { describe, expect, it, vi } from 'vitest';

import HttpStream from './HttpStream';
import PromisedWebSockets, {
  buildTelegramWsUrl,
  getTelegramTransportTimeouts,
  shouldUseTelegramProxy,
} from './PromisedWebSockets';

describe('Telegram transport runtime context', () => {
  it('allows slower startup through the Telegram proxy without changing direct limits', () => {
    expect(getTelegramTransportTimeouts(true)).toEqual({ ws: 15000, http: 30000 });
    expect(getTelegramTransportTimeouts(false)).toEqual({ ws: 3000, http: 10000 });
  });

  it('builds the proxied WebSocket URL from worker location without window', () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('location', { host: 'telegram.example.com', protocol: 'https:' });

    try {
      const socket = new PromisedWebSockets(() => {});

      expect(socket.getWebSocketLink('zws2.web.telegram.org', 443)).toBe(
        'wss://telegram.example.com/proxy/apiws/zws2.web.telegram.org/apiws',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('routes HTTP fallback requests through the same-origin proxy', () => {
    const getUrl = HttpStream.getURL as unknown as (...args: unknown[]) => string;

    expect(getUrl('zws2.web.telegram.org', 443, false, false, {
      useProxy: true,
      host: 'telegram.example.com',
      protocol: 'https:',
    })).toBe('https://telegram.example.com/proxy/apiws/zws2.web.telegram.org/apiw1');
  });
});

describe('shouldUseTelegramProxy', () => {
  it('returns true when env flag is "1" regardless of host', () => {
    expect(shouldUseTelegramProxy('1', 'localhost')).toBe(true);
    expect(shouldUseTelegramProxy('1', 'my-dev.example.com')).toBe(true);
    expect(shouldUseTelegramProxy('1', 'telegram.example.com')).toBe(true);
  });

  it('returns false when env flag is "0" even for known production hosts', () => {
    expect(shouldUseTelegramProxy('0', 'telegram.example.com')).toBe(false);
    expect(shouldUseTelegramProxy('0', 'tgb.example.com')).toBe(false);
  });

  it('returns true for telegram.example.com when env flag is empty', () => {
    expect(shouldUseTelegramProxy('', 'telegram.example.com')).toBe(true);
  });

  it('returns true for tgb.example.com when env flag is undefined', () => {
    expect(shouldUseTelegramProxy(undefined, 'tgb.example.com')).toBe(true);
  });

  it('returns false for localhost when env flag is empty', () => {
    expect(shouldUseTelegramProxy('', 'localhost')).toBe(false);
  });

  it('returns false for localhost with port when env flag is undefined', () => {
    expect(shouldUseTelegramProxy(undefined, 'localhost:1234')).toBe(false);
  });

  it('returns false for custom domains', () => {
    expect(shouldUseTelegramProxy('', 'my-custom-host.example.com')).toBe(false);
    expect(shouldUseTelegramProxy('', 'web.telegram.org')).toBe(false);
  });

  it('ignores arbitrary env-flag strings and falls through to host check', () => {
    expect(shouldUseTelegramProxy('true', 'localhost')).toBe(false);
    expect(shouldUseTelegramProxy('yes', 'telegram.example.com')).toBe(true);
    expect(shouldUseTelegramProxy('2', 'telegram.example.com')).toBe(true);
  });
});

describe('buildTelegramWsUrl — proxied', () => {
  it('routes through proxy on https page with default DC', () => {
    expect(buildTelegramWsUrl('zws1.web.telegram.org', 443, false, false, {
      useProxy: true,
      host: 'telegram.example.com',
      protocol: 'https:',
    })).toBe('wss://telegram.example.com/proxy/apiws/zws1.web.telegram.org/apiws');
  });

  it('uses ws:// scheme on http page when proxy is enabled', () => {
    expect(buildTelegramWsUrl('zws1.web.telegram.org', 443, false, false, {
      useProxy: true,
      host: 'localhost:1234',
      protocol: 'http:',
    })).toBe('ws://localhost:1234/proxy/apiws/zws1.web.telegram.org/apiws');
  });

  it('appends _test suffix when isTestServer=true', () => {
    expect(buildTelegramWsUrl('zws2.web.telegram.org', 443, true, false, {
      useProxy: true,
      host: 'telegram.example.com',
      protocol: 'https:',
    })).toBe('wss://telegram.example.com/proxy/apiws/zws2.web.telegram.org/apiws_test');
  });

  it('appends _premium suffix when isPremium=true', () => {
    expect(buildTelegramWsUrl('zws3.web.telegram.org', 443, false, true, {
      useProxy: true,
      host: 'telegram.example.com',
      protocol: 'https:',
    })).toBe('wss://telegram.example.com/proxy/apiws/zws3.web.telegram.org/apiws_premium');
  });

  it('appends _test_premium when both isTestServer and isPremium are set', () => {
    expect(buildTelegramWsUrl('zws4.web.telegram.org', 443, true, true, {
      useProxy: true,
      host: 'telegram.example.com',
      protocol: 'https:',
    })).toBe('wss://telegram.example.com/proxy/apiws/zws4.web.telegram.org/apiws_test_premium');
  });

  it('handles download-DC hostnames with -1 suffix (zws1-1)', () => {
    expect(buildTelegramWsUrl('zws1-1.web.telegram.org', 443, false, false, {
      useProxy: true,
      host: 'telegram.example.com',
      protocol: 'https:',
    })).toBe('wss://telegram.example.com/proxy/apiws/zws1-1.web.telegram.org/apiws');
  });

  it('ignores port argument when proxied (proxy always uses 443)', () => {
    // Port is ignored in proxied mode — the nginx -> proxy hop always
    // terminates on 443 and forwards to the upstream DC. Document this
    // behavior so callers don't get confused.
    expect(buildTelegramWsUrl('zws1.web.telegram.org', 80, false, false, {
      useProxy: true,
      host: 'telegram.example.com',
      protocol: 'https:',
    })).toBe('wss://telegram.example.com/proxy/apiws/zws1.web.telegram.org/apiws');
  });
});

describe('buildTelegramWsUrl — direct (no proxy)', () => {
  it('uses wss:// for port 443', () => {
    expect(buildTelegramWsUrl('zws1.web.telegram.org', 443, false, false, {
      useProxy: false,
      host: 'localhost',
      protocol: 'https:',
    })).toBe('wss://zws1.web.telegram.org:443/apiws');
  });

  it('uses ws:// for port 80', () => {
    expect(buildTelegramWsUrl('zws1.web.telegram.org', 80, false, false, {
      useProxy: false,
      host: 'localhost',
      protocol: 'http:',
    })).toBe('ws://zws1.web.telegram.org:80/apiws');
  });

  it('appends _test for test servers on direct connection', () => {
    expect(buildTelegramWsUrl('zws2.web.telegram.org', 443, true, false, {
      useProxy: false,
      host: 'localhost',
      protocol: 'https:',
    })).toBe('wss://zws2.web.telegram.org:443/apiws_test');
  });

  it('appends _premium for premium DCs on direct connection', () => {
    expect(buildTelegramWsUrl('zws3.web.telegram.org', 443, false, true, {
      useProxy: false,
      host: 'localhost',
      protocol: 'https:',
    })).toBe('wss://zws3.web.telegram.org:443/apiws_premium');
  });

  it('ignores host and protocol when not proxied', () => {
    // When useProxy=false, the host/protocol of the current page don't
    // affect the URL — we connect directly to the Telegram DC. This is
    // the local-dev path.
    expect(buildTelegramWsUrl('zws1.web.telegram.org', 443, false, false, {
      useProxy: false,
      host: 'localhost:1234',
      protocol: 'http:',
    })).toBe('wss://zws1.web.telegram.org:443/apiws');
  });
});
