export interface SerialAsyncProcessor {
  enqueue: <T>(task: () => Promise<T>) => Promise<T>;
  reset: () => void;
}

export const createSerialAsyncProcessor = (): SerialAsyncProcessor => {
  let tail: Promise<void> = Promise.resolve();

  return {
    enqueue: async (task) => {
      const run = tail.then(task);
      tail = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
    reset: () => {
      tail = Promise.resolve();
    },
  };
};
