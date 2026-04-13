import { io, type Socket } from 'socket.io-client';

type Listener = (...args: any[]) => void;

type PeerRuntimeErrorType =
  | 'unavailable-id'
  | 'invalid-id'
  | 'peer-unavailable'
  | 'disconnected'
  | 'network'
  | 'server-error'
  | 'socket-error'
  | 'webrtc-error';

type ChannelKind = 'data' | 'media';

type RegisterAck =
  | { ok: true; peerId: string }
  | { ok: false; code: PeerRuntimeErrorType | string };

type SignalAck =
  | { ok: true }
  | { ok: false; code: PeerRuntimeErrorType | string };

type SignalPayload = {
  connectionId: string;
  kind: ChannelKind;
  sourcePeerId: string;
  targetPeerId: string;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

type SocketSignalEvent = SignalPayload & {
  sourcePeerId: string;
  targetPeerId: string;
};

type PeerOptions = {
  debug?: number;
  pingInterval?: number;
  config?: RTCConfiguration;
  host?: string;
  port?: number;
  path?: string;
  secure?: boolean;
};

type DataConnectionOptions = {
  serialization?: 'binary' | 'json';
};

type PeerRuntimeModule = {
  default: typeof SocketSignaledPeer;
};

type PeerEvents = {
  open: (peerId: string) => void;
  connection: (connection: DataConnection) => void;
  call: (call: MediaConnection) => void;
  error: (error: PeerRuntimeError) => void;
  disconnected: () => void;
};

type DataConnectionEvents = {
  open: () => void;
  data: (data: any) => void;
  close: () => void;
  error: (error: PeerRuntimeError) => void;
};

type MediaConnectionEvents = {
  stream: (stream: MediaStream) => void;
  close: () => void;
  error: (error: PeerRuntimeError) => void;
};

const JSON_ENVELOPE = '__aerodrop_json__';
const TEXT_ENVELOPE = '__aerodrop_text__';
const DEFAULT_SIGNALING_URL = import.meta.env.DEV ? 'http://localhost:3001' : window.location.origin;
const SIGNALING_URL =
  (import.meta.env.VITE_SIGNALING_SERVER_URL as string | undefined)?.trim() ||
  (import.meta.env.VITE_SIGNALING_URL as string | undefined)?.trim() ||
  DEFAULT_SIGNALING_URL;
const SIGNALING_PATH =
  ((import.meta.env.VITE_SIGNALING_PATH as string | undefined)?.trim() || '/socket.io/').replace(/\/?$/, '/');

const createRuntimeError = (
  type: PeerRuntimeErrorType,
  message: string,
  cause?: unknown
): PeerRuntimeError => {
  const error = new Error(message) as PeerRuntimeError;
  error.type = type;
  if (cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = cause;
  }
  return error;
};

const createId = (prefix: string): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class TinyEmitter<EventMap extends Record<string, Listener>> {
  private listeners = new Map<keyof EventMap, Set<Listener>>();

  on<K extends keyof EventMap>(event: K, listener: EventMap[K]): this {
    const bucket = this.listeners.get(event) ?? new Set();
    bucket.add(listener as Listener);
    this.listeners.set(event, bucket);
    return this;
  }

  off<K extends keyof EventMap>(event: K, listener: EventMap[K]): this {
    this.listeners.get(event)?.delete(listener as Listener);
    return this;
  }

  emit<K extends keyof EventMap>(event: K, ...args: Parameters<EventMap[K]>): void {
    const bucket = this.listeners.get(event);
    if (!bucket) return;
    bucket.forEach((listener) => {
      try {
        (listener as EventMap[K])(...args);
      } catch (error) {
        console.error('peer runtime listener failed', error);
      }
    });
  }
}

class BaseConnection<EventMap extends Record<string, Listener>> extends TinyEmitter<EventMap> {
  public readonly peer: string;
  public readonly provider: SocketSignaledPeer;
  public readonly peerConnection: RTCPeerConnection;
  public readonly connectionId: string;
  public open = false;
  protected remoteDescriptionReady = false;
  protected closed = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];

  constructor(
    provider: SocketSignaledPeer,
    peerId: string,
    connectionId: string,
    peerConnection: RTCPeerConnection
  ) {
    super();
    this.provider = provider;
    this.peer = peerId;
    this.connectionId = connectionId;
    this.peerConnection = peerConnection;
    this.peerConnection.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.provider.forwardIceCandidate(this, event.candidate.toJSON());
    };
    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection.connectionState;
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        this.handleTransportClosed();
      }
    };
  }

  async applyRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.peerConnection.setRemoteDescription(description);
    this.remoteDescriptionReady = true;
    await this.flushPendingCandidates();
  }

  queueOrAddIceCandidate(candidate: RTCIceCandidateInit): void {
    if (this.closed) return;
    if (!this.remoteDescriptionReady) {
      this.pendingCandidates.push(candidate);
      return;
    }
    void this.peerConnection.addIceCandidate(candidate).catch((error) => {
      this.handleError(createRuntimeError('webrtc-error', 'Failed to add ICE candidate', error));
    });
  }

  protected async flushPendingCandidates(): Promise<void> {
    if (!this.remoteDescriptionReady || this.pendingCandidates.length === 0) {
      return;
    }
    const pending = [...this.pendingCandidates];
    this.pendingCandidates.length = 0;
    for (const candidate of pending) {
      try {
        await this.peerConnection.addIceCandidate(candidate);
      } catch (error) {
        this.handleError(createRuntimeError('webrtc-error', 'Failed to flush ICE candidate', error));
      }
    }
  }

  protected handleError(error: PeerRuntimeError): void {
    if (this.closed) return;
    (this.emit as any)('error', error);
  }

  protected markOpen(): void {
    if (this.closed || this.open) return;
    this.open = true;
  }

  protected handleTransportClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.provider.removeConnection(this);
    try {
      this.peerConnection.close();
    } catch {
      // Ignore close errors.
    }
  }

  close(): void {
    if (this.closed) return;
    this.handleTransportClosed();
  }
}

