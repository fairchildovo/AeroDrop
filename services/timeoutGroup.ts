export interface TimeoutGroupScheduler {
  set: (callback: () => void, delayMs: number) => number;
  clear: (id: number) => void;
}

export interface TimeoutGroup {
  schedule: (callback: () => void, delayMs: number) => number;
  clear: (id: number | null | undefined) => void;
  clearAll: () => void;
  size: () => number;
}

const defaultScheduler: TimeoutGroupScheduler = {
  set: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clear: (id) => window.clearTimeout(id),
};

export const createTimeoutGroup = (
  scheduler: TimeoutGroupScheduler = defaultScheduler
): TimeoutGroup => {
  const activeTimeouts = new Set<number>();

  return {
    schedule: (callback, delayMs) => {
      let handle = 0;
      handle = scheduler.set(() => {
        activeTimeouts.delete(handle);
        callback();
      }, delayMs);
      activeTimeouts.add(handle);
      return handle;
    },
    clear: (id) => {
      if (typeof id !== 'number') {
        return;
      }
      if (!activeTimeouts.delete(id)) {
        return;
      }
      scheduler.clear(id);
    },
    clearAll: () => {
      for (const handle of activeTimeouts) {
        scheduler.clear(handle);
      }
      activeTimeouts.clear();
    },
    size: () => activeTimeouts.size,
  };
};
