/**
 * Minimal Telegram Web proxy (client-only AI architecture).
 *
 * Goal: unblock CORS and websocket upgrades so the static Telegram WebA
 * client served from telegram.example.com (prod) and tgb.example.com (dev)
 * can talk to web.telegram.org without exposing the user's original IP.
 *
 * LLM execution remains in the browser. The optional MCP bridge only relays
 * short-lived, bearer-authorized tool envelopes between an external MCP
 * client and the already-authenticated browser tab; it does not create,
 * persist, or export Telegram sessions.
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { HttpsProxyAgent } from 'https-proxy-agent';

import { buildUpstreamHeaders, buildWhisperUpstreamHeaders } from './request-utils.js';
import { createBridgeHttpRouter } from './mcpBridge/http.js';

const PORT = Number(process.env.PORT || 7777);
const LISTEN_HOST = process.env.LISTEN_HOST || '0.0.0.0';
const UPSTREAM_PROXY = process.env.TELEGRAM_UPSTREAM_PROXY || 'http://127.0.0.1:3128';
const WHISPER_UPSTREAM = process.env.WHISPER_UPSTREAM || '';
const WHISPER_API_KEY = process.env.WHISPER_API_KEY || '';
const upstreamAgent = new HttpsProxyAgent(UPSTREAM_PROXY, {
  keepAlive: true,
  headers: { 'Proxy-Connection': 'Keep-Alive' },
});
const ALLOWED_WS_HOST_RE = /^zws\d+(?:-\d+)?\.web\.telegram\.org$/i;
const ALLOWED_WEBSYNC_HOST_RE = /^(?:t\.me|telegram\.me)$/i;
const ALLOWED_ORIGINS = new Set(
  (process.env.PUBLIC_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);

const MAX_REQ_BYTES = 64 * 1024 * 1024;
const MAX_RES_BYTES = 64 * 1024 * 1024;
const bridgeRouter = createBridgeHttpRouter();

const ROUTES = [
  { prefix: '/proxy/apiws/',       upstream: 'https://web.telegram.org/', strip: true, ws: true },
  { prefix: '/proxy/websync/',     upstream: 'https://t.me/',             strip: true, websync: true },
  { prefix: '/proxy/webtelegram/',  upstream: 'https://web.telegram.org/', strip: true },
  { prefix: '/proxy/telegram/',    upstream: 'https://web.telegram.org/', strip: true },
  { prefix: '/proxy/whisper-v1/',  upstream: WHISPER_UPSTREAM, strip: true, whisper: true, upstreamPathPrefix: '/v1' },
];

function allowedRoute(urlPath) {
  return ROUTES.find((r) => urlPath === r.prefix || urlPath.startsWith(r.prefix));
}

function corsAllowOrigin(req) {
  const raw = (req.headers.origin || req.headers.Origin || '');
  return ALLOWED_ORIGINS.has(raw) ? raw : null;
}

function appendCorsHeaders(res, req) {
  const origin = corsAllowOrigin(req);
  if (origin) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('vary', 'Origin');
  }
}

function writeStatus(req, res, status, body, headers = {}) {
  appendCorsHeaders(res, req);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.statusCode = status;
  res.end(body);
}

const HOP_HEADERS_BLOCKLIST = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'strict-transport-security',
]);

function pipeRequestToUpstream(req, res, route, targetHost) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let upstreamHost;
  let upstreamBasePath;
  if (targetHost) {
    upstreamHost = `https://${targetHost}`;
    const rest = url.pathname.slice(route.prefix.length + targetHost.length);
    upstreamBasePath = rest || '/';
  } else {
    upstreamHost = route.upstream;
    upstreamBasePath = `${route.upstreamPathPrefix || ''}${url.pathname.slice(route.prefix.length - 1)}`;
    if (!upstreamBasePath) upstreamBasePath = '/';
  }
  const upstreamUrl = new URL(upstreamBasePath + (url.search || ''), upstreamHost);
  const isHttps = upstreamUrl.protocol === 'https:';
  const transport = isHttps ? https : http;
  const forwardHeaders = route.whisper
    ? buildWhisperUpstreamHeaders(req.headers, upstreamUrl.host, WHISPER_API_KEY)
    : buildUpstreamHeaders(req.headers, upstreamUrl.host);
  forwardHeaders['x-forwarded-for'] = [
    req.headers['x-forwarded-for'],
    req.socket.remoteAddress,
  ].filter(Boolean).join(', ');
  forwardHeaders['x-forwarded-host'] = req.headers.host;
  forwardHeaders['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || (isHttps ? 'https' : 'http');

  const fwd = transport.request({
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || (isHttps ? 443 : 80),
    method: req.method,
    path: `${upstreamUrl.pathname}${upstreamUrl.search || ''}`,
    headers: forwardHeaders,
    ...(isHttps ? { agent: upstreamAgent, servername: upstreamUrl.hostname } : {}),
  });

  fwd.on('response', (upstreamRes) => {
    appendCorsHeaders(res, req);
    res.statusCode = upstreamRes.statusCode || 502;
    for (const [k, v] of Object.entries(upstreamRes.headers)) {
      if (HOP_HEADERS_BLOCKLIST.has(k.toLowerCase())) continue;
      res.setHeader(k, v);
    }
    let bytes = 0;
    upstreamRes.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_RES_BYTES) {
        upstreamRes.destroy();
        writeStatus(req, res, 502, 'upstream response too large');
        return;
      }
      res.write(chunk);
    });
    upstreamRes.on('end', () => res.end());
    upstreamRes.on('error', (err) => writeStatus(req, res, 502, `upstream error: ${err.message}`));
  });

  fwd.on('error', (err) => writeStatus(req, res, 502, `proxy failed: ${err.message}`));

  let uploaded = 0;
  req.on('data', (chunk) => {
    uploaded += chunk.length;
    if (uploaded > MAX_REQ_BYTES) {
      req.destroy();
      fwd.destroy();
      writeStatus(req, res, 413, 'request body too large');
    }
  });

  req.pipe(fwd);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/proxy/health') {
    writeStatus(req, res, 200, '{"status":"ok","clientOnly":true}', { 'content-type': 'application/json' });
    return;
  }

  if (bridgeRouter.matches(url.pathname)) {
    void bridgeRouter.handle(req, res, url);
    return;
  }

  const route = allowedRoute(url.pathname);
  if (!route) {
    if (req.method === 'OPTIONS') {
      writeStatus(req, res, 204, '');
      return;
    }
    writeStatus(req, res, 404, `not found: ${url.pathname}`);
    return;
  }

  if (route.whisper && (!WHISPER_UPSTREAM || !WHISPER_API_KEY)) {
    writeStatus(req, res, 503, 'whisper proxy is not configured');
    return;
  }

  let targetHost;
  if (route.ws || route.websync) {
    const restPath = url.pathname.slice(route.prefix.length);
    targetHost = restPath.split('/')[0];
    const validTarget = route.ws
      ? ALLOWED_WS_HOST_RE.test(targetHost)
      : ALLOWED_WEBSYNC_HOST_RE.test(targetHost);
    if (!validTarget) {
      writeStatus(req, res, 400, route.ws ? 'invalid telegram ws host' : 'invalid websync host');
      return;
    }
  }

  if (req.method === 'OPTIONS') {
    appendCorsHeaders(res, req);
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers'] || '*');
    res.setHeader('access-control-max-age', '86400');
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    pipeRequestToUpstream(req, res, route, targetHost);
  } catch (err) {
    writeStatus(req, res, 500, `error: ${err.message}`);
  }
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = allowedRoute(url.pathname);
  if (!route || !route.ws) { socket.destroy(); return; }
  const restPath = url.pathname.slice(route.prefix.length);
  const wsHost = restPath.split('/')[0];
  if (!ALLOWED_WS_HOST_RE.test(wsHost)) { socket.destroy(); return; }

  const rest = url.pathname.slice(route.prefix.length + wsHost.length) || '/';
  const upstreamUrl = new URL(rest + (url.search || ''), `https://${wsHost}`);
  const isHttps = upstreamUrl.protocol === 'https:';
  const transport = isHttps ? https : http;
  const forwardHeaders = buildUpstreamHeaders(req.headers, upstreamUrl.host, { websocket: true });
  const fwd = transport.request({
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || (isHttps ? 443 : 80),
    method: 'GET',
    path: `${upstreamUrl.pathname}${upstreamUrl.search || ''}`,
    headers: forwardHeaders,
    ...(isHttps ? { agent: upstreamAgent, servername: upstreamUrl.hostname } : {}),
  });

  fwd.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    const headerLines = Object.entries(upstreamRes.headers)
      .flatMap(([k, v]) => Array.isArray(v)
        ? v.flatMap((vv) => [`${k}: ${vv}`])
        : [`${k}: ${v}`]);
    const response = [
      'HTTP/1.1 101 Switching Protocols',
      ...headerLines,
      '',
      '',
    ].join('\r\n');
    socket.write(response);
    if (upstreamHead && upstreamHead.length) socket.write(Buffer.from(upstreamHead));
    upstreamSocket.on('data', (chunk) => socket.write(Buffer.from(chunk)));
    socket.on('data', (chunk) => upstreamSocket.write(Buffer.from(chunk)));
    const cleanup = () => { upstreamSocket.destroy(); socket.destroy(); };
    upstreamSocket.on('error', cleanup);
    upstreamSocket.on('close', cleanup);
    socket.on('error', cleanup);
    socket.on('close', cleanup);
  });
  fwd.on('response', (upstreamRes) => {
    const status = upstreamRes.statusCode || 502;
    const statusText = upstreamRes.statusMessage || '';
    const headerLines = Object.entries(upstreamRes.headers)
      .flatMap(([key, value]) => Array.isArray(value)
        ? value.map((item) => `${key}: ${item}`)
        : [`${key}: ${value}`]);
    socket.write([
      `HTTP/1.1 ${status} ${statusText}`.trimEnd(),
      ...headerLines,
      'Connection: close',
      '',
      '',
    ].join('\r\n'));
    upstreamRes.pipe(socket);
    upstreamRes.on('end', () => socket.end());
  });
  fwd.on('error', (err) => {
    try { socket.write(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n${err.message}`); } catch {}
    socket.destroy();
  });
  fwd.end();
});

server.listen(PORT, LISTEN_HOST, () => {
  console.log(`telegram-tt-proxy (client-only) listening on http://${LISTEN_HOST}:${PORT}`);
});
