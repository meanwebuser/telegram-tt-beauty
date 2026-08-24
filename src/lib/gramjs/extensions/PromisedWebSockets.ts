import { Mutex } from 'async-mutex';

import { concat } from '../../../util/encoding/buffer';

const closeError = new Error('WebSocket was closed');
const DIRECT_CONNECTION_TIMEOUT = 3000;
const PROXY_CONNECTION_TIMEOUT = 15000;
const DIRECT_HTTP_TIMEOUT = 10000;
const PROXY_HTTP_TIMEOUT = 30000;
const MAX_TIMEOUT = 30000;

export function getTelegramTransportTimeouts(useProxy: boolean): { ws: number; http: number } {
  return useProxy
    ? { ws: PROXY_CONNECTION_TIMEOUT, http: PROXY_HTTP_TIMEOUT }
    : { ws: DIRECT_CONNECTION_TIMEOUT, http: DIRECT_HTTP_TIMEOUT };
}

// Hosts behind which the telegram-tt-proxy at /proxy/ is available (see
// proxy/src/index.js on server-100, exposed via nginx at /proxy/). When
// the app is served from one of these, WebSocket connections to Telegram
// DCs are routed through the local proxy at 127.0.0.1:7777. This is
// required when direct access to web.telegram.org is blocked (corporate
// firewall / DPI / TSPU) — the proxy is the only path that works in those
// environments. The WS proxy supports per-DC routing via the path
// /proxy/apiws/<dcHost>/apiws... (the proxy extracts <dcHost> and forwards
// the rest to wss://<dcHost>/apiws...).
const PROXIED_HOSTS = new Set([
  'tg.example.com',
  'tgb.example.com',
]);

export type TelegramTransportContext = {
  useProxy: boolean;
  host: string;
  protocol: string;
};

let telegramProxyOverride: boolean | undefined;

/**
 * Overrides the build/host default for the lifetime of this client worker.
 * `undefined` restores automatic routing.
 */
export function setTelegramProxyOverride(value: boolean | undefined) {
  telegramProxyOverride = value;
}

/**
 * Decides whether to route Telegram WS connections through the local proxy.
 * Pure function — exported for testing.
 *
 * @param envFlag  Build-time `TG_USE_TELEGRAM_PROXY` value ("0" | "1" | "" | undefined)
 * @param host     `window.location.host` of the page that loaded the app
 */
export function shouldUseTelegramProxy(envFlag: string | undefined, host: string): boolean {
  if (envFlag === '1') return true;
  if (envFlag === '0') return false;
  return PROXIED_HOSTS.has(host);
}

export function getTelegramTransportContext(
  envFlag: string | undefined,
  location: Pick<Location, 'host' | 'protocol'>,
): TelegramTransportContext {
  return {
    useProxy: telegramProxyOverride ?? shouldUseTelegramProxy(envFlag, location.host),
    host: location.host,
    protocol: location.protocol,
  };
}

/**
 * Builds the WebSocket URL for a Telegram DC connection, optionally routed
 * through the local proxy at /proxy/apiws/<dcHost>/<path>. Pure function —
 * exported for testing.
 *
 * @param ip            Telegram DC hostname (e.g. "zws1.web.telegram.org")
 * @param port          Telegram DC port (443 for wss, 80 for ws)
 * @param isTestServer  Append "_test" to the apiws path
 * @param isPremium     Append "_premium" to the apiws path
 * @param options       { useProxy, host, protocol } — host/protocol come from
 *                      window.location; useProxy comes from shouldUseTelegramProxy()
 */
export function buildTelegramWsUrl(
  ip: string,
  port: number,
  isTestServer: boolean,
  isPremium: boolean,
  options: { useProxy: boolean; host: string; protocol: string },
): string {
  const path = `/apiws${isTestServer ? '_test' : ''}${isPremium ? '_premium' : ''}`;
  if (options.useProxy) {
    const wsProto = options.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProto}//${options.host}/proxy/apiws/${ip}${path}`;
  }
  if (port === 443) {
    return `wss://${ip}:${port}${path}`;
  }
  return `ws://${ip}:${port}${path}`;
}

export default class PromisedWebSockets {
  private readonly mutex = new Mutex();

  private closed: boolean;

  private timeout: number;

  private stream: Uint8Array;

  private canRead?: boolean | Promise<boolean>;

  private resolveRead: ((value?: any) => void) | undefined;

  private client: WebSocket | undefined;

  private website?: string;

