# Deployment

This project is a browser client with a companion HTTP/WebSocket proxy. The
proxy uses an HTTP(S) egress proxy supplied by the operator; it does not bundle
an Xray or sing-box profile.

## Docker Compose

```bash
cp .env.example .env
cp proxy/.env.example proxy/.env
# Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env.
# Set TELEGRAM_UPSTREAM_PROXY in proxy/.env.
docker compose up --build -d
```

Open `http://localhost:8080`. The static site uses the same-origin `/proxy/`
path, which the web container forwards to `telegram-proxy` with WebSocket
upgrade support.

`WHISPER_UPSTREAM` and `WHISPER_API_KEY` are optional. Without both values,
the transcription route returns `503`; Telegram Web proxying remains available.
The Telegram API values are supplied only at frontend build time; do not commit
your `.env` file.

The Compose default is same-origin: the web container forwards `/proxy/`
internally, so `PUBLIC_ORIGINS` can stay empty. Set it to a comma-separated
list of exact origins only when a different frontend origin calls the proxy.

## Nginx

Run Compose locally, then adapt
[`deploy/nginx/telegram-tt.conf.example`](../deploy/nginx/telegram-tt.conf.example)
for your hostname and TLS setup. It forwards every path to the web container,
which already handles `/proxy/` internally.

## Vercel

Vercel can host the static frontend, but it cannot replace the companion proxy:
the proxy requires long-lived WebSocket upgrades and an operator-supplied
egress proxy. Host `telegram-proxy` through Compose or another persistent
runtime and expose it under the frontend's `/proxy/` path.

## Security

Never commit `proxy/.env`, proxy credentials, transcription keys, deployed
hostnames, or server addresses. Use secrets provided by your runtime platform.
