import { describe, expect, it } from 'vitest';

import { buildUpstreamHeaders, buildWhisperUpstreamHeaders } from './request-utils.js';

describe('buildUpstreamHeaders', () => {
  it('rewrites the host and origin for ordinary Telegram requests', () => {
    const headers = buildUpstreamHeaders({
      host: 'telegram.example.com',
      connection: 'keep-alive',
      origin: 'https://telegram.example.com',
      referer: 'https://telegram.example.com/',
      'user-agent': 'test-agent',
    }, 'zws2.web.telegram.org');

    expect(headers).toMatchObject({
      host: 'zws2.web.telegram.org',
      origin: 'https://web.telegram.org',
      referer: 'https://web.telegram.org/a/',
      'user-agent': 'test-agent',
    });
    expect(headers.connection).toBeUndefined();
  });

  it('restores only the required upgrade headers for WebSocket requests', () => {
    const headers = buildUpstreamHeaders({
      host: 'telegram.example.com',
      connection: 'keep-alive',
      upgrade: 'h2c',
      'sec-websocket-key': 'key',
    }, 'zws2.web.telegram.org', { websocket: true });

    expect(headers).toMatchObject({
      host: 'zws2.web.telegram.org',
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': 'key',
    });
  });
});

describe('buildWhisperUpstreamHeaders', () => {
  it('replaces caller auth with the server-side Whisper key', () => {
    const headers = buildWhisperUpstreamHeaders({
      host: 'telegram.example.com',
      authorization: 'Bearer caller-token',
      origin: 'https://telegram.example.com',
    }, 'whisper.example.com', 'server-key');

    expect(headers).toMatchObject({
      host: 'whisper.example.com',
      authorization: 'Bearer server-key',
    });
    expect(headers.origin).toBeUndefined();
  });
});
