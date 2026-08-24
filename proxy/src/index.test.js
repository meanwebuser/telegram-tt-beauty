import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const waitForLine = async (stream, timeout = 5000) => {
  let buffer = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy did not start')), timeout);
    stream.setEncoding('utf8');
    const onData = (chunk) => {
      buffer += chunk;
      if (buffer.includes('\n')) {
        clearTimeout(timer);
        stream.off('data', onData);
        resolve(buffer);
      }
    };
    stream.on('data', onData);
  });
};

const freePort = async () => {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};

const startProxy = async (env = {}) => {
  const port = await freePort();
  const child = spawn(process.execPath, ['proxy/src/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), LISTEN_HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForLine(child.stdout);
  return { child, base: `http://127.0.0.1:${port}` };
};

const stop = async (child) => {
  child.kill('SIGTERM');
  await once(child, 'exit');
};

describe('public MCP proxy forwarding', () => {
  it('forwards path/query, auth/content headers, status, and streamed response', async () => {
    const chunks = ['first-', 'second'];
    const received = {};
    const upstream = http.createServer((req, res) => {
      received.path = req.url;
      received.authorization = req.headers.authorization;
      received.contentType = req.headers['content-type'];
      req.resume();
      res.writeHead(207, { 'content-type': 'text/plain', 'x-upstream': 'yes' });
      res.write(chunks[0]);
      setTimeout(() => { res.end(chunks[1]); }, 10);
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const { child, base } = await startProxy({ MCP_UPSTREAM: `http://127.0.0.1:${upstream.address().port}/base` });
    try {
      const response = await fetch(`${base}/mcp?session=abc`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: '{"jsonrpc":"2.0"}',
      });
      expect(response.status).toBe(207);
      expect(response.headers.get('x-upstream')).toBe('yes');
      expect(await response.text()).toBe(chunks.join(''));
      expect(received).toMatchObject({
        path: '/mcp?session=abc',
        authorization: 'Bearer test-token',
        contentType: 'application/json',
      });
    } finally {
      await stop(child);
      await new Promise((resolve) => upstream.close(resolve));
    }
  });

  it('returns 503 when MCP_UPSTREAM is unconfigured', async () => {
    const { child, base } = await startProxy({ MCP_UPSTREAM: '' });
    try {
      const response = await fetch(`${base}/mcp`);
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('MCP proxy is not configured');
    } finally {
      await stop(child);
    }
  });
});
