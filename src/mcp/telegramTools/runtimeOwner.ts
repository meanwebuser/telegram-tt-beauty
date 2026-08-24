export type TelegramRuntimeRoute = 'local' | 'server';

export type TelegramRuntimeSerializationOwner = 'multitab-master' | 'server-session';

export interface TelegramRuntimeContract {
  route: TelegramRuntimeRoute;
  serializationOwner: TelegramRuntimeSerializationOwner;
  serializationDescription: string;
}

export interface RuntimeOwnerQueue {
  enqueue<T>(operation: () => PromiseLike<T> | T): Promise<T>;
}

const LOCAL_RUNTIME_CONTRACT: TelegramRuntimeContract = {
  route: 'local',
  serializationOwner: 'multitab-master',
  serializationDescription: 'Existing master-tab connector and Telegram update manager serialize browser calls.',
};

const SERVER_RUNTIME_CONTRACT: TelegramRuntimeContract = {
  route: 'server',
  serializationOwner: 'server-session',
  serializationDescription: 'The existing server MCP session owns serialization for server-routed calls.',
};

/**
 * Selects the existing Telegram runtime boundary without creating a client.
 *
 * @param route The caller-selected local browser or server session route.
 * @returns The route and its existing serialization owner.
 */
export function selectTelegramRuntime(route: TelegramRuntimeRoute): TelegramRuntimeContract {
  return route === 'local' ? LOCAL_RUNTIME_CONTRACT : SERVER_RUNTIME_CONTRACT;
}

/**
 * Creates a FIFO queue for work owned by one runtime serialization boundary.
 *
 * @returns A queue that runs each operation after all earlier operations settle.
 */
export function createRuntimeOwnerQueue(): RuntimeOwnerQueue {
  let tail: Promise<void> = Promise.resolve();

  return {
    enqueue<T>(operation: () => PromiseLike<T> | T): Promise<T> {
      const result = tail.then(() => operation());
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}
