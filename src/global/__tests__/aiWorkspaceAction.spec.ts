import { describe, expect, it, vi } from 'vitest';

const { callApi } = vi.hoisted(() => ({ callApi: vi.fn() }));

vi.mock('../../api/gramjs', () => ({ callApi }));
vi.mock('../../api/gramjs/methods/workspace', () => ({
  discoverWorkspace: vi.fn(() => {
    throw new Error('direct workspace method call');
  }),
  createWorkspace: vi.fn(() => {
    throw new Error('direct workspace method call');
  }),
}));

import { discoverOrCreateAiWorkspace } from '../actions/api/aiWorkspace';

describe('AI workspace action API boundary', () => {
  it('uses the worker API bridge for discovery and creation', async () => {
    callApi.mockImplementation((method: string) => {
      if (method === 'discoverWorkspace') return Promise.resolve(undefined);
      if (method === 'createWorkspace') return Promise.resolve({ chat: { id: 'workspace-1' } });
      return Promise.reject(new Error(`unexpected API method: ${method}`));
    });

    await expect(discoverOrCreateAiWorkspace('user-1')).resolves.toEqual({ id: 'workspace-1' });
    expect(callApi).toHaveBeenNthCalledWith(1, 'discoverWorkspace', 'user-1');
    expect(callApi).toHaveBeenNthCalledWith(2, 'createWorkspace', {
      title: 'Telegram AI Workspace · user-1',
    });
  });
});
