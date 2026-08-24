import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

export const BRIDGE_TOOL_NAMES = Object.freeze(['chats', 'read', 'send']);
export const BRIDGE_ENVELOPE_VERSION = 1;
export const BRIDGE_REQUEST_KIND = 'telegram.mcp.bridge.request';
export const BRIDGE_RESPONSE_KIND = 'telegram.mcp.bridge.response';

const TELEGRAM_SECRET_KEYS = new Set([
  'telegramSession',
  'telegram_session',
  'telegramCredentials',
  'telegram_credentials',
  'session',
  'sessionString',
  'session_string',
  'authKey',
  'auth_key',
  'apiId',
  'api_id',
  'apiHash',
  'api_hash',
  'phoneNumber',
  'phone_number',
  'password',
  'code',
  'verificationCode',
  'verification_code',
]);

function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function ensureObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function ensureString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

export function ensureNoTelegramSecrets(payload, seen = new WeakSet(), allowErrorCode = false) {
  if (!payload || typeof payload !== 'object' || seen.has(payload)) return;
  seen.add(payload);
  for (const [key, value] of Object.entries(payload)) {
    if (TELEGRAM_SECRET_KEYS.has(key) && !(allowErrorCode && key === 'code')) {
      throw new Error(`telegram session material is not accepted on the proxy: ${key}`);
    }
    // Only the immediate protocol error object may use `code`; nested codes
    // can contain Telegram verification codes and must remain rejected.
    ensureNoTelegramSecrets(value, seen);
  }
}

function normalizeBearerHash(input) {
  ensureString(input, 'bearerHash');
  if (!/^[a-f0-9]{64}$/i.test(input)) {
    throw new Error('bearerHash must be a sha256 hex digest');
  }
  return input.toLowerCase();
}

