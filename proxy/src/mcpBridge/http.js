import { randomUUID } from 'node:crypto';

import {
  BRIDGE_TOOL_NAMES,
  createBridgeHub,
  makeBridgeRequestEnvelope,
  parseBridgeEnvelope,
} from './protocol.js';

const MAX_BODY_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function bearer(req) {
  const value = req.headers.authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value : undefined;
}

function browserConnectionId(req, body) {
  const header = req.headers['x-browser-connection-id'];
  if (typeof header === 'string' && header.length > 0) return header;
  return typeof body?.browser_connection_id === 'string' ? body.browser_connection_id : undefined;
}

function hasBrowserBinding(req, body, connection) {
  return Boolean(connection.browserConnectionId)
    && browserConnectionId(req, body) === connection.browserConnectionId;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(new Error(`invalid JSON: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function waitForResult(pending) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pending.resolve = undefined;
      resolve({ timeout: true });
    }, REQUEST_TIMEOUT_MS);
    pending.resolve = (value) => {
      clearTimeout(timeout);
      resolve({ value });
    };
  });
}

export function createBridgeHttpRouter({
  hub = createBridgeHub(),
  randomId = () => randomUUID(),
} = {}) {
  const pending = new Map();
  const browserTools = new Map();

  function connectionPath(pathname) {
    if (pathname === '/_mcp-bridge/create') return { action: 'create' };
    const match = pathname.match(/^\/_mcp-bridge\/([^/]+)(?:\/(.*))?$/);
    return match ? { connectionId: match[1], action: match[2] || 'mcp' } : undefined;
  }

  function matches(pathname) {
    return pathname.startsWith('/_mcp-bridge/');
  }

  async function handle(req, res, url) {
    const route = connectionPath(url.pathname);
    if (!route) return false;

    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
      res.setHeader('access-control-allow-headers', 'Authorization, Content-Type, X-Browser-Connection-Id');
      res.statusCode = 204;
      res.end();
      return true;
    }

    try {
      if (route.action === 'create') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        const body = await readJson(req);
        const connection = hub.createConnection({
          userId: body.user_id,
          bearer: body.bearer,
          browserConnectionId: body.browser_connection_id,
        });
        hub.enableConnection(connection.connectionId);
        return json(res, 201, { connection_id: connection.connectionId });
      }

      const connection = hub.getConnection(route.connectionId);
      const authorization = bearer(req);
      if (!authorization || !hub.authorizeConnection(route.connectionId, authorization)) {
        return json(res, 401, { error: 'invalid or disabled bearer' });
      }

      if (route.action === 'browser/connect') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        const body = await readJson(req);
        if (!hasBrowserBinding(req, body, connection)) {
          return json(res, 403, { error: 'browser connection binding mismatch' });
        }
        browserTools.set(route.connectionId, Array.isArray(body.tools) ? body.tools : []);
        return json(res, 200, { connection_id: connection.connectionId, status: 'connected' });
      }

      if (route.action === 'browser/next') {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
        if (!hasBrowserBinding(req, undefined, connection)) {
          return json(res, 403, { error: 'browser connection binding mismatch' });
        }
        const next = [...pending.values()].find((item) => item.connectionId === route.connectionId && !item.delivered);
        if (!next) {
          res.statusCode = 204;
          res.end();
          return true;
        }
        next.delivered = true;
        return json(res, 200, next.envelope);
      }

      if (route.action === 'browser/result') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        const rawBody = await readJson(req);
        if (!hasBrowserBinding(req, rawBody, connection)) {
          return json(res, 403, { error: 'browser connection binding mismatch' });
        }
        const body = parseBridgeEnvelope(rawBody, { allowRequest: false, allowResponse: true });
        const item = pending.get(body.request_id);
        if (!item || item.connectionId !== route.connectionId) return json(res, 404, { error: 'unknown request' });
        pending.delete(body.request_id);
        item.resolve?.(body);
        return json(res, 202, { accepted: true });
      }

      if (route.action === 'disable') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        hub.disableConnection(route.connectionId);
        return json(res, 200, { status: 'disabled' });
      }

      if (route.action === 'revoke') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        hub.revokeConnection(route.connectionId);
        browserTools.delete(route.connectionId);
        return json(res, 200, { status: 'revoked' });
      }

      if (route.action !== 'mcp' || req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      const body = await readJson(req);
      const id = body.id ?? null;

      if (body.method === 'initialize') {
        return json(res, 200, rpcResult(id, {
          protocolVersion: body.params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'telegram-browser-mcp', version: '0.1.0' },
        }));
      }
      if (body.method === 'notifications/initialized') {
        res.statusCode = 202;
        res.end();
        return true;
      }
      if (body.method === 'tools/list') {
        return json(res, 200, rpcResult(id, { tools: browserTools.get(route.connectionId) || [] }));
      }
      if (body.method !== 'tools/call') {
        return json(res, 200, rpcError(id, -32601, `method not found: ${body.method}`));
      }

      const name = body.params?.name;
      const args = body.params?.arguments || {};
      const tools = browserTools.get(route.connectionId) || [];
      if (!BRIDGE_TOOL_NAMES.includes(name) || (tools.length && !tools.some((tool) => tool.function?.name === name))) {
        return json(res, 200, rpcError(id, -32602, `tool not available: ${name}`));
      }

      const requestId = randomId();
      const record = hub.getConnection(route.connectionId);
      const envelope = makeBridgeRequestEnvelope({
        connectionId: route.connectionId,
        requestId,
        bearerHash: record.bearerHash,
        tool: name,
        args,
      });
      const item = { connectionId: route.connectionId, envelope, delivered: false, resolve: undefined };
      pending.set(requestId, item);
      const response = await waitForResult(item);
      pending.delete(requestId);
      if (response.timeout) return json(res, 504, rpcError(id, -32001, 'browser tab did not answer'));
      const bridgeResult = response.value;
      const result = bridgeResult.ok ? bridgeResult.result : { ok: false, error: bridgeResult.error };
      return json(res, 200, rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: !bridgeResult.ok || result?.ok === false,
      }));
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : 'bridge request failed' });
    }
  }

  return { matches, handle, hub };
}
