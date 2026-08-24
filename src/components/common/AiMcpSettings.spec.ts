import { describe, expect, it } from 'vitest';

import { getMcpRuntimeStatus } from './AiMcpSettings';

describe('getMcpRuntimeStatus', () => {
  it('keeps local ownership and server relay status separate', () => {
    expect(getMcpRuntimeStatus(true, true)).toEqual({
      local: 'this-tab',
      server: 'connected',
    });
    expect(getMcpRuntimeStatus(false, false)).toEqual({
      local: 'another-tab',
      server: 'disconnected',
    });
  });
});
