/**
 * OpenAI-Compatible Transport for Client-only AI Sidebar
 *
 * Direct calls to OpenAI-compatible endpoints from the browser.
 * Supports streaming responses, abort, and proper error handling.
 *
 * Security:
 * - API keys are never stored in Telegram or sent to any application server
 * - Authorization headers are redacted from error logs
 * - CORS diagnostics are included for troubleshooting
 */

import type { ApiMessage } from '../../api/types';
import { redactSensitiveText } from '../types/envelopeProtocol';

import { DEBUG } from '../../config';

/**
 * Configuration for the LLM endpoint.
 */
export interface LlmConfig {
  /**
   * OpenAI-compatible API endpoint URL.
   */
  endpointUrl?: string;

  /**
   * API key / bearer token for the endpoint.
   * Never persisted to Telegram; held in memory only.
   */
  apiKey?: string;

  /**
   * Model to use for completions.
   */
  model?: string;

  /**
   * Maximum tokens for responses.
   */
  maxTokens?: number;

  /**
   * Temperature for sampling (0.0 to 2.0).
   */
  temperature?: number;

  /**
   * Whether to stream responses.
   */
  stream?: boolean;

  /** Canonical Telegram tools advertised to the model. */
  tools?: LlmRequest['tools'];

  /** Executes a canonical tool call in the authenticated browser session. */
  executeToolCall?: (name: string, argumentsJson: string) => Promise<unknown>;
}

/**
 * Message format for LLM requests.
 */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: LlmToolCall[];
}

/**
 * Tool call format for LLM requests.
 */
export interface LlmToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * LLM request payload.
 */
export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
}

/**
 * LLM response format (non-streaming).
 */
export interface LlmResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: LlmMessage;
    finishReason: string | null;
  }>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Streaming chunk format.
 */
export interface LlmStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      toolCalls?: LlmToolCall[];
    };
    finishReason: string | null;
  }>;
}

function toWireMessage(message: LlmMessage) {
  return {
    role: message.role,
    content: message.content,
    ...(message.name ? { name: message.name } : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.toolCalls ? { tool_calls: message.toolCalls } : {}),
  };
}

function normalizeToolCalls(message: LlmMessage & { tool_calls?: LlmToolCall[] }) {
  return message.toolCalls || message.tool_calls || [];
}

/**
 * LLM error response.
 */
export interface LlmErrorResponse {
  error: {
    message: string;
    type: string;
    param?: string;
    code?: string;
  };
}

/**
 * Progress callback for streaming responses.
 */
export type StreamingProgress = (
  content: string,
  isComplete: boolean,
  error?: string,
) => void;

/**
 * Send a request to the LLM endpoint with optional streaming.
 *
 * @param config - LLM configuration
 * @param messages - Messages to send to the LLM
 * @param onProgress - Callback for streaming progress (optional)
 * @param abortSignal - AbortSignal to cancel the request (optional)
 * @returns Promise with the response or undefined on error
 */
export async function sendLlmRequest(
  config: LlmConfig,
  messages: LlmMessage[],
  onProgress?: StreamingProgress,
  abortSignal?: AbortSignal,
  toolRound = 0,
): Promise<string | undefined> {
  const {
    endpointUrl,
    apiKey,
    model = 'gpt-4',
    maxTokens = 4096,
    temperature = 0.7,
    stream = false,
    tools,
    executeToolCall,
  } = config;

  if (!endpointUrl) {
    const error = 'No LLM endpoint configured';
    onProgress?.('', false, error);
    return undefined;
  }

  if (!apiKey) {
    const error = 'No API key configured';
    onProgress?.('', false, error);
    return undefined;
  }

  const targetUrl = normalizeChatCompletionsUrl(endpointUrl);

  const useStreaming = Boolean(stream && !tools?.length);
  const payload: LlmRequest = {
    model,
    messages: messages.map(toWireMessage),
    maxTokens,
    temperature,
    stream: useStreaming,
    ...(tools?.length ? { tools } : {}),
  };

  let accumulatedContent = '';

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: abortSignal,
    });

    if (!response.ok) {
      // Handle CORS errors specifically
      if (response.type === 'opaque') {
        const error = 'CORS error: the endpoint does not allow cross-origin requests from this browser.';
        onProgress?.('', false, error);
        if (DEBUG) {
          // eslint-disable-next-line no-console
          console.error('[LLM Transport] CORS error', {
            endpointUrl,
            response,
          });
        }
        return undefined;
      }

      // Handle other HTTP errors
      const errorText = await response.text();
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;

      try {
        const errorJson = JSON.parse(errorText) as LlmErrorResponse;
        errorMessage = errorJson.error?.message || errorMessage;
      } catch {
        errorMessage = `${errorMessage}\n${redactSensitiveText(errorText)}`;
      }

      onProgress?.('', false, errorMessage);

      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.error('[LLM Transport] HTTP error', {
          status: response.status,
          statusText: response.statusText,
          error: redactSensitiveText(errorText),
        });
      }

      return undefined;
    }

    if (useStreaming && onProgress) {
      // Handle streaming response
      const reader = response.body?.getReader();
      if (!reader) {
        const error = 'Failed to get response reader';
        onProgress?.('', false, error);
        return undefined;
      }

      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n').filter((line) => line.trim());

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);

              if (data === '[DONE]') {
                onProgress?.(accumulatedContent, true);
                return accumulatedContent;
              }

              try {
                const parsed = JSON.parse(data) as LlmStreamChunk;
                const delta = parsed.choices?.[0]?.delta;

                if (delta?.content) {
                  accumulatedContent += delta.content;
                  onProgress?.(accumulatedContent, false);
                }
              } catch {
                // Ignore parse errors for partial chunks
              }
            }
          }
        }

        onProgress?.(accumulatedContent, true);
        return accumulatedContent;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Stream reading failed';
        onProgress?.(accumulatedContent, false, errorMessage);

        if (DEBUG) {
          // eslint-disable-next-line no-console
          console.error('[LLM Transport] Stream error', error);
        }

        return accumulatedContent || undefined;
      }
    } else {
      // Handle non-streaming response
      const data = await response.json() as LlmResponse;
      const message = data.choices?.[0]?.message as (LlmMessage & { tool_calls?: LlmToolCall[] }) | undefined;
      const toolCalls = normalizeToolCalls(message || {} as LlmMessage & { tool_calls?: LlmToolCall[] });

      if (toolCalls.length && executeToolCall && toolRound < 3 && message) {
        const toolResults = await Promise.all(toolCalls.map(async (toolCall) => {
          const result = await executeToolCall(toolCall.function.name, toolCall.function.arguments);
          return {
            role: 'tool' as const,
            content: typeof result === 'string' ? result : JSON.stringify(result),
            toolCallId: toolCall.id,
          };
        }));
        return sendLlmRequest(
          { ...config, stream: false },
          [
            ...messages,
            {
              role: 'assistant',
              content: message.content || '',
              toolCalls,
            },
            ...toolResults,
          ],
          onProgress,
          abortSignal,
          toolRound + 1,
        );
      }

      const content = message?.content;

      if (content) {
        onProgress?.(content, true);
        return content;
      }

      const error = 'No content in response';
      onProgress?.('', false, error);
      return undefined;
    }
  } catch (error) {
    // Handle fetch errors (network errors, aborts, etc.)
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        onProgress?.(accumulatedContent, false, 'Request cancelled');
      } else {
        const errorMessage = redactSensitiveText(error.message);
        onProgress?.('', false, errorMessage);

        if (DEBUG) {
          // eslint-disable-next-line no-console
          console.error('[LLM Transport] Fetch error', error);
        }
      }
    }

    return accumulatedContent || undefined;
  }
}

