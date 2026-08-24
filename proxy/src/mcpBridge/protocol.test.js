import { describe, expect, it } from 'vitest';

import {
  BRIDGE_TOOL_NAMES,
  createBridgeHub,
  ensureNoTelegramSecrets,
  makeBridgeRequestEnvelope,
  makeBridgeResponseEnvelope,
  parseBridgeEnvelope,
  serializeBridgeRequestEnvelope,
} from './protocol.js';

describe('mcpBridge protocol', () => {
  it('creates an opaque connection and verifies bearer secrets by hash only', () => {
    const nextId = (() => {
      let counter = 0;
      return (prefix) => `${prefix}-${++counter}`;
    })();
    const hub = createBridgeHub({
      now: () => 1_700_000_000_000,
      randomId: () => nextId('conn'),
    });

    const created = hub.createConnection({
      userId: 'user-7',
      bearer: 'Bearer test-token',
    });

    expect(created.connectionId).toBe('conn-1');
    expect(created.status).toBe('disabled');
    expect(created.allowWrite).toBe(false);
    expect(created).not.toHaveProperty('bearer');
    expect(created).not.toHaveProperty('telegramSession');
    expect(created.bearerHash).toMatch(/^[a-f0-9]{64}$/);
    expect(hub.verifyBearer('conn-1', 'Bearer test-token')).toBe(true);
    expect(hub.verifyBearer('conn-1', 'Bearer wrong-token')).toBe(false);
    expect(hub.authorizeConnection('conn-1', 'Bearer test-token')).toBe(false);
  });

  it('stores explicit write permission and rejects non-boolean values', () => {
    const hub = createBridgeHub({ randomId: () => 'conn-write' });
    const created = hub.createConnection({
      userId: 'user-write',
      bearer: 'Bearer write-token',
      allowWrite: true,
    });

    expect(created.allowWrite).toBe(true);
    expect(() => hub.createConnection({
      userId: 'user-invalid',
      bearer: 'Bearer invalid-token',
      allowWrite: 'yes',
    })).toThrow(/allowWrite must be a boolean/i);
  });

  it('supports enable, disable, and revoke without storing Telegram session material', () => {
    const nextId = (() => {
      let counter = 0;
      return (prefix) => `${prefix}-${++counter}`;
    })();
    const hub = createBridgeHub({
      randomId: () => nextId('conn'),
    });

    hub.createConnection({
      userId: 'user-8',
      bearer: 'Bearer second-token',
      browserConnectionId: 'browser-1',
    });

    expect(hub.enableConnection('conn-1')).toMatchObject({ status: 'enabled' });
    expect(hub.authorizeConnection('conn-1', 'Bearer second-token')).toBe(true);
    expect(hub.disableConnection('conn-1')).toMatchObject({ status: 'disabled' });
    expect(hub.authorizeConnection('conn-1', 'Bearer second-token')).toBe(false);
    expect(hub.revokeConnection('conn-1')).toMatchObject({ status: 'revoked' });
    expect(() => hub.enableConnection('conn-1')).toThrow(/revoked/i);
    expect(hub.authorizeConnection('conn-1', 'Bearer second-token')).toBe(false);
    expect(() => hub.createConnection({
      userId: 'user-9',
      bearer: 'Bearer third-token',
      telegramSession: 'should-never-be-accepted',
    })).toThrow(/telegram session/i);
  });

  it('serializes the browser-outbound envelope for canonical chats/read/send tools', () => {
    const envelope = makeBridgeRequestEnvelope({
      connectionId: 'conn-opaque',
      requestId: 'req-123',
      browserConnectionId: 'browser-2',
      bearer: 'Bearer test-token',
      tool: 'read',
      args: { chat_id: 'chat-1', limit: 20 },
    });

    expect(envelope).toEqual({
      version: 1,
      kind: 'telegram.mcp.bridge.request',
      connection_id: 'conn-opaque',
      request_id: 'req-123',
      browser_connection_id: 'browser-2',
      transport: { mode: 'browser-outbound' },
      auth: { scheme: 'bearer', token: 'Bearer test-token' },
      tool: 'read',
      args: { chat_id: 'chat-1', limit: 20 },
    });
    expect(BRIDGE_TOOL_NAMES).toEqual(['chats', 'read', 'send']);

    const serialized = serializeBridgeRequestEnvelope(envelope);
    expect(JSON.parse(serialized)).toEqual(envelope);
    expect(parseBridgeEnvelope(serialized)).toEqual(envelope);
  });

  it('fails closed on malformed transport envelopes', () => {
    expect(() => parseBridgeEnvelope('{"version":1,"kind":"telegram.mcp.bridge.request"}'))
      .toThrow(/connection_id/i);
    expect(() => parseBridgeEnvelope('not-json'))
      .toThrow(/json/i);
  });

  it('rejects Telegram session material nested in tool arguments', () => {
    expect(() => makeBridgeRequestEnvelope({
      connectionId: 'conn-secret',
      requestId: 'req-secret',
      bearer: 'Bearer test-token',
      tool: 'read',
      args: { options: { session: 'must-not-cross-proxy' } },
    })).toThrow(/telegram session material/i);
  });

  it('rejects Telegram session material nested in browser tool schemas', () => {
    expect(() => ensureNoTelegramSecrets([{
      function: { parameters: { properties: { session: { type: 'string' } } } },
    }])).toThrow(/telegram session material/i);
  });

  it('rejects Telegram session material in response payloads', () => {
    expect(() => makeBridgeResponseEnvelope({
      requestId: 'response-secret',
      ok: true,
      result: { nested: { auth_key: 'must-not-cross-proxy' } },
    })).toThrow(/telegram session material/i);
    expect(() => parseBridgeEnvelope({
      version: 1,
      kind: 'telegram.mcp.bridge.response',
      request_id: 'response-secret',
      ok: true,
      result: { nested: { session: 'must-not-cross-proxy' } },
    }, { allowRequest: false, allowResponse: true })).toThrow(/telegram session material/i);
    expect(() => makeBridgeResponseEnvelope({
      requestId: 'response-error-code',
      ok: false,
      error: { code: 'MCP_DISABLED', message: 'safe protocol error' },
    })).not.toThrow();
    expect(() => makeBridgeResponseEnvelope({
      requestId: 'response-nested-code',
      ok: false,
      error: { code: 'MCP_DISABLED', details: { code: '12345' } },
    })).toThrow(/telegram session material/i);
  });
});
