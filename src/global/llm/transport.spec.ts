import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendLlmRequest } from './transport';

afterEach(() => vi.unstubAllGlobals());

describe('LLM canonical tool loop', () => {
  it('advertises the same tools and executes tool calls before the final answer', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'read', arguments: '{"chat_id":"chat-1"}' },
            }],
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Готово' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const executeTool = vi.fn().mockResolvedValue({ ok: true, data: { messages: [] } });
    const result = await sendLlmRequest({
      endpointUrl: 'https://llm.example/v1',
      apiKey: 'test-key',
      model: 'test-model',
      stream: true,
      tools: [{
        type: 'function',
        function: { name: 'read', description: 'read', parameters: { type: 'object' } },
      }],
      executeToolCall: executeTool,
    }, [{ role: 'user', content: 'прочитай чат' }]);

    expect(result).toBe('Готово');
    expect(executeTool).toHaveBeenCalledWith('read', '{"chat_id":"chat-1"}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetchMock.mock.calls[0][1].body);
    const second = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(first.tools[0].function.name).toBe('read');
    expect(first.stream).toBe(false);
    expect(second.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call-1' });
  });
});