export class DataConnection extends BaseConnection<DataConnectionEvents> {
  public dataChannel: RTCDataChannel | null = null;

  bindDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;
    this.dataChannel.binaryType = 'arraybuffer';
    this.dataChannel.onopen = () => {
      this.markOpen();
      this.emit('open');
    };
    this.dataChannel.onclose = () => {
      this.handleTransportClosed();
      this.emit('close');
    };
    this.dataChannel.onerror = () => {
      this.handleError(createRuntimeError('webrtc-error', 'Data channel error'));
    };
    this.dataChannel.onmessage = async (event) => {
      const payload = event.data;
      if (typeof payload === 'string') {
        try {
          const decoded = JSON.parse(payload) as { __type?: string; payload?: unknown };
          if (decoded?.__type === JSON_ENVELOPE || decoded?.__type === TEXT_ENVELOPE) {
            this.emit('data', decoded.payload);
            return;
          }
        } catch {
          // Treat as plain text below.
        }
        this.emit('data', payload);
        return;
      }

      if (payload instanceof Blob) {
        const buffer = await payload.arrayBuffer();
        this.emit('data', buffer);
        return;
      }

      this.emit('data', payload);
    };
  }

  send(data: unknown): void {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw createRuntimeError('network', 'Data channel is not open');
    }

    if (data instanceof ArrayBuffer) {
      this.dataChannel.send(data);
      return;
    }
    if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      this.dataChannel.send(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
      return;
    }
    if (data instanceof Blob) {
      this.dataChannel.send(data);
      return;
    }
    if (typeof data === 'string') {
      this.dataChannel.send(JSON.stringify({ __type: TEXT_ENVELOPE, payload: data }));
      return;
    }

    this.dataChannel.send(JSON.stringify({ __type: JSON_ENVELOPE, payload: data }));
  }

  override close(): void {
    if (this.dataChannel && this.dataChannel.readyState !== 'closed') {
      try {
        this.dataChannel.close();
      } catch {
        // Ignore close errors.
      }
    }
    const wasClosed = this.closed;
    super.close();
    if (!wasClosed) {
      this.emit('close');
    }
  }
}

