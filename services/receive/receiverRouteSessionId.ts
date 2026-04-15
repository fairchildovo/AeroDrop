type ReceiverRouteSessionStorage = {
  storageKey: string;
  createId?: () => string;
};

type ReceiverRouteSessionReadStorage = ReceiverRouteSessionStorage & {
  read: (key: string) => string | null;
  write: (key: string, value: string) => void;
};

type ReceiverRouteSessionWriteStorage = ReceiverRouteSessionStorage & {
  write: (key: string, value: string) => void;
};

export const createReceiverRouteSessionId = () =>
  `rcv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const getOrCreateReceiverRouteSessionId = (storage: ReceiverRouteSessionReadStorage) => {
  const existing = storage.read(storage.storageKey);
  if (existing) {
    return existing;
  }

  const created = (storage.createId ?? createReceiverRouteSessionId)();
  storage.write(storage.storageKey, created);
  return created;
};

export const rotateReceiverRouteSessionId = (storage: ReceiverRouteSessionWriteStorage) => {
  const created = (storage.createId ?? createReceiverRouteSessionId)();
  storage.write(storage.storageKey, created);
  return created;
};
