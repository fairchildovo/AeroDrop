import { crc32FinalHex, crc32Init, crc32Update } from './hashUtils';

type Crc32WorkerRequest =
  | { type: 'reset'; requestId: number }
  | { type: 'update'; buffer: ArrayBuffer }
  | { type: 'finalize'; requestId: number };

type Crc32WorkerResponse =
  | { type: 'reset_ack'; requestId: number }
  | { type: 'finalize_result'; requestId: number; hashHex: string }
  | { type: 'error'; requestId?: number; message: string };

type PendingRequest<T> = {
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

export interface Crc32Hasher {
  reset(): Promise<void>;
  update(data: Uint8Array): void;
  finalizeHex(): Promise<string>;
  terminate(): void;
}

class Crc32WorkerHasher implements Crc32Hasher {
  private static readonly WORKER_BATCH_BYTES = 2 * 1024 * 1024;
  private worker: Worker | null = null;
  private syncState = crc32Init();
  private requestSeq = 0;
  private mode: 'worker' | 'sync' = 'sync';
  private fatalError: Error | null = null;
  private readonly label: string;
  private readonly pendingResets = new Map<number, PendingRequest<void>>();
  private readonly pendingFinalizes = new Map<number, PendingRequest<string>>();
  private pendingWorkerChunks: Uint8Array[] = [];
  private pendingWorkerBytes = 0;
  private readonly onMessageBound: (event: MessageEvent<Crc32WorkerResponse>) => void;
  private readonly onErrorBound: (event: ErrorEvent) => void;
  private readonly onMessageErrorBound: () => void;

  constructor(label: string) {
    this.label = label;
    this.onMessageBound = this.onMessage.bind(this);
    this.onErrorBound = this.onError.bind(this);
    this.onMessageErrorBound = this.onMessageError.bind(this);
    this.tryCreateWorker();
  }

  private tryCreateWorker() {
    if (typeof window === 'undefined' || typeof Worker === 'undefined') {
      this.mode = 'sync';
      return;
    }
    try {
      this.worker = new Worker(new URL('./crc32.worker.ts', import.meta.url), { type: 'module' });
      this.worker.addEventListener('message', this.onMessageBound);
      this.worker.addEventListener('error', this.onErrorBound);
      this.worker.addEventListener('messageerror', this.onMessageErrorBound);
      this.mode = 'worker';
    } catch {
      this.worker = null;
      this.mode = 'sync';
    }
  }

  private createTimeoutError(kind: 'reset' | 'finalize') {
    return new Error(`[${this.label}] CRC32 ${kind} timed out`);
  }

  private failAllPending(err: Error) {
    this.pendingWorkerChunks = [];
    this.pendingWorkerBytes = 0;
    this.pendingResets.forEach((pending) => {
      clearTimeout(pending.timeoutId);
      pending.reject(err);
    });
    this.pendingFinalizes.forEach((pending) => {
      clearTimeout(pending.timeoutId);
      pending.reject(err);
    });
    this.pendingResets.clear();
    this.pendingFinalizes.clear();
  }

  private onMessage(event: MessageEvent<Crc32WorkerResponse>) {
    const msg = event.data;
    if (msg.type === 'reset_ack') {
      const pending = this.pendingResets.get(msg.requestId);
      if (!pending) return;
      clearTimeout(pending.timeoutId);
      this.pendingResets.delete(msg.requestId);
      pending.resolve();
      return;
    }
    if (msg.type === 'finalize_result') {
      const pending = this.pendingFinalizes.get(msg.requestId);
      if (!pending) return;
      clearTimeout(pending.timeoutId);
      this.pendingFinalizes.delete(msg.requestId);
      pending.resolve(msg.hashHex);
      return;
    }
    if (msg.type === 'error') {
      const err = new Error(`[${this.label}] CRC32 worker error: ${msg.message}`);
      if (typeof msg.requestId === 'number') {
        const pendingReset = this.pendingResets.get(msg.requestId);
        if (pendingReset) {
          clearTimeout(pendingReset.timeoutId);
          this.pendingResets.delete(msg.requestId);
          pendingReset.reject(err);
          return;
        }
        const pendingFinalize = this.pendingFinalizes.get(msg.requestId);
        if (pendingFinalize) {
          clearTimeout(pendingFinalize.timeoutId);
          this.pendingFinalizes.delete(msg.requestId);
          pendingFinalize.reject(err);
          return;
        }
      }
      this.fatalError = err;
      this.failAllPending(err);
    }
  }

  private onError(event: ErrorEvent) {
    const err = new Error(`[${this.label}] CRC32 worker crashed: ${event.message || 'unknown error'}`);
    this.fatalError = err;
    this.failAllPending(err);
  }

  private onMessageError() {
    const err = new Error(`[${this.label}] CRC32 worker message error`);
    this.fatalError = err;
    this.failAllPending(err);
  }

  private ensureHealthy() {
    if (this.fatalError) throw this.fatalError;
  }

  private flushPendingWorkerUpdates() {
    if (this.mode !== 'worker' || !this.worker) return;
    if (this.pendingWorkerBytes <= 0 || this.pendingWorkerChunks.length === 0) return;
    this.ensureHealthy();

    const merged = new Uint8Array(this.pendingWorkerBytes);
    let offset = 0;
    for (const chunk of this.pendingWorkerChunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    this.pendingWorkerChunks = [];
    this.pendingWorkerBytes = 0;

    const buffer = merged.buffer;
    const msg: Crc32WorkerRequest = { type: 'update', buffer };
    this.worker.postMessage(msg, [buffer]);
  }

  async reset(): Promise<void> {
    if (this.mode === 'sync' || !this.worker) {
      this.syncState = crc32Init();
      return;
    }
    this.ensureHealthy();
    // Reset discards any unsent updates by definition.
    this.pendingWorkerChunks = [];
    this.pendingWorkerBytes = 0;

    const requestId = ++this.requestSeq;
    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingResets.delete(requestId);
        reject(this.createTimeoutError('reset'));
      }, 10000);
      this.pendingResets.set(requestId, { resolve, reject, timeoutId });
      const msg: Crc32WorkerRequest = { type: 'reset', requestId };
      this.worker!.postMessage(msg);
    });
  }

  update(data: Uint8Array): void {
    if (data.byteLength <= 0) return;
    if (this.mode === 'sync' || !this.worker) {
      this.syncState = crc32Update(this.syncState, data);
      return;
    }
    this.ensureHealthy();

    const copied = new Uint8Array(data.byteLength);
    copied.set(data);
    this.pendingWorkerChunks.push(copied);
    this.pendingWorkerBytes += copied.byteLength;

    if (this.pendingWorkerBytes >= Crc32WorkerHasher.WORKER_BATCH_BYTES) {
      this.flushPendingWorkerUpdates();
    }
  }

  async finalizeHex(): Promise<string> {
    if (this.mode === 'sync' || !this.worker) {
      return crc32FinalHex(this.syncState);
    }
    this.ensureHealthy();
    this.flushPendingWorkerUpdates();

    const requestId = ++this.requestSeq;
    return new Promise<string>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingFinalizes.delete(requestId);
        reject(this.createTimeoutError('finalize'));
      }, 10000);
      this.pendingFinalizes.set(requestId, { resolve, reject, timeoutId });
      const msg: Crc32WorkerRequest = { type: 'finalize', requestId };
      this.worker!.postMessage(msg);
    });
  }

  terminate(): void {
    if (this.worker) {
      this.worker.removeEventListener('message', this.onMessageBound);
      this.worker.removeEventListener('error', this.onErrorBound);
      this.worker.removeEventListener('messageerror', this.onMessageErrorBound);
      this.worker.terminate();
    }
    this.worker = null;
    this.mode = 'sync';
    this.syncState = crc32Init();
    this.pendingWorkerChunks = [];
    this.pendingWorkerBytes = 0;
    this.fatalError = new Error(`[${this.label}] CRC32 hasher terminated`);
    this.failAllPending(this.fatalError);
  }
}

export const createCrc32Hasher = (label: string): Crc32Hasher => {
  return new Crc32WorkerHasher(label);
};