export class MediaConnection extends BaseConnection<MediaConnectionEvents> {
  private remoteStream = new MediaStream();
  private answered = false;

  constructor(
    provider: SocketSignaledPeer,
    peerId: string,
    connectionId: string,
    peerConnection: RTCPeerConnection
  ) {
    super(provider, peerId, connectionId, peerConnection);
    this.peerConnection.ontrack = (event) => {
      event.streams.forEach((stream) => {
        stream.getTracks().forEach((track) => {
          if (!this.remoteStream.getTracks().some((existing) => existing.id === track.id)) {
            this.remoteStream.addTrack(track);
          }
        });
      });
      if (event.track && !this.remoteStream.getTracks().some((existing) => existing.id === event.track.id)) {
        this.remoteStream.addTrack(event.track);
      }
      this.markOpen();
      this.emit('stream', this.remoteStream);
    };
    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection.connectionState;
      if (state === 'connected' && !this.open) {
        this.markOpen();
      }
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        this.handleTransportClosed();
        this.emit('close');
      }
    };
  }

  async answer(stream: MediaStream): Promise<void> {
    if (this.answered || this.closed) return;
    this.answered = true;
    stream.getTracks().forEach((track) => {
      this.peerConnection.addTrack(track, stream);
    });
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);
    await this.provider.forwardAnswer(this, answer);
  }

  override close(): void {
    const wasClosed = this.closed;
    super.close();
    if (!wasClosed) {
      this.emit('close');
    }
  }
}

export type PeerRuntimeError = Error & {
  type: PeerRuntimeErrorType;
};

export default class SocketSignaledPeer extends TinyEmitter<PeerEvents> {
  public id: string;
  public destroyed = false;
  public disconnected = false;
  public readonly connections: Record<string, Array<DataConnection | MediaConnection>> = {};
  private readonly config: RTCConfiguration;
  private readonly socket: Socket;
  private readonly options: PeerOptions;
  private readonly connectionIndex = new Map<string, DataConnection | MediaConnection>();
  private openedOnce = false;
  private readyPromiseResolve: (() => void) | null = null;
  private readyPromise: Promise<void>;
  private socketConnectFailed = false;

