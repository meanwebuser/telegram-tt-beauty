# TChat Docker release

This package runs the published TChat web client and its Telegram proxy. The
browser-bound MCP bridge is exposed by the same authenticated browser tab; the
proxy does not contain a Telegram user session.

## Start

```bash
cp .env.example .env
cp proxy.env.example proxy.env
# Edit proxy.env and set TELEGRAM_UPSTREAM_PROXY.
docker compose --env-file .env -f compose.yaml pull
docker compose --env-file .env -f compose.yaml up -d
```

Open `http://127.0.0.1:8080/`. Put nginx, Caddy, or another TLS reverse proxy
in front when exposing it publicly.

## Stop

```bash
docker compose --env-file .env -f compose.yaml down
```

The Compose file contains image references only. Runtime proxy settings stay
in `proxy.env`; never commit that file or a Telegram session.
