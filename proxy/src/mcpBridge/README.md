# `mcpBridge`

This directory holds the proxy-side bridge protocol for the per-user Telegram MCP path.

The proxy keeps only bridge state:

- opaque `connectionId`
- `bearerHash` for verification
- connection lifecycle state: `disabled`, `enabled`, `revoked`
- browser transport metadata

It does not store Telegram session strings, auth keys, cookies, browser storage, or Telegram credentials.

## Canonical tools

The bridge is transport-only and stays independent from the frontend registry. It carries only these tool names:

- `chats`
- `read`
- `send`

## Request envelope

The browser opens an outbound bridge connection to the proxy and sends requests in this JSON shape:

```json
{
  "version": 1,
  "kind": "telegram.mcp.bridge.request",
  "connection_id": "opaque-connection-id",
  "request_id": "opaque-request-id",
  "browser_connection_id": "opaque-browser-connection-id",
  "transport": { "mode": "browser-outbound" },
  "auth": {
    "scheme": "bearer",
    "token": "Bearer ...",
    "token_hash": "optional-sha256-hex"
  },
  "tool": "chats",
  "args": {
    "query": "example",
    "limit": 20
  }
}
```

Either `auth.token` or `auth.token_hash` must be present. The proxy compares bearer material by hash and never persists the raw token.

## Response envelope

```json
{
  "version": 1,
  "kind": "telegram.mcp.bridge.response",
  "request_id": "opaque-request-id",
  "ok": true,
  "result": {}
}
```

Failures use the same shape with `ok: false` and an `error` object.

## Lifecycle

- `createConnection()` issues an opaque connection id and stores only the hash.
- `enableConnection()` allows bearer-authenticated requests.
- `disableConnection()` blocks requests without destroying the record.
- `revokeConnection()` permanently disables the record and clears the live browser binding.
