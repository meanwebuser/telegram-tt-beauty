import { describe, expect, it } from 'vitest';

import { createRuntimeOwnerQueue, selectTelegramRuntime } from '../runtimeOwner';

describe('Telegram runtime owner contract', () => {
  it('selects the existing serialization owner for each route', () => {
    expect(selectTelegramRuntime('local')).toMatchObject({
      route: 'local',
      serializationOwner: 'multitab-master',
    });
    expect(selectTelegramRuntime('server')).toMatchObject({
      route: 'server',
      serializationOwner: 'server-session',
    });
  });

  it('executes one runtime owner queue in FIFO order', async () => {
    const queue = createRuntimeOwnerQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue(async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
      return 'first';
    });
    const second = queue.enqueue(() => {
      events.push('second');
      return 'second';
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });
});
