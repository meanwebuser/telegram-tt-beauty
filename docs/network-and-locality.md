# Network and locality contract

This fork has one Telegram transport proxy. The word “proxy” is otherwise
easy to confuse with the separate browser MCP relay, so the paths below are
the contract shown to users.

## What is local and what is not

| Feature | Where it runs | Network path | Uses the Telegram transport proxy? |
| --- | --- | --- | --- |
| Telegram client | This browser tab and its worker | `GramJS → /proxy/apiws/... → telegram-proxy → Telegram` when enabled | Yes, when the setting is on |
| Telegram client, opt-out | This browser tab and its worker | `GramJS → Telegram DC` directly from the browser | No |
| Temporary external browser MCP | This browser tab plus the MCP client | `MCP client → public relay → browser tab` | No; the relay is needed because the tab may be behind NAT |
| Boyk AI / BYOK | This browser tab | Browser → the endpoint selected by the user | No; the Telegram proxy is irrelevant |
| AI history sync off | This browser and its local account cache | No Telegram workspace is used | No |
| AI history sync on | This browser plus a private Telegram workspace | Browser → Telegram using the selected Telegram route | It follows the Telegram proxy setting |

The MCP relay does not turn into a Telegram proxy. It only lets an external
MCP client reach the browser tab. A local MCP client can use `127.0.0.1`
when it runs on the same computer as the tab; a remote client cannot use that
address to reach the user's browser.

## Local/Server runtime ownership

The runtime contract has two explicit routes. They describe where the Telegram
session is owned; they do not create a second Telegram client or move session
material between owners.

| Route | Telegram session | Serialization owner | Update boundary |
| --- | --- | --- | --- |
| `local` | The authenticated browser account and its worker | `multitab-master` — the elected master tab | The existing master-tab connector routes secondary-tab calls to the master worker; the existing Telegram update manager processes updates there. |
| `server` | A separately authorized server-side Telegram session | `server-session` — the server session that owns that account | Calls and updates must remain serialized by that server session; this is not the browser tab's session. |

For the browser-local route, opening another tab does not create another
Telegram worker owner. The elected master tab remains the shared runtime owner;
the connector and update manager provide the existing call/update boundary.
The browser MCP relay is only a transport to that tab and must not be
interpreted as ownership of the Telegram session.

A server-owned Telegram session is a different security and lifecycle boundary.
It must not reuse, expose, or silently import the browser's session string. The
current UI's temporary browser MCP is therefore browser-local even though its
relay endpoint is server-facing.

## ChatGPT OAuth browser-session handoff

For an OAuth request initiated by ChatGPT, the authorize endpoint redirects
the browser with `302` to `/?handoff_id=...`. Once normal Telegram Web auth is
ready, the browser asks for explicit confirmation, then exports a one-time
login token with `auth.exportLoginToken`. The server consumes that token with
`auth.importLoginToken`; a `LoginTokenMigrateTo` response carries the target DC
and is handled as part of the same exchange. The resulting server-side
Telegram session is persisted encrypted, and the browser follows only the
sanitized OAuth redirect returned by the server.

This handoff never sends a Telegram session string across the browser or MCP
bridge. If the browser has no authenticated session, the existing QR/2FA
fallback remains in place; an existing server-session fast path is unchanged.

## Public MCP deployment caveat

The development source contains a standards-shaped public `/mcp` and OAuth
metadata contract, but source support is not proof that a public host has been
deployed. This document makes no claim that `/mcp` is currently live on any
production or public hostname. Verify the target host and deployment receipt
before presenting `/mcp` as available.

Until that deployment is explicitly verified, the supported temporary browser
path remains the authenticated `/_mcp-bridge/<connection-id>/mcp` relay tied to
an open browser tab. Public metadata, a bearer challenge, or a local build do
not by themselves create a server-owned Telegram session or authorize access
to the browser-local account.

## Telegram proxy setting

The setting is available on both login screens and later under **Settings →
AI Assistant → Telegram connection**. Changing it is a runtime action: the
current Telegram connection is closed and re-established using the new route.

- **On**: Telegram traffic uses the one configured same-origin proxy. This is
  useful when direct access to Telegram is blocked.
- **Off**: Telegram traffic goes directly from the browser. Login or message
  requests can fail if the user's network blocks Telegram.
- **Automatic default before the first choice**: the build/host default is
  used. The UI shows the effective route; choosing the checkbox records an
  explicit preference.

Turning this setting off does not disable browser MCP and does not change the
Boyk AI/BYOK endpoint. Conversely, enabling browser MCP does not imply that
Telegram traffic uses the Telegram proxy.

AI processing and BYOK configuration stay in the browser when history sync is
off. Enabling cross-device sync intentionally writes AI history to a private
Telegram forum workspace, so that feature is no longer fully local and follows
the Telegram connection route above.

## Security boundary

This is an unofficial open-source fork, not official Telegram Web. A QR code
must be scanned only when the user understands why it is shown; someone who
tricks the user into scanning it may obtain account access. Prefer official
Telegram clients unless the user understands this fork and its network paths.

The current browser MCP is temporary and tied to the open tab. Persistent MCP
with a separate QR-created MTProto session, revocation lifecycle, and
user-held encryption key remains a future design documented in
`docs/mcp-security-roadmap.md`.
