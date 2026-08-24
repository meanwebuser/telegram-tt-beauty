import { getCanonicalTelegramToolRuntime } from '../../global/llm/toolRuntime';
import { callApi } from '../../api/gramjs';
import {
  consoleAuditSink,
  createCorrelationId,
  emitTelegramAudit,
  type TelegramAuditSink,
  type TelegramToolExecutionContext,
} from './audit';

interface BrowserBridgeRuntime {
  getToolSchemas: () => unknown[];
  execute: (
    name: string,
    args: Record<string, unknown>,
    context?: TelegramToolExecutionContext,
  ) => Promise<unknown>;
}

function isMutationTool(name: string, args?: Record<string, unknown>) {
  return name === 'send'
    || name === 'edit_message'
    || name === 'mutation.confirm'
    || (name === 'read' && args?.mark_read === true);
}

interface BrowserMcpBridgeOptions {
  baseUrl: string;
  connectionId: string;
  bearer: string;
  browserConnectionId: string;
  runtime?: BrowserBridgeRuntime;
  fetchImpl?: typeof fetch;
  pollDelayMs?: number;
  allowWrite?: boolean;
  audit?: TelegramAuditSink;
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

function writeDisabledResult() {
  return {
    ok: false,
    error: {
      code: 'WRITE_DISABLED',
      message: 'MCP write permission is disabled for this connection',
    },
  };
}

function bridgeDisabledResult() {
  return {
    ok: false,
    error: {
      code: 'MCP_DISABLED',
      message: 'MCP bridge is disabled',
    },
  };
}

function registerWebMcpTools(
  runtime: BrowserBridgeRuntime,
  allowWrite: boolean,
  getExecutionContext: () => TelegramToolExecutionContext,
) {
  const context = webMcpContext();
  const registerTool = context?.registerTool;
  if (typeof registerTool !== 'function') return () => undefined;

  const unregister = context?.unregisterTool;
  const names: string[] = [];
  let active = true;
  try {
    for (const schema of runtime.getToolSchemas()) {
      const tool = schema as {
        function?: { name?: string; description?: string; parameters?: Record<string, unknown> };
      };
      const name = tool.function?.name;
      if (!name) continue;
      if (isMutationTool(name) && !allowWrite) continue;
      (registerTool as (definition: Record<string, unknown>) => unknown).call(context, {
        name,
        description: tool.function?.description || name,
        inputSchema: tool.function?.parameters || { type: 'object' },
        execute: (args: Record<string, unknown>) => {
          if (!active) return Promise.resolve(bridgeDisabledResult());
          if (isMutationTool(name) && !allowWrite) return Promise.resolve(writeDisabledResult());
          const executionContext = getExecutionContext();
          if (executionContext.isActive && !executionContext.isActive()) {
            return Promise.resolve(bridgeDisabledResult());
          }
          return runtime.execute(name, args, executionContext);
        },
      });
      names.push(name);
    }
  } catch (error) {
    active = false;
    if (typeof unregister === 'function') {
      for (const name of names) {
        try {
          (unregister as (toolName: string) => unknown).call(context, name);
        } catch {
          // Continue cleaning up the remaining registrations.
        }
      }
    }
    throw error;
  }

  return () => {
    active = false;
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
  const allowWrite = options.allowWrite === true;
  const audit = options.audit || consoleAuditSink;
  const abortController = new AbortController();
  const abortControllerGroup = `mcp-${options.connectionId}-${createCorrelationId()}`;
  let stopped = false;
  let unregisterWebMcp: () => void = () => undefined;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    abortController.abort();
    unregisterWebMcp();
    void callApi('abortRequestGroup', abortControllerGroup).catch(() => undefined);
  };

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

  const checkActive = async () => {
    if (stopped) return false;
    try {
      const response = await request('browser/status', { method: 'GET' });
      if (!response.ok) {
        stop();
        return false;
      }
      return !stopped;
    } catch {
      stop();
      return false;
    }
  };

  async function connect() {
    const response = await request('browser/connect', {
      method: 'POST',
      body: JSON.stringify({
        browser_connection_id: options.browserConnectionId,
        tools: runtime.getToolSchemas().filter((schema) => {
          const name = (schema as { function?: { name?: string } }).function?.name;
          return name ? allowWrite || !isMutationTool(name) : false;
        }),
      }),
    });
    if (!response.ok) throw new Error(`MCP browser bridge connect failed: ${response.status}`);
    if (stopped) return;
    unregisterWebMcp = registerWebMcpTools(runtime, allowWrite, () => ({
      correlationId: createCorrelationId(),
      transport: 'webmcp',
      allowWrite,
      actor: `browser:${options.browserConnectionId}`,
      sessionId: options.connectionId,
      harness: 'webmcp',
      abortControllerGroup,
      isActive: () => !stopped,
      checkActive,
    }));
  }

  async function poll() {
    while (!stopped) {
      try {
        const response = await request('browser/next', { method: 'GET' });
        if (response.status === 401 || response.status === 403) {
          stop();
          return;
        }
        if (response.status === 204) {
          await wait(pollDelayMs);
          continue;
        }
        if (!response.ok) throw new Error(`MCP browser bridge poll failed: ${response.status}`);
        const envelope = await response.json() as { request_id: string; tool: string; args: Record<string, unknown> };
        if (stopped) return;
        const statusResponse = await request('browser/status', { method: 'GET' });
        if (!statusResponse.ok) {
          stop();
          return;
        }
        if (stopped) return;
        const context = {
          correlationId: envelope.request_id,
          transport: 'browser-mcp',
          allowWrite,
          actor: `browser:${options.browserConnectionId}`,
          sessionId: options.connectionId,
          harness: 'browser-mcp',
          abortControllerGroup,
          isActive: () => !stopped,
          checkActive,
        };
        let result;
        const deniedMutation = !allowWrite && isMutationTool(envelope.tool, envelope.args);
        if (deniedMutation) {
          await emitTelegramAudit(audit, {
            event: 'mcp_call_start',
            context,
            tool: envelope.tool,
            chat_id: typeof envelope.args?.chat_id === 'string' ? envelope.args.chat_id : undefined,
            text: typeof envelope.args?.text === 'string' ? envelope.args.text : undefined,
          });
          result = writeDisabledResult();
          await emitTelegramAudit(audit, {
            event: 'mcp_call_end',
            context,
            tool: envelope.tool,
            chat_id: typeof envelope.args?.chat_id === 'string' ? envelope.args.chat_id : undefined,
            text: typeof envelope.args?.text === 'string' ? envelope.args.text : undefined,
            ok: false,
            error_code: 'WRITE_DISABLED',
          });
        } else {
          if (stopped) return;
          result = await runtime.execute(envelope.tool, envelope.args || {}, context);
        }
        if (stopped) return;
        const resultResponse = await request('browser/result', {
          method: 'POST',
          body: JSON.stringify({
            version: 1,
            kind: 'telegram.mcp.bridge.response',
            request_id: envelope.request_id,
            ok: true,
            result,
          }),
        });
        if (resultResponse.status === 401 || resultResponse.status === 403) {
          stop();
          return;
        }
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
      if (stopped) return;
      void poll();
    },
    stop: () => {
      stop();
    },
    runtime,
  };
}
