import { describe, expect, it } from 'vitest';

import {
  BRIDGE_TOOL_NAMES,
  createBridgeHub,
  makeBridgeRequestEnvelope,
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
    expect(created).not.toHaveProperty('bearer');
    expect(created).not.toHaveProperty('telegramSession');
    expect(created.bearerHash).toMatch(/^[a-f0-9]{64}$/);
    expect(hub.verifyBearer('conn-1', 'Bearer test-token')).toBe(true);
    expect(hub.verifyBearer('conn-1', 'Bearer wrong-token')).toBe(false);
    expect(hub.authorizeConnection('conn-1', 'Bearer test-token')).toBe(false);
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
});
