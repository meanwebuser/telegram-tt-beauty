# MCP security roadmap

## Current contract: explicit write permission

Browser MCP is read-only by default. The user must explicitly enable the
`Allow MCP to send messages` setting before the `send` tool is exposed and
accepted. The proxy and browser enforce this independently; hiding the tool in
the UI is not authorization.

## Future contract: persistent versus non-persistent MCP

Add a visible choice between:

- **MCP non-persistent** — bound to the currently authenticated browser tab;
  disabling the tab bridge immediately disables the connection.
- **MCP persistent** — a separately created Telegram session with an explicit
  lifecycle entry in settings.

Persistent MCP must be created only after an explicit user click. The intended
flow is:

1. The user chooses persistent MCP and sees an explanation of the separate
   session and its lifetime.
2. The app opens a Telegram QR login flow.
3. A new session is authorized by scanning that QR code through MTProto, just
   as Telegram Web is authorized from a phone.
4. Only after the QR flow completes does the app expose the persistent MCP
   connection.

Token copying, importing the current browser session, or silently reusing an
existing Telegram authorization are not equivalent implementations.

The persistent session must have a visible settings entry and one disable
action. Disable, denial, cancellation, timeout, logout, or failed binding must
revoke the MCP connection and destroy the dedicated Telegram session in the
same lifecycle operation. An agent such as Sarah may request the flow only
after the user has explicitly clicked to start it; it may not create a session
in the background.

## Persistent-session key ownership invariant

The service owner or deployer must not be able to use the user's persistent
Telegram session merely by owning the host, source code, container, database,
or backups.

- The Telegram session material is stored only as ciphertext, never as a
  usable plaintext session string.
- The encryption/decryption key is generated or supplied on the user's side,
  shown exactly once with an explicit loss warning, and is never persisted or
  sent to the service owner as a recoverable secret.
- Without that user-held key, ciphertext must be unusable even to an owner
  who has complete source and storage access.
- Losing the key is intentionally unrecoverable: the user must revoke the old
  session and complete a new QR/MTProto login.

This creates an explicit architectural constraint: an unattended server
cannot both decrypt and use the session while the service owner is guaranteed
never to obtain the decryption capability. Persistent MCP therefore means
durable encrypted session metadata plus user-authorized decryption/use, not
silent owner-controlled plaintext access. Any future design that introduces
key escrow, an owner-readable environment secret, or plaintext backups must be
rejected by the security tests.

## Mandatory tests before implementation

- QR happy path creates exactly one dedicated session and one MCP connection.
- User denial, cancel, timeout, failed binding, and QR expiry leave no live
  session or enabled MCP connection.
- Disabling MCP revokes the connection and destroys the dedicated session.
- Re-enabling creates a new session rather than reusing a revoked one.
- Concurrent revoke/create operations are serialized and cannot resurrect a
  revoked session.
- A persistent session cannot be exposed through a non-persistent connection.
- Proxy envelopes and audit records never contain Telegram credentials.
- Restart/recovery does not silently recreate or re-enable a persistent MCP.
- Ciphertext, backups, logs, and proxy payloads do not contain a usable
  plaintext Telegram session or the user-held decryption key.
- The key is displayed once, absent from server persistence, and loss requires
  revoke plus a fresh QR/MTProto authorization.
- An owner with full filesystem/source/container access cannot decrypt the
  stored session in the test threat model.
