# Deployment

This project is a browser client with a companion HTTP/WebSocket proxy. The
proxy uses an HTTP(S) egress proxy supplied by the operator; it does not bundle
an Xray or sing-box profile.

## Choose a deployment mode

| Platform | Frontend | Telegram proxy / MCP | Best for |
| --- | --- | --- | --- |
| Docker Compose | Yes | Yes | The complete self-hosted TChat stack |
| Vercel, Netlify, or Cloudflare Pages | Yes, static `dist` | No, add a separate persistent proxy | A simple static frontend |
| nginx or Caddy on a VPS | Yes | Yes, behind the same HTTPS origin | A production single-domain setup |
| Coolify, Portainer, or another Docker control plane | Yes | Yes, when Compose is supported | One-click-ish VPS management |

If Telegram login, proxy transport, or browser MCP is required, use Docker
Compose (or a persistent Docker host) as the default. Static hosting alone is
not a replacement for `telegram-proxy`.

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
the proxy requires a persistent runtime, WebSocket transport, and an
operator-supplied egress proxy.

### Fastest static deployment

Use the published `dist` archive; this avoids rebuilding the frontend and keeps
Telegram build values out of the Vercel project:

```bash
VERSION=12.0.32
mkdir -p tchat-dist
curl -L \
  -o tchat-dist.tar.gz \
  "https://github.com/meanwebuser/telegram-tt-beauty/releases/download/v${VERSION}/tchat-dist-${VERSION}.tar.gz"
tar -xzf tchat-dist.tar.gz -C tchat-dist
npx vercel --cwd tchat-dist
npx vercel --cwd tchat-dist --prod
```

The same directory can be uploaded through the Vercel dashboard as a static
project. If you import the Git repository instead, use the Vite preset and set
the output directory to `dist`; a production build needs the Telegram API
build-time values in Vercel's environment settings, never in committed files.

### Connecting a separate proxy

The browser expects `/proxy/` and `/_mcp-bridge/` on the same origin. Vercel
supports external rewrites, so a simple HTTP-only setup can use a root
`vercel.json` like this:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "rewrites": [
    { "source": "/proxy/:path*", "destination": "https://proxy.example.com/proxy/:path*" },
    { "source": "/_mcp-bridge/:path*", "destination": "https://proxy.example.com/_mcp-bridge/:path*" }
  ]
}
```

Run the browser smoke test against the real Vercel URL before relying on this
for Telegram transport. If WebSocket upgrades are not preserved by the chosen
edge path, put nginx/Caddy or the Compose web container in front of both
frontend and proxy on one HTTPS origin instead. Do not expose the proxy's
upstream credentials in Vercel or the browser bundle.

See Vercel's [static configuration](https://vercel.com/docs/project-configuration/vercel-json),
[external rewrites](https://vercel.com/docs/routing/rewrites), and
[CLI deployment](https://vercel.com/docs/cli/deploy) documentation.

## Coolify, Portainer, and Docker control planes

Use `release/compose.yaml` as a Compose application, set the version to
`12.0.32`, and create the runtime `proxy.env` from
`release/proxy.env.example`. Keep the web and proxy services on the same
private Compose network. Do not paste a Telegram session or upstream proxy
credential into a public repository field.

## CDN-only hosting

For a CDN or object-storage host, upload the extracted `dist` directory and
serve it as a static SPA. This gives you the frontend only. Route `/proxy/`
and `/_mcp-bridge/` to a separately managed proxy service, or use the full
Docker Compose deployment instead.

## Security

Never commit `proxy/.env`, proxy credentials, transcription keys, deployed
hostnames, or server addresses. Use secrets provided by your runtime platform.
