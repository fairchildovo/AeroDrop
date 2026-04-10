const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

const crc32Init = (): number => 0xffffffff;

const crc32Update = (state: number, data: Uint8Array): number => {
  let crc = state >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return crc >>> 0;
};

const crc32FinalHex = (state: number): string => {
  return ((state ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
};

type Crc32WorkerRequest =
  | { type: 'reset'; requestId: number }
  | { type: 'update'; buffer: ArrayBuffer }
  | { type: 'finalize'; requestId: number };

type Crc32WorkerResponse =
  | { type: 'reset_ack'; requestId: number }
  | { type: 'finalize_result'; requestId: number; hashHex: string }
  | { type: 'error'; requestId?: number; message: string };

let state = crc32Init();

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<Crc32WorkerRequest>) => void) | null;
  postMessage: (message: Crc32WorkerResponse) => void;
};

workerScope.onmessage = (event: MessageEvent<Crc32WorkerRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === 'reset') {
      state = crc32Init();
      const response: Crc32WorkerResponse = { type: 'reset_ack', requestId: msg.requestId };
      workerScope.postMessage(response);
      return;
    }

    if (msg.type === 'update') {
      if (msg.buffer.byteLength > 0) {
        state = crc32Update(state, new Uint8Array(msg.buffer));
      }
      return;
    }

    if (msg.type === 'finalize') {
      const response: Crc32WorkerResponse = {
        type: 'finalize_result',
        requestId: msg.requestId,
        hashHex: crc32FinalHex(state),
      };
      workerScope.postMessage(response);
    }
  } catch (err) {
    const response: Crc32WorkerResponse = {
      type: 'error',
      requestId: (msg as any)?.requestId,
      message: err instanceof Error ? err.message : 'CRC32 worker failed',
    };
    workerScope.postMessage(response);
  }
};

export {};
