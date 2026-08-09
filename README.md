# TChat

> A self-hostable Telegram Web A fork with a proxy-aware browser client, BYOK
> AI, and a browser-bound MCP bridge.

TChat keeps Telegram access in the authenticated browser session while adding
an optional proxy, AI assistant, transcription integration, and one canonical
MCP surface for `chats`, `read`, and `send`.

## Install

```bash
git clone https://github.com/meanwebuser/telegram-tt-beauty.git
cd telegram-tt-beauty/release
cp .env.example .env
cp proxy.env.example proxy.env
# Set TELEGRAM_UPSTREAM_PROXY in proxy.env.
docker compose --env-file .env -f compose.yaml pull
docker compose --env-file .env -f compose.yaml up -d
```

Open `http://127.0.0.1:8080/`. For a public deployment, put a TLS reverse
proxy in front of the web container and keep the proxy routes on the same
origin.

## Included

- Telegram Web A client with GramJS and proxy-aware WebSocket transport.
- BYOK AI assistant with optional synchronized history.
- Browser-bound MCP tools: `chats`, `read`, and `send`.
- Optional OpenAI-compatible Whisper transcription proxy.
- Static `dist` artifact for Vercel, CDN, or nginx deployments.

## Learn more

- [Docker release](release/README.md)
- [Release artifacts](docs/RELEASE.md)
- [Deployment notes](docs/DEPLOYMENT.md)

This project is a fork and is not an official Telegram distribution.