  constructor(id?: string, options?: PeerOptions);
  constructor(options?: PeerOptions);
  constructor(idOrOptions?: string | PeerOptions, maybeOptions?: PeerOptions) {
    super();
    const suppliedId = typeof idOrOptions === 'string' ? idOrOptions : createId('peer');
    this.options = (typeof idOrOptions === 'string' ? maybeOptions : idOrOptions) ?? {};
    this.id = suppliedId;
    this.config = this.options.config ?? {};
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyPromiseResolve = resolve;
    });
    this.socket = io(SIGNALING_URL, {
      path: SIGNALING_PATH,
      transports: ['websocket', 'polling'],
      autoConnect: true,
      reconnection: true,
    });
    this.bindSocketEvents();
  }

  private bindSocketEvents(): void {
    this.socket.on('connect', () => {
      this.disconnected = false;
      this.socketConnectFailed = false;
      void this.registerPeer();
    });

    this.socket.on('disconnect', () => {
      if (this.destroyed) return;
      this.disconnected = true;
      this.emit('disconnected');
    });

    this.socket.on('connect_error', (error) => {
      if (this.destroyed) return;
      this.socketConnectFailed = true;
      this.emit('error', createRuntimeError('socket-error', 'Signaling socket connection failed', error));
    });

    this.socket.on('webrtc:offer', (payload: SocketSignalEvent) => {
      void this.handleIncomingOffer(payload);
    });

    this.socket.on('webrtc:answer', (payload: SocketSignalEvent) => {
      void this.handleIncomingAnswer(payload);
    });

    this.socket.on('webrtc:ice-candidate', (payload: SocketSignalEvent) => {
      this.handleIncomingIceCandidate(payload);
    });

    this.socket.on('webrtc:peer-unavailable', (payload: SocketSignalEvent) => {
      const error = createRuntimeError(
        'peer-unavailable',
        `Target peer is unavailable: ${payload.targetPeerId || payload.sourcePeerId}`
      );
      this.emit('error', error);
      const connection = this.connectionIndex.get(payload.connectionId);
      if (connection) {
        this.emitConnectionError(connection, error);
        connection.close();
      }
    });
  }

  private async registerPeer(): Promise<void> {
    if (this.destroyed) return;
    const result = await this.emitWithAck<RegisterAck>('peer:register', { peerId: this.id });
    if (!result?.ok) {
      this.emit('error', createRuntimeError((result?.code as PeerRuntimeErrorType) ?? 'server-error', 'Failed to register peer id'));
      return;
    }
    this.id = result.peerId;
    if (!this.openedOnce) {
      this.openedOnce = true;
      this.readyPromiseResolve?.();
      this.readyPromiseResolve = null;
      this.emit('open', this.id);
    }
  }

  private async handleIncomingOffer(payload: SocketSignalEvent): Promise<void> {
    if (this.destroyed) return;
    if (payload.kind === 'data') {
      const peerConnection = new RTCPeerConnection(this.config);
      const connection = new DataConnection(this, payload.sourcePeerId, payload.connectionId, peerConnection);
      peerConnection.ondatachannel = (event) => {
        connection.bindDataChannel(event.channel);
      };
      this.addConnection(connection);
      this.emit('connection', connection);
      try {
        await connection.applyRemoteDescription(payload.description!);
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        await this.forwardAnswer(connection, answer);
      } catch (error) {
        this.emitConnectionError(connection, createRuntimeError('webrtc-error', 'Failed to handle incoming data offer', error));
        connection.close();
      }
      return;
    }

    const peerConnection = new RTCPeerConnection(this.config);
    const call = new MediaConnection(this, payload.sourcePeerId, payload.connectionId, peerConnection);
    this.addConnection(call);
    try {
      await call.applyRemoteDescription(payload.description!);
      this.emit('call', call);
    } catch (error) {
      this.emitConnectionError(call, createRuntimeError('webrtc-error', 'Failed to handle incoming media offer', error));
      call.close();
    }
  }

  private async handleIncomingAnswer(payload: SocketSignalEvent): Promise<void> {
    const connection = this.connectionIndex.get(payload.connectionId);
    if (!connection || !payload.description) return;
    try {
      await connection.applyRemoteDescription(payload.description);
    } catch (error) {
      this.emitConnectionError(connection, createRuntimeError('webrtc-error', 'Failed to apply remote answer', error));
      connection.close();
    }
  }

  private handleIncomingIceCandidate(payload: SocketSignalEvent): void {
    const connection = this.connectionIndex.get(payload.connectionId);
    if (!connection || !payload.candidate) return;
    connection.queueOrAddIceCandidate(payload.candidate);
  }

  private addConnection(connection: DataConnection | MediaConnection): void {
    this.connectionIndex.set(connection.connectionId, connection);
    const bucket = this.connections[connection.peer] ?? [];
    bucket.push(connection);
    this.connections[connection.peer] = bucket;
  }

  removeConnection(connection: BaseConnection<any>): void {
    this.connectionIndex.delete(connection.connectionId);
    const bucket = this.connections[connection.peer];
    if (!bucket) return;
    this.connections[connection.peer] = bucket.filter((item) => item !== connection);
    if (this.connections[connection.peer].length === 0) {
      delete this.connections[connection.peer];
    }
  }

  private emitConnectionError(connection: DataConnection | MediaConnection, error: PeerRuntimeError): void {
    if (connection instanceof DataConnection) {
      connection.emit('error', error);
      return;
    }
    connection.emit('error', error);
  }

  private async ensureReady(): Promise<void> {
    if (this.openedOnce) return;
    if (this.socketConnectFailed) {
      throw createRuntimeError('socket-error', 'Signaling socket is not connected');
    }
    await this.readyPromise;
  }

  private async emitWithAck<T>(eventName: string, payload: unknown, timeoutMs = 5000): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
      let settled = false;
      const timeoutId = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, timeoutMs);
      this.socket.emit(eventName, payload, (response: T) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        resolve(response);
      });
    });
  }

  async forwardAnswer(connection: BaseConnection<any>, description: RTCSessionDescriptionInit): Promise<void> {
    await this.emitWithAck<SignalAck>('webrtc:answer', {
      connectionId: connection.connectionId,
      kind: connection instanceof DataConnection ? 'data' : 'media',
      sourcePeerId: this.id,
      targetPeerId: connection.peer,
      description,
    });
  }

  forwardIceCandidate(connection: BaseConnection<any>, candidate: RTCIceCandidateInit): void {
    void this.emitWithAck<SignalAck>('webrtc:ice-candidate', {
      connectionId: connection.connectionId,
      kind: connection instanceof DataConnection ? 'data' : 'media',
      sourcePeerId: this.id,
      targetPeerId: connection.peer,
      candidate,
    });
  }

  connect(targetPeerId: string, _options?: DataConnectionOptions): DataConnection {
    const peerConnection = new RTCPeerConnection(this.config);
    const connection = new DataConnection(this, targetPeerId, createId('data'), peerConnection);
    const channel = peerConnection.createDataChannel('data', {
      ordered: true,
    });
    connection.bindDataChannel(channel);
    this.addConnection(connection);
    void this.startOutgoingOffer(connection, 'data');
    return connection;
  }

  call(targetPeerId: string, stream: MediaStream): MediaConnection {
    const peerConnection = new RTCPeerConnection(this.config);
    const call = new MediaConnection(this, targetPeerId, createId('media'), peerConnection);
    stream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, stream);
    });
    this.addConnection(call);
    void this.startOutgoingOffer(call, 'media');
    return call;
  }

  private async startOutgoingOffer(connection: DataConnection | MediaConnection, kind: ChannelKind): Promise<void> {
    try {
      await this.ensureReady();
      const offer = await connection.peerConnection.createOffer();
      await connection.peerConnection.setLocalDescription(offer);
      const result = await this.emitWithAck<SignalAck>('webrtc:offer', {
        connectionId: connection.connectionId,
        kind,
        sourcePeerId: this.id,
        targetPeerId: connection.peer,
        description: offer,
      });

      if (!result?.ok) {
        const errorType = (result?.code as PeerRuntimeErrorType) ?? 'peer-unavailable';
        const error = createRuntimeError(errorType, `Failed to reach peer ${connection.peer}`);
        this.emit('error', error);
        this.emitConnectionError(connection, error);
        connection.close();
      }
    } catch (error) {
      const runtimeError =
        error instanceof Error && 'type' in error
          ? (error as PeerRuntimeError)
          : createRuntimeError('webrtc-error', 'Failed to start WebRTC offer', error);
      this.emit('error', runtimeError);
      this.emitConnectionError(connection, runtimeError);
      connection.close();
    }
  }

  reconnect(): void {
    if (this.destroyed) return;
    if (this.socket.connected) {
      void this.registerPeer();
      return;
    }
    this.socket.connect();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    Object.values(this.connections).flat().forEach((connection) => connection.close());
    this.socket.removeAllListeners();
    this.socket.disconnect();
  }
}

export type Peer = SocketSignaledPeer;

let peerRuntimePromise: Promise<PeerRuntimeModule> | null = null;

export const loadPeerRuntime = (): Promise<PeerRuntimeModule> => {
  if (!peerRuntimePromise) {
    peerRuntimePromise = Promise.resolve({
      default: SocketSignaledPeer,
    });
  }
  return peerRuntimePromise;
};

export const preloadPeerRuntime = (): void => {
  void loadPeerRuntime();
};

export type { PeerOptions, DataConnectionOptions };
