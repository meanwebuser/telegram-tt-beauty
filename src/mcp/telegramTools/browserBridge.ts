import { getCanonicalTelegramToolRuntime } from '../../global/llm/toolRuntime';

interface BrowserBridgeRuntime {
  getToolSchemas: () => unknown[];
  execute: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

interface BrowserMcpBridgeOptions {
  baseUrl: string;
  connectionId: string;
  bearer: string;
  browserConnectionId: string;
  runtime?: BrowserBridgeRuntime;
  fetchImpl?: typeof fetch;
  pollDelayMs?: number;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function webMcpContext(): Record<string, unknown> | undefined {
  const root = globalThis as typeof globalThis & {
    navigator?: { modelContext?: Record<string, unknown> };
    document?: { modelContext?: Record<string, unknown> };
  };
  return root.navigator?.modelContext || root.document?.modelContext;
}

function registerWebMcpTools(runtime: BrowserBridgeRuntime) {
  const context = webMcpContext();
  const registerTool = context?.registerTool;
  if (typeof registerTool !== 'function') return () => undefined;

  const unregister = context?.unregisterTool;
  const names: string[] = [];
  for (const schema of runtime.getToolSchemas()) {
    const tool = schema as {
      function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
    };
    const name = tool.function?.name;
    if (!name) continue;
    names.push(name);
    (registerTool as (definition: Record<string, unknown>) => unknown).call(context, {
      name,
      description: tool.function?.description || name,
      inputSchema: tool.function?.parameters || { type: 'object' },
      execute: (args: Record<string, unknown>) => runtime.execute(name, args),
    });
  }

  return () => {
    if (typeof unregister !== 'function') return;
    for (const name of names) {
      (unregister as (toolName: string) => unknown).call(context, name);
    }
  };
}

export function createBrowserTelegramMcpBridge(options: BrowserMcpBridgeOptions) {
  const runtime = options.runtime || getCanonicalTelegramToolRuntime();
  const fetchImpl = options.fetchImpl || fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const pollDelayMs = options.pollDelayMs ?? 250;
  const abortController = new AbortController();
  let stopped = false;
  let unregisterWebMcp: () => void = () => undefined;

  async function request(path: string, init: RequestInit = {}) {
    return fetchImpl(`${baseUrl}/_mcp-bridge/${options.connectionId}/${path}`, {
      ...init,
      signal: abortController.signal,
      headers: {
        authorization: options.bearer,
        'x-browser-connection-id': options.browserConnectionId,
        'content-type': 'application/json',
        ...(init.headers || {}),
      },
    });
  }

  async function connect() {
    const response = await request('browser/connect', {
      method: 'POST',
      body: JSON.stringify({
        browser_connection_id: options.browserConnectionId,
        tools: runtime.getToolSchemas(),
      }),
    });
    if (!response.ok) throw new Error(`MCP browser bridge connect failed: ${response.status}`);
    unregisterWebMcp = registerWebMcpTools(runtime);
  }

  async function poll() {
    while (!stopped) {
      try {
        const response = await request('browser/next', { method: 'GET' });
        if (response.status === 204) {
          await wait(pollDelayMs);
          continue;
        }
        if (!response.ok) throw new Error(`MCP browser bridge poll failed: ${response.status}`);
        const envelope = await response.json() as { request_id: string; tool: string; args: Record<string, unknown> };
        const result = await runtime.execute(envelope.tool, envelope.args || {});
        await request('browser/result', {
          method: 'POST',
          body: JSON.stringify({
            version: 1,
            kind: 'telegram.mcp.bridge.response',
            request_id: envelope.request_id,
            ok: true,
            result,
          }),
        });
      } catch (error) {
        if (stopped || (error instanceof DOMException && error.name === 'AbortError')) return;
        await wait(Math.max(500, pollDelayMs));
      }
    }
  }

  return {
    connect,
    start: async () => {
      await connect();
      void poll();
    },
    stop: () => {
      stopped = true;
      abortController.abort();
      unregisterWebMcp();
    },
    runtime,
  };
}