function safeCompareHex(expectedHex, actualHex) {
  if (!expectedHex || !actualHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(actualHex, 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function cloneConnection(record) {
  return {
    connectionId: record.connectionId,
    userId: record.userId,
    status: record.status,
    transport: { ...record.transport },
    browserConnectionId: record.browserConnectionId,
    bearerHash: record.bearerHash,
    allowWrite: record.allowWrite,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revokedAt: record.revokedAt,
  };
}

export function createBridgeHub({
  now = () => Date.now(),
  randomId = () => randomUUID(),
  hashBearer = sha256Hex,
} = {}) {
  const connections = new Map();

  function getRecord(connectionId) {
    ensureString(connectionId, 'connectionId');
    const record = connections.get(connectionId);
    if (!record) {
      throw new Error(`unknown connection: ${connectionId}`);
    }
    return record;
  }

  function touch(record) {
    record.updatedAt = now();
    return cloneConnection(record);
  }

  return {
    createConnection(input) {
      ensureObject(input, 'connection');
      ensureNoTelegramSecrets(input);
      ensureString(input.userId, 'userId');
      if (input.allowWrite !== undefined && typeof input.allowWrite !== 'boolean') {
        throw new TypeError('allowWrite must be a boolean');
      }

      const providedBearerHash = input.bearerHash;
      const providedBearer = input.bearer;
      if (providedBearerHash === undefined && providedBearer === undefined) {
        throw new Error('either bearer or bearerHash is required');
      }
      if (providedBearerHash !== undefined && providedBearer !== undefined) {
        ensureString(providedBearer, 'bearer');
        const derivedHash = hashBearer(providedBearer);
        if (normalizeBearerHash(providedBearerHash) !== normalizeBearerHash(derivedHash)) {
          throw new Error('bearer and bearerHash do not match');
        }
      }

      const bearerHash = providedBearerHash !== undefined
        ? normalizeBearerHash(providedBearerHash)
        : (() => {
            ensureString(providedBearer, 'bearer');
            return normalizeBearerHash(hashBearer(providedBearer));
          })();
      const connectionId = randomId();
      const record = {
        connectionId,
        userId: input.userId,
        status: 'disabled',
        transport: { mode: 'browser-outbound' },
        allowWrite: input.allowWrite === true,
        browserConnectionId: typeof input.browserConnectionId === 'string' && input.browserConnectionId.length > 0
          ? input.browserConnectionId
          : null,
        bearerHash,
        createdAt: now(),
        updatedAt: now(),
        revokedAt: null,
      };

      connections.set(connectionId, record);
      return cloneConnection(record);
    },

    getConnection(connectionId) {
      return cloneConnection(getRecord(connectionId));
    },

    verifyBearer(connectionId, bearer) {
      const record = getRecord(connectionId);
      ensureString(bearer, 'bearer');
      return safeCompareHex(record.bearerHash, hashBearer(bearer));
    },

    authorizeConnection(connectionId, bearer) {
      const record = getRecord(connectionId);
      ensureString(bearer, 'bearer');
      return record.status === 'enabled' && safeCompareHex(record.bearerHash, hashBearer(bearer));
    },

    enableConnection(connectionId) {
      const record = getRecord(connectionId);
      if (record.status === 'revoked') {
        throw new Error(`connection is revoked: ${connectionId}`);
      }
      record.status = 'enabled';
      return touch(record);
    },

    disableConnection(connectionId) {
      const record = getRecord(connectionId);
      if (record.status === 'revoked') {
        throw new Error(`connection is revoked: ${connectionId}`);
      }
      record.status = 'disabled';
      record.browserConnectionId = null;
      return touch(record);
    },

    revokeConnection(connectionId) {
      const record = getRecord(connectionId);
      record.status = 'revoked';
      record.revokedAt = now();
      record.browserConnectionId = null;
      return touch(record);
    },
  };
}

export function makeBridgeRequestEnvelope({
  connectionId,
  requestId = randomUUID(),
  browserConnectionId = null,
  bearer,
  bearerHash,
  tool,
  args = {},
} = {}) {
  ensureString(connectionId, 'connectionId');
  ensureString(requestId, 'requestId');
  ensureString(tool, 'tool');
  if (!BRIDGE_TOOL_NAMES.includes(tool)) {
    throw new Error(`unsupported bridge tool: ${tool}`);
  }
  ensureObject(args, 'args');
  ensureNoTelegramSecrets(args);
  if (bearer === undefined && bearerHash === undefined) {
    throw new Error('either bearer or bearerHash is required');
  }
  if (bearer !== undefined && bearerHash !== undefined) {
    ensureString(bearer, 'bearer');
    const derivedHash = sha256Hex(bearer);
    if (normalizeBearerHash(bearerHash) !== normalizeBearerHash(derivedHash)) {
      throw new Error('bearer and bearerHash do not match');
    }
  }

  return {
    version: BRIDGE_ENVELOPE_VERSION,
    kind: BRIDGE_REQUEST_KIND,
    connection_id: connectionId,
    request_id: requestId,
    browser_connection_id: browserConnectionId,
    transport: { mode: 'browser-outbound' },
    auth: bearerHash !== undefined
      ? { scheme: 'bearer', token_hash: normalizeBearerHash(bearerHash) }
      : {
          scheme: 'bearer',
          token: (() => {
            ensureString(bearer, 'bearer');
            return bearer;
          })(),
        },
    tool,
    args,
  };
}

export function makeBridgeResponseEnvelope({
  requestId,
  ok,
  result = undefined,
  error = undefined,
} = {}) {
  ensureString(requestId, 'requestId');
  if (typeof ok !== 'boolean') {
    throw new TypeError('ok must be a boolean');
  }
  if (ok && error !== undefined) {
    throw new Error('successful responses cannot include error');
  }
  if (!ok && !error) {
    throw new Error('failed responses must include error');
  }

  const envelope = {
    version: BRIDGE_ENVELOPE_VERSION,
    kind: BRIDGE_RESPONSE_KIND,
    request_id: requestId,
    ok,
  };

  if (ok) {
    ensureNoTelegramSecrets(result);
    envelope.result = result;
  } else {
    ensureNoTelegramSecrets(error, new WeakSet(), true);
    envelope.error = error;
  }

  return envelope;
}

export function serializeBridgeRequestEnvelope(envelope) {
  return JSON.stringify(parseBridgeEnvelope(envelope));
}

export function serializeBridgeResponseEnvelope(envelope) {
  return JSON.stringify(parseBridgeEnvelope(envelope, { allowResponse: true, allowRequest: false }));
}

export function parseBridgeEnvelope(input, { allowRequest = true, allowResponse = false } = {}) {
  let envelope = input;
  if (typeof input === 'string') {
    try {
      envelope = JSON.parse(input);
    } catch (error) {
      throw new Error(`bridge envelope is not valid JSON: ${error.message}`);
    }
  }

  ensureObject(envelope, 'bridge envelope');
  if (envelope.version !== BRIDGE_ENVELOPE_VERSION) {
    throw new Error(`unsupported bridge envelope version: ${envelope.version}`);
  }
  if (envelope.kind === BRIDGE_REQUEST_KIND) {
    if (!allowRequest) {
      throw new Error('request envelopes are not allowed here');
    }
    ensureString(envelope.connection_id, 'connection_id');
    ensureString(envelope.request_id, 'request_id');
    ensureString(envelope.tool, 'tool');
    if (!BRIDGE_TOOL_NAMES.includes(envelope.tool)) {
      throw new Error(`unsupported bridge tool: ${envelope.tool}`);
    }
    ensureObject(envelope.args, 'args');
    ensureNoTelegramSecrets(envelope.args);
    if (!envelope.auth || typeof envelope.auth !== 'object' || Array.isArray(envelope.auth)) {
      throw new Error('auth is required');
    }
    if (envelope.auth.scheme !== 'bearer') {
      throw new Error('unsupported auth scheme');
    }
    if (envelope.auth.token === undefined && envelope.auth.token_hash === undefined) {
      throw new Error('auth token or token_hash is required');
    }
    if (envelope.transport === undefined || envelope.transport?.mode !== 'browser-outbound') {
      throw new Error('browser-outbound transport is required');
    }
    if (envelope.browser_connection_id !== undefined && envelope.browser_connection_id !== null) {
      ensureString(envelope.browser_connection_id, 'browser_connection_id');
    }
    return {
      version: envelope.version,
      kind: envelope.kind,
      connection_id: envelope.connection_id,
      request_id: envelope.request_id,
      browser_connection_id: envelope.browser_connection_id ?? null,
      transport: { mode: 'browser-outbound' },
      auth: envelope.auth.token_hash !== undefined
        ? { scheme: 'bearer', token_hash: normalizeBearerHash(envelope.auth.token_hash) }
        : { scheme: 'bearer', token: envelope.auth.token },
      tool: envelope.tool,
      args: envelope.args,
    };
  }

  if (envelope.kind === BRIDGE_RESPONSE_KIND) {
    if (!allowResponse) {
      throw new Error('response envelopes are not allowed here');
    }
    ensureString(envelope.request_id, 'request_id');
    if (typeof envelope.ok !== 'boolean') {
      throw new Error('ok must be a boolean');
    }
    if (envelope.ok) {
      ensureNoTelegramSecrets(envelope.result);
      return {
        version: envelope.version,
        kind: envelope.kind,
        request_id: envelope.request_id,
        ok: true,
        result: envelope.result,
      };
    }
    if (!envelope.error || typeof envelope.error !== 'object' || Array.isArray(envelope.error)) {
      throw new Error('error is required');
    }
      ensureNoTelegramSecrets(envelope.error, new WeakSet(), true);
    return {
      version: envelope.version,
      kind: envelope.kind,
      request_id: envelope.request_id,
      ok: false,
      error: envelope.error,
    };
  }

  throw new Error(`unsupported bridge kind: ${envelope.kind}`);
}
