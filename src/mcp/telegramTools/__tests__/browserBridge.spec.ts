import { describe, expect, it, vi } from 'vitest';

import { createBrowserTelegramMcpBridge } from '../browserBridge';

describe('browser Telegram MCP bridge', () => {
  it('announces the canonical tools and executes browser-poll requests', async () => {
    const runtime = {
      getToolSchemas: () => [{ type: 'function', function: { name: 'chats' } }],
      execute: vi.fn().mockResolvedValue({ ok: true, data: { chats: [] } }),
    };
    const responses = [
      new Response('{}', { status: 200 }),
      new Response(JSON.stringify({ request_id: 'req-1', tool: 'chats', args: {} }), { status: 200 }),
      new Response('{}', { status: 202 }),
    ];
    const fetchImpl = vi.fn().mockImplementation(() => responses.shift() || new Response(undefined, { status: 204 }));
    const bridge = createBrowserTelegramMcpBridge({
      baseUrl: 'https://example.test',
      connectionId: 'conn-1',
      bearer: 'Bearer secret',
      browserConnectionId: 'browser-1',
      runtime,
      fetchImpl,
      pollDelayMs: 1,
    });

    await bridge.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    bridge.stop();

    expect(fetchImpl.mock.calls[0][0]).toContain('/conn-1/browser/connect');
    expect(fetchImpl.mock.calls[0][1].headers['x-browser-connection-id']).toBe('browser-1');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).tools).toHaveLength(1);
    expect(runtime.execute).toHaveBeenCalledWith('chats', {}, expect.objectContaining({
      correlationId: 'req-1',
      transport: 'browser-mcp',
      allowWrite: false,
      abortControllerGroup: expect.stringMatching(/^mcp-conn-1-/),
      isActive: expect.any(Function),
    }));
    const resultCall = fetchImpl.mock.calls.find(([url]) => String(url).includes('/conn-1/browser/result'));
    expect(resultCall?.[1].headers['x-browser-connection-id']).toBe('browser-1');
  });

  it('fails closed and does not expose send when write permission is disabled', async () => {
    const audit = vi.fn();
    const runtime = {
      getToolSchemas: () => [
        { type: 'function', function: { name: 'read' } },
        { type: 'function', function: { name: 'send' } },
      ],
      execute: vi.fn(),
    };
    const responses = [
      new Response('{}', { status: 200 }),
      new Response(JSON.stringify({
        request_id: 'send-1', tool: 'send', args: { chat_id: 'chat-1', text: 'no' },
      }), { status: 200 }),
      new Response('{}', { status: 202 }),
    ];
    const fetchImpl = vi.fn().mockImplementation(
      () => responses.shift() || new Response(undefined, { status: 204 }),
    );
    const bridge = createBrowserTelegramMcpBridge({
      baseUrl: 'https://example.test',
      connectionId: 'conn-2',
      bearer: 'Bearer secret',
      browserConnectionId: 'browser-2',
      runtime,
      fetchImpl,
      pollDelayMs: 1,
      audit,
    });

    await bridge.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    bridge.stop();

    const connectBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(connectBody.tools.map((tool: { function: { name: string } }) => tool.function.name))
      .toEqual(['read']);
    expect(runtime.execute).not.toHaveBeenCalled();
    const resultCall = fetchImpl.mock.calls.find(([url]) => String(url).includes('/conn-2/browser/result'));
    expect(JSON.parse(resultCall?.[1].body).result.error.code).toBe('WRITE_DISABLED');
    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit.mock.calls[1][0]).toMatchObject({
      event: 'mcp_call_end',
      correlation_id: 'send-1',
      error_code: 'WRITE_DISABLED',
      ok: false,
    });
  });

  it('fails closed after stop even when WebMCP has no unregisterTool', async () => {
    const originalDocument = globalThis.document;
    const registered: Record<string, {
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    }> = {};
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        modelContext: {
          registerTool: (definition: {
            name: string;
            execute: (args: Record<string, unknown>) => Promise<unknown>;
          }) => {
            registered[definition.name] = definition;
          },
        },
      },
    });
    try {
      const runtime = {
        getToolSchemas: () => [{ type: 'function', function: { name: 'send' } }],
        execute: vi.fn().mockResolvedValue({ ok: true }),
      };
      const fetchImpl = vi.fn().mockResolvedValue(new Response(undefined, { status: 204 }));
      const bridge = createBrowserTelegramMcpBridge({
        baseUrl: 'https://example.test',
        connectionId: 'conn-3',
        bearer: 'Bearer secret',
        browserConnectionId: 'browser-3',
        runtime,
        fetchImpl,
        allowWrite: true,
        pollDelayMs: 1,
      });

      await bridge.start();
      bridge.stop();
      const result = await registered.send.execute({ chat_id: 'chat-1', text: 'blocked' });

      expect(result).toMatchObject({ ok: false, error: { code: 'MCP_DISABLED' } });
      expect(runtime.execute).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      });
    }
  });

  it('rolls back partial WebMCP registration when a later tool fails', async () => {
    const originalDocument = globalThis.document;
    const unregistered: string[] = [];
    let registrations = 0;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        modelContext: {
          registerTool: () => {
            registrations += 1;
            if (registrations === 2) throw new Error('register failed');
          },
          unregisterTool: (name: string) => unregistered.push(name),
        },
      },
    });
    try {
      const runtime = {
        getToolSchemas: () => [
          { type: 'function', function: { name: 'read' } },
          { type: 'function', function: { name: 'send' } },
        ],
        execute: vi.fn(),
      };
      const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
      const bridge = createBrowserTelegramMcpBridge({
        baseUrl: 'https://example.test',
        connectionId: 'conn-4',
        bearer: 'Bearer secret',
        browserConnectionId: 'browser-4',
        runtime,
        fetchImpl,
        allowWrite: true,
      });

      await expect(bridge.start()).rejects.toThrow('register failed');
      expect(unregistered).toEqual(['read']);
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      });
    }
  });

  it('does not register WebMCP tools when stop wins an in-flight connect', async () => {
    const originalDocument = globalThis.document;
    let releaseConnect: (response: Response) => void = () => undefined;
    let registrations = 0;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        modelContext: {
          registerTool: () => { registrations += 1; },
        },
      },
    });
    try {
      const runtime = {
        getToolSchemas: () => [{ type: 'function', function: { name: 'send' } }],
        execute: vi.fn(),
      };
      const connectResponse = new Promise<Response>((resolve) => {
        releaseConnect = resolve;
      });
      const fetchImpl = vi.fn().mockImplementation(() => connectResponse);
      const bridge = createBrowserTelegramMcpBridge({
        baseUrl: 'https://example.test',
        connectionId: 'conn-5',
        bearer: 'Bearer secret',
        browserConnectionId: 'browser-5',
        runtime,
        fetchImpl,
        allowWrite: true,
      });

      const startPromise = bridge.start();
      bridge.stop();
      releaseConnect(new Response('{}', { status: 200 }));
      await startPromise;

      expect(registrations).toBe(0);
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      });
    }
  });

  it('self-disables WebMCP tools when remote authorization is revoked', async () => {
    const originalDocument = globalThis.document;
    let registered: { execute: (args: Record<string, unknown>) => Promise<unknown> } | undefined;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        modelContext: {
          registerTool: (definition: { execute: (args: Record<string, unknown>) => Promise<unknown> }) => {
            registered = definition;
          },
        },
      },
    });
    try {
      const runtime = {
        getToolSchemas: () => [{ type: 'function', function: { name: 'send' } }],
        execute: vi.fn(),
      };
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(new Response('{}', { status: 403 }));
      const bridge = createBrowserTelegramMcpBridge({
        baseUrl: 'https://example.test',
        connectionId: 'conn-6',
        bearer: 'Bearer secret',
        browserConnectionId: 'browser-6',
        runtime,
        fetchImpl,
        allowWrite: true,
        pollDelayMs: 1,
      });

      await bridge.start();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await registered!.execute({ chat_id: 'chat-1', text: 'blocked' });

      expect(result).toMatchObject({ ok: false, error: { code: 'MCP_DISABLED' } });
      expect(runtime.execute).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      });
    }
  });
});