/**
 * Test endpoint connectivity with CORS diagnostics.
 *
 * @param endpointUrl - The endpoint URL to test
 * @returns Promise with diagnostic information
 */
export async function testEndpointConnectivity(
  endpointUrl: string,
): Promise<{
  isReachable: boolean;
  corsSupported: boolean;
  error?: string;
  diagnosticInfo?: Record<string, unknown>;
}> {
  try {
    const response = await fetch(endpointUrl, {
      method: 'OPTIONS',
      mode: 'cors',
    });

    return {
      isReachable: true,
      corsSupported: true,
      diagnosticInfo: {
        status: response.status,
        statusText: response.statusText,
        corsHeaders: {
          'access-control-allow-origin': response.headers.get('access-control-allow-origin'),
          'access-control-allow-methods': response.headers.get('access-control-allow-methods'),
          'access-control-allow-headers': response.headers.get('access-control-allow-headers'),
        },
      },
    };
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('NetworkError') || error.message.includes('Failed to fetch')) {
        return {
          isReachable: false,
          corsSupported: false,
          error: 'Network error: Unable to reach the endpoint. This may be a CORS issue or the endpoint is down.',
          diagnosticInfo: {
            errorType: error.name,
            errorMessage: error.message,
          },
        };
      }

      return {
        isReachable: false,
        corsSupported: false,
        error: error.message,
        diagnosticInfo: {
          errorType: error.name,
          errorMessage: error.message,
        },
      };
    }

    return {
      isReachable: false,
      corsSupported: false,
      error: 'Unknown error',
      diagnosticInfo: { error },
    };
  }
}

/**
 * Normalize an OpenAI-compatible endpoint URL so it always points at
 * `/chat/completions`. Accepts:
 *   - https://host
 *   - https://host/v1
 *   - https://host/v1/chat/completions
 *   - https://host/some/path/chat/completions
 */
export function normalizeChatCompletionsUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return trimmed;
  if (/\/chat\/completions\/?$/i.test(trimmed)) return trimmed;
  // Strip trailing `/v1` so we can re-append it.
  const withV1 = /\/(v\d+(?:\.\d+)?)\/?$/i.test(trimmed)
    ? trimmed
    : `${trimmed}${trimmed.endsWith('/') ? '' : '/'}v1`;
  return `${withV1.replace(/\/$/, '')}/chat/completions`;
}

/**
 * Convert Telegram messages to LLM message format.
 *
 * The `prompt` argument (the user's quick-command text or their typed
 * request) is appended last as a user-role message. Loaded chat history
 * is inserted before it as user/assistant pairs so the model has the
 * surrounding context for "summarize new" / "extract action items" etc.
 */
export function convertMessagesToLlmFormat(
  messages: ApiMessage[],
  prompt: string,
): LlmMessage[] {
  const llmMessages: LlmMessage[] = [];

  // TODO: Parse messages using envelope parser
  for (const message of messages) {
    const text = message.content?.text?.text;
    if (!text) continue;

    const isFromUser = message.senderId !== '0';

    llmMessages.push({
      role: isFromUser ? 'user' : 'assistant',
      content: text,
    });
  }

  // The user's actual request — quick-command prompt or typed text — goes
  // last so the model answers it after seeing context.
  if (prompt?.trim()) {
    llmMessages.push({
      role: 'user',
      content: prompt.trim(),
    });
  }

  return llmMessages;
}
