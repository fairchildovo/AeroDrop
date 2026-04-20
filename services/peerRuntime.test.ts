import assert from 'node:assert/strict';
import test from 'node:test';

class FakeDataChannel {
  public readyState: 'open' | 'closed' = 'open';
  public binaryType = 'arraybuffer';
  public onopen: (() => void) | null = null;
  public onclose: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;

  send(): void {}

  close(): void {
    if (this.readyState === 'closed') {
      return;
    }
    this.readyState = 'closed';
    this.onclose?.();
  }
}

class FakeRTCPeerConnection {
  public onicecandidate: ((event: { candidate: null }) => void) | null = null;
  public onconnectionstatechange: (() => void) | null = null;
  public oniceconnectionstatechange: (() => void) | null = null;
  public onicegatheringstatechange: (() => void) | null = null;
  public onsignalingstatechange: (() => void) | null = null;
  public ondatachannel: ((event: { channel: FakeDataChannel }) => void) | null = null;
  public connectionState: RTCPeerConnectionState = 'new';
  public iceConnectionState: RTCIceConnectionState = 'new';
  public iceGatheringState: RTCIceGatheringState = 'new';
  public signalingState: RTCSignalingState = 'stable';

  createDataChannel(): FakeDataChannel {
    return new FakeDataChannel();
  }

  createOffer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: 'offer', sdp: 'fake-offer' });
  }

  setLocalDescription(): Promise<void> {
    return Promise.resolve();
  }

  setRemoteDescription(): Promise<void> {
    return Promise.resolve();
  }

  addIceCandidate(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.connectionState = 'closed';
  }
}

class FakeWebSocket {
  public static instances: FakeWebSocket[] = [];
  public static OPEN = 1;
  public static CONNECTING = 0;
  public static CLOSED = 3;
  public readyState = FakeWebSocket.CONNECTING;
  public onopen: (() => void) | null = null;
  public onclose: ((event: { code: number; reason: string }) => void) | null = null;
  public onerror: (() => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(): void {}

  close(code = 1000, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

test('outgoing offers fail fast when signaling closes before registration', async () => {
  FakeWebSocket.instances.length = 0;

  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  const originalRtcPeerConnection = globalThis.RTCPeerConnection;

  (globalThis as typeof globalThis & { window: Window & typeof globalThis }).window = {
    location: {
      origin: 'http://127.0.0.1:3000',
      protocol: 'http:',
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  } as unknown as Window & typeof globalThis;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  globalThis.RTCPeerConnection = FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;

  try {
    const { default: WorkerSignaledPeer } = await import('./peerRuntime.ts');
    const peer = new WorkerSignaledPeer({ debug: 0 });
    const connection = peer.connect('target-peer');

    const connectionErrors: string[] = [];
    connection.on('error', (error) => {
      connectionErrors.push(error.type);
    });

    assert.equal(FakeWebSocket.instances.length, 1);
    FakeWebSocket.instances[0].close(1006, 'closed-before-registration');

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(connectionErrors, ['disconnected']);
    assert.equal(connection.open, false);

    peer.destroy();
  } finally {
    globalThis.window = originalWindow;
    globalThis.WebSocket = originalWebSocket;
    globalThis.RTCPeerConnection = originalRtcPeerConnection;
  }
});

test('pre-registration signaling failures stay handled even without pending offers', async () => {
  FakeWebSocket.instances.length = 0;

  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;
  const originalRtcPeerConnection = globalThis.RTCPeerConnection;
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };

  (globalThis as typeof globalThis & { window: Window & typeof globalThis }).window = {
    location: {
      origin: 'http://127.0.0.1:3000',
      protocol: 'http:',
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  } as unknown as Window & typeof globalThis;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  globalThis.RTCPeerConnection = FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    const { default: WorkerSignaledPeer } = await import('./peerRuntime.ts');
    const peer = new WorkerSignaledPeer({ debug: 0 });
    const peerErrors: string[] = [];
    peer.on('error', (error) => {
      peerErrors.push(error.type);
    });

    assert.equal(FakeWebSocket.instances.length, 1);
    FakeWebSocket.instances[0].close(1006, 'closed-before-registration');

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(peerErrors, ['disconnected']);
    assert.deepEqual(unhandledRejections, []);

    peer.destroy();
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    globalThis.window = originalWindow;
    globalThis.WebSocket = originalWebSocket;
    globalThis.RTCPeerConnection = originalRtcPeerConnection;
  }
});
