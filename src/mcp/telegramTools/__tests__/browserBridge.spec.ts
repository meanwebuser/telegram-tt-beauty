import { describe, expect, it, vi } from 'vitest';

import { createBrowserTelegramMcpBridge } from '../browserBridge';

describe('browser Telegram MCP bridge', () => {
  it('announces the canonical tools and executes browser-poll requests', async () => {
    const runtime = {
      getToolSchemas: () => [{ type: 'function', function: { name: 'chats' } }],
      execute: vi.fn().mockResolvedValue({ ok: true, data: { chats: [] } }),
    };
    const responses = [
      new Response('{}', { status: 200 }),
      new Response(JSON.stringify({ request_id: 'req-1', tool: 'chats', args: {} }), { status: 200 }),
      new Response('{}', { status: 202 }),
    ];
    const fetchImpl = vi.fn().mockImplementation(async () => responses.shift() || new Response('{}', { status: 204 }));
    const bridge = createBrowserTelegramMcpBridge({
      baseUrl: 'https://example.test',
      connectionId: 'conn-1',
      bearer: 'Bearer secret',
      browserConnectionId: 'browser-1',
      runtime,
      fetchImpl,
      pollDelayMs: 1,
    });

    await bridge.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    bridge.stop();

    expect(fetchImpl.mock.calls[0][0]).toContain('/conn-1/browser/connect');
    expect(fetchImpl.mock.calls[0][1].headers['x-browser-connection-id']).toBe('browser-1');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).tools).toHaveLength(1);
    expect(runtime.execute).toHaveBeenCalledWith('chats', {});
    const resultCall = fetchImpl.mock.calls.find(([url]) => String(url).includes('/conn-1/browser/result'));
    expect(resultCall?.[1].headers['x-browser-connection-id']).toBe('browser-1');
  });
});
