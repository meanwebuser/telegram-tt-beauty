const HOP_BY_HOP_HEADERS = [
  'connection',
  'proxy-connection',
  'upgrade',
  'http2-settings',
];

export function buildUpstreamHeaders(requestHeaders, upstreamHost, { websocket = false } = {}) {
  const headers = { ...requestHeaders };

  for (const header of HOP_BY_HOP_HEADERS) delete headers[header];

  headers.host = upstreamHost;
  headers.origin = 'https://web.telegram.org';
  headers.referer = 'https://web.telegram.org/a/';

  if (websocket) {
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
  }

  return headers;
}

export function buildWhisperUpstreamHeaders(requestHeaders, upstreamHost, apiKey) {
  const headers = { ...requestHeaders };

  for (const header of HOP_BY_HOP_HEADERS) delete headers[header];

  delete headers.origin;
  delete headers.referer;
  headers.host = upstreamHost;
  headers.authorization = `Bearer ${apiKey}`;

  return headers;
}
