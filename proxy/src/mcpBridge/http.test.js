import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { createBridgeHttpRouter } from './http.js';

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function startRouter() {
  const router = createBridgeHttpRouter({ randomId: () => 'request-1' });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    void router.handle(req, res, url);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function post(base, path, body, token, extraHeaders = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: token } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

describe('mcp bridge HTTP transport', () => {
  it('relays one MCP tools/call through the browser polling channel', async () => {
    const base = await startRouter();
    const token = 'Bearer browser-secret';
    const createdResponse = await post(base, '/_mcp-bridge/create', {
      user_id: 'telegram-user-1',
      bearer: token,
      browser_connection_id: 'browser-1',
    });
    const { connection_id: connectionId } = await createdResponse.json();
    const headers = { authorization: token, 'x-browser-connection-id': 'browser-1' };
    const tools = ['chats', 'read', 'send'].map((name) => ({
      type: 'function',
      function: { name, description: name, parameters: { type: 'object' } },
    }));

    await post(base, `/_mcp-bridge/${connectionId}/browser/connect`, {
      browser_connection_id: 'browser-1',
      tools,
    }, token);
    const listResponse = await post(base, `/_mcp-bridge/${connectionId}/mcp`, {
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    }, token);
    expect((await listResponse.json()).result.tools).toHaveLength(3);

    const callPromise = post(base, `/_mcp-bridge/${connectionId}/mcp`, {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read', arguments: { chat_id: 'chat-1' } },
    }, token);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const nextResponse = await fetch(`${base}/_mcp-bridge/${connectionId}/browser/next`, { headers });
    const request = await nextResponse.json();
    expect(request.tool).toBe('read');

    const badResultResponse = await post(base, `/_mcp-bridge/${connectionId}/browser/result`, {
      version: 1,
      kind: 'telegram.mcp.bridge.response',
      request_id: request.request_id,
      ok: true,
      result: { ok: true, data: { messages: [] } },
    }, token, { 'x-browser-connection-id': 'browser-attacker' });
    expect(badResultResponse.status).toBe(403);

    const resultResponse = await post(base, `/_mcp-bridge/${connectionId}/browser/result`, {
      version: 1,
      kind: 'telegram.mcp.bridge.response',
      request_id: request.request_id,
      ok: true,
      result: { ok: true, data: { messages: [] } },
    }, token, { 'x-browser-connection-id': 'browser-1' });
    expect(resultResponse.status).toBe(202);
    const callResponse = await callPromise;
    const call = await callResponse.json();
    expect(call.result.isError).toBe(false);
    expect(call.result.content[0].text).toContain('messages');
  });
});
