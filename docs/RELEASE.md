# Release artifacts

The repository produces three complementary artifacts:

- `dist/` — a static TChat frontend. It can be uploaded to Vercel, a CDN, or
  nginx, but it needs `/proxy/` and `/_mcp-bridge/` routed to the proxy service
  for Telegram and MCP functionality.
- `telegram-tt-beauty-web:<version>` — nginx plus the production frontend.
- `telegram-tt-beauty-proxy:<version>` — the proxy and browser-bound MCP
  bridge.

The public self-hosting package is `release/compose.yaml`. It pulls the two
versioned images and starts them with one command. No Telegram session,
Bearer token, API secret, or proxy credential belongs in the repository or
image release.

## Build the static artifact

```bash
TELEGRAM_API_ID=... TELEGRAM_API_HASH=... npm run release:dist
```

The command runs the production Vite build and writes a versioned archive and
`SHA256SUMS` below `release/artifacts/`. The output directory is ignored by
Git.

## Image names

The release Compose defaults to:

```text
ghcr.io/meanwebuser/telegram-tt-beauty-web:<version>
ghcr.io/meanwebuser/telegram-tt-beauty-proxy:<version>
```

Override `TGB_WEB_IMAGE` and `TGB_PROXY_IMAGE` in `.env` when mirroring the
images to another registry.