  private disconnectedCallback: () => void;

  constructor(disconnectedCallback: () => void) {
    this.client = undefined;
    this.closed = true;
    this.stream = new Uint8Array(0);
    this.disconnectedCallback = disconnectedCallback;
    this.timeout = DIRECT_CONNECTION_TIMEOUT;
  }

  async readExactly(number: number) {
    let readData = new Uint8Array(0);

    while (true) {
      const thisTime = await this.read(number);
      readData = concat(readData, thisTime);
      number -= thisTime.length;
      if (!number) {
        return readData;
      }
    }
  }

  async read(number: number) {
    if (this.closed) {
      throw closeError;
    }
    await this.canRead;
    if (this.closed) {
      throw closeError;
    }
    const toReturn = this.stream.slice(0, number);
    this.stream = this.stream.slice(number);
    if (this.stream.length === 0) {
      this.canRead = new Promise((resolve) => {
        this.resolveRead = resolve;
      });
    }

    return toReturn;
  }

  async readAll() {
    if (this.closed || !await this.canRead) {
      throw closeError;
    }
    const toReturn = this.stream;
    this.stream = new Uint8Array(0);
    this.canRead = new Promise((resolve) => {
      this.resolveRead = resolve;
    });

    return toReturn;
  }

  getWebSocketLink(ip: string, port: number, isTestServer?: boolean, isPremium?: boolean) {
    const context = getTelegramTransportContext(import.meta.env.TG_USE_TELEGRAM_PROXY, globalThis.location);

    return buildTelegramWsUrl(
      ip,
      port,
      isTestServer ?? false,
      isPremium ?? false,
      context,
    );
  }

  connect(port: number, ip: string, isTestServer = false, isPremium = false) {
    this.stream = new Uint8Array(0);
    this.canRead = new Promise((resolve) => {
      this.resolveRead = resolve;
    });
    this.closed = false;
    const context = getTelegramTransportContext(import.meta.env.TG_USE_TELEGRAM_PROXY, globalThis.location);
    this.timeout = getTelegramTransportTimeouts(context.useProxy).ws;
    this.website = buildTelegramWsUrl(ip, port, isTestServer, isPremium, context);
    this.client = new WebSocket(this.website, 'binary');
    this.client.binaryType = 'arraybuffer';

    return new Promise((resolve, reject) => {
      if (!this.client) return;
      let hasResolved = false;
      let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;

      this.client.onopen = () => {
        this.receive();
        resolve(this);
        hasResolved = true;
        if (timeout) clearTimeout(timeout);
      };

      this.client.onerror = (error) => {
        // eslint-disable-next-line no-console
        console.error('WebSocket error', error);
        reject(error);
        hasResolved = true;
        if (timeout) clearTimeout(timeout);
      };

      this.client.onclose = (event) => {
        const { code, reason, wasClean } = event;
        if (code !== 1000) {
          // eslint-disable-next-line no-console
          console.error(`Socket ${ip} closed. Code: ${code}, reason: ${reason}, was clean: ${wasClean}`);
        }

        this.resolveRead?.(false);
        this.closed = true;
        if (this.disconnectedCallback) {
          this.disconnectedCallback();
        }
        hasResolved = true;
        if (timeout) clearTimeout(timeout);
      };

      timeout = setTimeout(() => {
        if (hasResolved) return;

        reject(new Error('WebSocket connection timeout'));
        this.resolveRead?.(false);
        this.closed = true;
        if (this.disconnectedCallback) {
          this.disconnectedCallback();
        }
        this.client?.close();
        this.timeout *= 2;
        this.timeout = Math.min(this.timeout, MAX_TIMEOUT);
        timeout = undefined;
      }, this.timeout);

      // CONTEST
      // Seems to not be working, at least in a web worker

      self.addEventListener('offline', () => {
        this.close();
        this.resolveRead?.(false);
      });
    });
  }

  write(data: Uint8Array) {
    if (this.closed) {
      throw closeError;
    }
    this.client?.send(new Uint8Array(data));
  }

  close() {
    this.client?.close();
    this.closed = true;
  }

  receive() {
    if (!this.client) return;
    this.client.onmessage = async (message) => {
      await this.mutex.runExclusive(async () => {
        const data = message.data instanceof ArrayBuffer
          ? new Uint8Array(message.data)
          : new Uint8Array(await new Response(message.data).arrayBuffer());
        this.stream = concat(this.stream, data);
        this.resolveRead?.(true);
      });
    };
  }
}
