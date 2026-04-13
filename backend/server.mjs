import http from 'node:http';
import process from 'node:process';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';

const app = express();

const SIGNALING_PORT = Number.parseInt(process.env.SIGNALING_PORT ?? '3001', 10);
const SIGNALING_HOST = process.env.SIGNALING_HOST ?? '0.0.0.0';
const SIGNALING_ALLOWED_ORIGINS = (process.env.SIGNALING_ALLOWED_ORIGINS ?? '*')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const httpServer = http.createServer(app);

const io = new SocketIOServer(httpServer, {
  path: '/socket.io/',
  cors: {
    origin: SIGNALING_ALLOWED_ORIGINS.includes('*') ? true : SIGNALING_ALLOWED_ORIGINS,
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

const peerToSocket = new Map();
const socketToPeer = new Map();

const log = (...args) => {
  console.log('[signaling]', ...args);
};

const unregisterSocket = (socketId) => {
  const peerId = socketToPeer.get(socketId);
  if (!peerId) return;

  socketToPeer.delete(socketId);
  if (peerToSocket.get(peerId) === socketId) {
    peerToSocket.delete(peerId);
  }
};

const resolveTargetSocketId = (targetPeerId) => {
  if (!targetPeerId) return null;
  return peerToSocket.get(targetPeerId) ?? null;
};

const forwardSignal = (socket, eventName, payload, ack) => {
  const targetSocketId = resolveTargetSocketId(payload?.targetPeerId);
  if (!targetSocketId) {
    ack?.({ ok: false, code: 'peer-unavailable' });
    socket.emit('webrtc:peer-unavailable', {
      targetPeerId: payload?.targetPeerId ?? '',
      connectionId: payload?.connectionId ?? '',
      kind: payload?.kind ?? 'data',
    });
    return;
  }

  io.to(targetSocketId).emit(eventName, {
    ...payload,
    sourcePeerId: socketToPeer.get(socket.id) ?? payload?.sourcePeerId ?? '',
  });
  ack?.({ ok: true });
};

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    peers: peerToSocket.size,
    timestamp: Date.now(),
  });
});

io.on('connection', (socket) => {
  log('socket connected', socket.id);

  socket.on('peer:register', ({ peerId } = {}, ack) => {
    const normalizedPeerId = typeof peerId === 'string' ? peerId.trim() : '';
    if (!normalizedPeerId) {
      ack?.({ ok: false, code: 'invalid-id' });
      return;
    }

    const existingSocketId = peerToSocket.get(normalizedPeerId);
    if (existingSocketId && existingSocketId !== socket.id) {
      ack?.({ ok: false, code: 'unavailable-id' });
      return;
    }

    unregisterSocket(socket.id);
    peerToSocket.set(normalizedPeerId, socket.id);
    socketToPeer.set(socket.id, normalizedPeerId);
    ack?.({ ok: true, peerId: normalizedPeerId });
    log('peer registered', normalizedPeerId);
  });

  socket.on('webrtc:offer', (payload, ack) => {
    forwardSignal(socket, 'webrtc:offer', payload, ack);
  });

  socket.on('webrtc:answer', (payload, ack) => {
    forwardSignal(socket, 'webrtc:answer', payload, ack);
  });

  socket.on('webrtc:ice-candidate', (payload, ack) => {
    forwardSignal(socket, 'webrtc:ice-candidate', payload, ack);
  });

  socket.on('disconnect', (reason) => {
    const peerId = socketToPeer.get(socket.id);
    unregisterSocket(socket.id);
    log('socket disconnected', socket.id, peerId ?? '', reason);
  });
});

httpServer.listen(SIGNALING_PORT, SIGNALING_HOST, () => {
  log(`listening on http://${SIGNALING_HOST}:${SIGNALING_PORT}`);
});
