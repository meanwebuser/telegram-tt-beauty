import { concat } from '../../../util/encoding/buffer';

import {
  getTelegramTransportContext,
  getTelegramTransportTimeouts,
  type TelegramTransportContext,
} from './PromisedWebSockets';

const closeError = new Error('HttpStream was closed');

AbortSignal.timeout ??= function timeout(ms) {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
};

export default class HttpStream {
  private url: string | undefined;

  private isClosed: boolean;

  private stream: Uint8Array[] = [];

  private canRead: Promise<void> = Promise.resolve();

  private resolveRead: VoidFunction | undefined;

  private rejectRead: VoidFunction | undefined;

  private disconnectedCallback: VoidFunction | undefined;

  private requestTimeout = 10000;

  constructor(disconnectedCallback: VoidFunction) {
    this.isClosed = true;
    this.disconnectedCallback = disconnectedCallback;
  }

  async readExactly(number: number) {
    let readData = new Uint8Array(0);

    while (true) {
      const thisTime = await this.read();
      readData = concat(readData, thisTime);
      number -= thisTime.length;
      if (number <= 0) {
        return readData;
      }
    }
  }

  async read() {
    await this.canRead;

    const data = this.stream.shift()!;
    if (this.stream.length === 0) {
      this.canRead = new Promise((resolve, reject) => {
        this.resolveRead = resolve;
        this.rejectRead = reject;
      });
    }

    return data;
  }

  static getURL(
    ip: string,
    port: number,
    isTestServer?: boolean,
    isPremium?: boolean,
    context?: TelegramTransportContext,
  ) {
    const path = `/apiw1${isTestServer ? '_test' : ''}${isPremium ? '_premium' : ''}`;
    if (context?.useProxy) {
      const httpProto = context.protocol === 'https:' ? 'https:' : 'http:';
      return `${httpProto}//${context.host}/proxy/apiws/${ip}${path}`;
    }

    if (port === 443) {
      return `https://${ip}:${port}${path}`;
    }
    return `http://${ip}:${port}${path}`;
  }

  async connect(port: number, ip: string, isTestServer = false, isPremium = false) {
    this.stream = [];
    this.canRead = new Promise((resolve, reject) => {
      this.resolveRead = resolve;
      this.rejectRead = reject;
    });
    const context = getTelegramTransportContext(import.meta.env.TG_USE_TELEGRAM_PROXY, globalThis.location);
    this.requestTimeout = getTelegramTransportTimeouts(context.useProxy).http;
    this.url = HttpStream.getURL(ip, port, isTestServer, isPremium, context);

    await fetch(this.url, {
      method: 'POST',
      body: new Uint8Array(0),
      mode: 'cors',
      signal: AbortSignal.timeout(this.requestTimeout),
    });

    this.isClosed = false;
  }

  write(data: Uint8Array) {
    if (this.isClosed || !this.url) {
      this.handleDisconnect();
      throw closeError;
    }

    return fetch(this.url, {
      method: 'POST',
      body: new Uint8Array(data),
      mode: 'cors',
      signal: AbortSignal.timeout(this.requestTimeout),
    }).then(async (response) => {
      if (this.isClosed) {
        this.handleDisconnect();
        return;
      }
      if (response.status !== 200) {
        throw closeError;
      }

      const arrayBuffer = await response.arrayBuffer();

      this.stream = this.stream.concat(new Uint8Array(arrayBuffer));
      if (this.resolveRead && !this.isClosed) this.resolveRead();
    }).catch((err) => {
      this.handleDisconnect();
      throw err;
    });
  }

  handleDisconnect() {
    this.disconnectedCallback?.();
    if (this.rejectRead) this.rejectRead();
  }

  close() {
    this.isClosed = true;
    this.handleDisconnect();
    this.disconnectedCallback = undefined;
  }
}
