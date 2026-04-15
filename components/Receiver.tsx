import React, { useState, useEffect, useRef } from 'react';

import streamSaver from 'streamsaver';
streamSaver.mitm = '/mitm.html';
import {
  TransferState,
  FileMetadata,
  P2PMessage,
  P2P_PROTOCOL_VERSION,
  type RouteAttemptKind,
} from '../types';
import { formatFileSize } from '../services/fileUtils';
import { createCrc32Hasher, Crc32Hasher } from '../services/crc32WorkerClient';
import { loadPeerRuntime, type Peer, type DataConnection } from '../services/peerRuntime';
import { createHappyEyeballsPlan } from '../services/connectionPolicy';
import {
  getReceiverDisconnectedMessage,
  getReceiverPreTransferFailureMessage,
  NO_TURN_WARNING_MESSAGE,
} from '../services/connectionGuidance';
import { getIceConfig } from '../services/stunService';
import { TRANSFER_CONFIG } from '../constants/transfer';
import {
  attachIceRouteToSession,
  collectIceRouteWithRetry,
  ConnectionSession,
  createConnectionSession,
  markConnectionFailure,
  markConnectionRetry,
  markConnectionSuccess,
  markIceConfigFetched,
  markSignalingOpen,
  markSessionEvent,
  startConnectionAttempt,
} from '../services/connectionTelemetry';
import { getBrowserNetworkProfile } from '../services/networkProfile';
import { createReceivePersistenceAdapter, type ReceivePersistenceAdapter } from '../services/receive/persistenceAdapter';
import { createReceiveRecoveryCoordinator, type ReceiveRecoveryCoordinator } from '../services/receive/recoveryCoordinator';
import { createReceivePersistenceOrchestrator, type ReceivePersistenceOrchestrator } from '../services/receive/persistenceOrchestrator';
import { createReceiveRouteArbiter } from '../services/receive/routeArbiter';
import { createReceiveSessionCoordinator, type ReceiveSessionCoordinator } from '../services/receive/sessionCoordinator';
import {
  createReceiveStreamingWriter,
  type ReceiveStreamingTarget,
  type ReceiveStreamingWriter,
} from '../services/receive/streamingWriter';
import { getRouteSelectionTimings } from '../services/routeSelectionPolicy';
import { useTransferStore } from '../stores/transferStore';
import { createReceiverSessionService } from '../services/receiverSessionService';
import { ReceiverConnectingStage, ReceiverUI } from './receiver/ReceiverUI';

const sanitizeFileName = (name: string): string => {
  const basename = name.replace(/\\/g, '/').split('/').pop() || `file_${Date.now()}`;
  const cleaned = basename.replace(/[\x00-\x1f]/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    return `file_${Date.now()}`;
  }
  return cleaned;
};

interface ReceiverProps {
  initialCode?: string;
  onNotification?: (msg: string, type: 'success' | 'info' | 'error') => void;
  deviceName: string;
}

type RouteAttemptRecord = {
  attemptId: string;
  attemptKind: RouteAttemptKind;
  conn: DataConnection;
};

export const Receiver: React.FC<ReceiverProps> = ({ initialCode, onNotification, deviceName }) => {
  const setReceiverSnapshot = useTransferStore((store) => store.setReceiverSnapshot);
  const resetReceiverSnapshot = useTransferStore((store) => store.resetReceiverSnapshot);
  const INITIAL_TIMEOUT_MS = 15000;
  const RELAY_TIMEOUT_MS = 25000;
  const RELAY_PARALLEL_DELAY_MS = 1200;
  const P2P_BACKFILL_DELAY_MS = 2200;
  const STREAMSAVER_PATH_PREFIX = '/__aerodrop_streamsaver__/';
  const FAST_RETRY_BASE_MS = 700;
  const FAST_RETRY_MAX_MS = 5000;
  const MAX_CONNECT_RETRY = 6;
  const MAX_AUTO_REPAIR_RETRIES_PER_FILE = 2;
  const IOS_MEMORY_WARN_BYTES = 500 * 1024 * 1024;
  const IOS_IDB_BUFFER_THRESHOLD_BYTES = 500 * 1024 * 1024;
  const IOS_IDB_DB_NAME = 'aerodrop-receiver-buffer-v1';
  const IOS_IDB_STORE = 'fileChunks';
  const IOS_IDB_STALE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
  const IOS_IDB_PRUNE_LOCK_KEY = 'aerodrop_idb_prune_lock_v1';
  const IOS_IDB_PRUNE_LOCK_TTL_MS = 45 * 1000;

  const RECEIVER_SESSION_KEY = 'aerodrop_receiver_session_id';
  const getReceiverSessionId = (): string => {
    try {
      const existing = sessionStorage.getItem(RECEIVER_SESSION_KEY);
      if (existing) return existing;
      const generated = `rcv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem(RECEIVER_SESSION_KEY, generated);
      return generated;
    } catch {
      return `rcv-fallback-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
  };

  const [state, _setState] = useState<TransferState>(TransferState.IDLE);
  const setState = (newState: TransferState) => {
    stateRef.current = newState;
    _setState(newState);
  };
  const [code, setCode] = useState<string>('');
  const [metadata, setMetadata] = useState<FileMetadata | null>(null);
  const [progress, setProgress] = useState<number>(0);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [canResume, setCanResume] = useState(false);
  
  const [currentFileName, setCurrentFileName] = useState<string>('');
  const [currentFileIndex, setCurrentFileIndex] = useState<number>(0);
  const [totalFiles, setTotalFiles] = useState<number>(0);

  const [downloadSpeed, setDownloadSpeed] = useState<string>('0 KB/s');
  const [downloadSpeedBytes, setDownloadSpeedBytes] = useState(0);
  const [eta, setEta] = useState<string>('--');
  const [senderDeviceName, setSenderDeviceName] = useState<string>('');
  const [connectingStage, setConnectingStage] = useState<ReceiverConnectingStage>('');

  const peerRef = useRef<Peer | null>(null);
  const connRef = useRef<DataConnection | null>(null);
  const retryCountRef = useRef<number>(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);
  const stateRef = useRef<TransferState>(TransferState.IDLE);
  const peerDebugLevel = import.meta.env.DEV ? 1 : 0;
  const localDeviceNameRef = useRef<string>(deviceName);
  const receiverSessionIdRef = useRef<string>(getReceiverSessionId());
  const connectTelemetryRef = useRef<ConnectionSession | null>(null);
  const hasTurnRef = useRef(false);
  const preferredIcePolicyRef = useRef<RTCIceTransportPolicy>('all');
  const relayPeerRef = useRef<Peer | null>(null);
  const relayConnRef = useRef<DataConnection | null>(null);
  const happyEyeballsWonRef = useRef(false);
  const p2pTimeoutRetryCountRef = useRef(0);
  const connectionRouteLogSignatureRef = useRef('');
  const routeAttemptCounterRef = useRef(0);
  const routeAttemptsRef = useRef<Map<string, RouteAttemptRecord>>(new Map());
  const pendingRouteMessagesRef = useRef<Map<string, P2PMessage[]>>(new Map());
  const latestRouteAttemptIdsRef = useRef<Record<RouteAttemptKind, string | null>>({
    all: null,
    relay: null,
  });
  const receiveRouteArbiterRef = useRef<ReturnType<typeof createReceiveRouteArbiter> | null>(null);

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const isMobileDevice = /android|iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const metadataRef = useRef<FileMetadata | null>(null);
  const currentFileIndexRef = useRef<number>(0); 
  const currentFileNameRef = useRef<string>('');
  const completedFileIndicesRef = useRef<Set<number>>(new Set());
  const isTransferActiveRef = useRef<boolean>(false);

  const chunksRef = useRef<ArrayBuffer[]>([]);
  const receivedChunksCountRef = useRef<number>(0);
  const receivedSizeRef = useRef<number>(0);
  const currentFileSizeRef = useRef<number>(0);
  const fileHasherRef = useRef<Crc32Hasher | null>(null);
  const hashedBytesRef = useRef<number>(0);
  
  const isStreamingRef = useRef<boolean>(false);
  const nativeFileHandleRef = useRef<FileSystemFileHandle | null>(null);
  const preparedNativeWriterFileIndexRef = useRef<number | null>(null);

  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const BUFFER_FLUSH_THRESHOLD = TRANSFER_CONFIG.WRITE_BUFFER_FLUSH_THRESHOLD;
  const isIndexedDbBufferingRef = useRef<boolean>(false);
  const indexedDbOpenPromiseRef = useRef<Promise<IDBDatabase> | null>(null);
  const indexedDbBatchRef = useRef<ArrayBuffer[]>([]);
  const indexedDbBatchBytesRef = useRef<number>(0);
  const indexedDbChunkSeqRef = useRef<number>(0);
  const indexedDbBufferedBytesRef = useRef<number>(0);
  const indexedDbBufferedFileIndexRef = useRef<number | null>(null);
  const indexedDbNotifiedRef = useRef<boolean>(false);
  const indexedDbCleanupStartedRef = useRef<boolean>(false);
  const indexedDbCleanupLockIdRef = useRef<string>(
    `idb-prune-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );

  const lastSpeedUpdateRef = useRef<number>(0);
  const lastSpeedBytesRef = useRef<number>(0);
  const lastReportedSpeedBytesRef = useRef<number>(0);
  const receivePersistenceAdapterRef = useRef<ReceivePersistenceAdapter | null>(null);
  const receiveRecoveryCoordinatorRef = useRef<ReceiveRecoveryCoordinator | null>(null);
  const receivePersistenceOrchestratorRef = useRef<ReceivePersistenceOrchestrator | null>(null);
  const receiveSessionCoordinatorRef = useRef<ReceiveSessionCoordinator | null>(null);
  const receiveStreamingWriterRef = useRef<ReceiveStreamingWriter | null>(null);

  if (!receiveStreamingWriterRef.current) {
    receiveStreamingWriterRef.current = createReceiveStreamingWriter({
      flushThresholdBytes: BUFFER_FLUSH_THRESHOLD,
    });
  }
  const receiveStreamingWriter = receiveStreamingWriterRef.current;

  const codeRef = useRef<string>('');
  const isMountedRef = useRef(true);
  useEffect(() => { codeRef.current = code; }, [code]);
  useEffect(() => { localDeviceNameRef.current = deviceName; }, [deviceName]);

  useEffect(() => { if (initialCode) setCode(initialCode); }, [initialCode]);

  const clearConnectionTimeout = () => {
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
  };

  const clearHeartbeatTimer = () => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  };

  const getNextRouteAttemptId = (attemptKind: RouteAttemptKind) => {
    routeAttemptCounterRef.current += 1;
    return `${attemptKind}-${Date.now().toString(36)}-${routeAttemptCounterRef.current.toString(36)}`;
  };

  const registerRouteAttempt = (record: RouteAttemptRecord) => {
    routeAttemptsRef.current.set(record.attemptId, record);
    pendingRouteMessagesRef.current.set(record.attemptId, []);
    latestRouteAttemptIdsRef.current = {
      ...latestRouteAttemptIdsRef.current,
      [record.attemptKind]: record.attemptId,
    };
  };

  const unregisterRouteAttempt = (attemptId: string) => {
    const existing = routeAttemptsRef.current.get(attemptId);
    if (!existing) {
      return;
    }

    routeAttemptsRef.current.delete(attemptId);

    if (latestRouteAttemptIdsRef.current[existing.attemptKind] === attemptId) {
      const latestForKind = Array.from(routeAttemptsRef.current.values())
        .reverse()
        .find((record) => record.attemptKind === existing.attemptKind)?.attemptId ?? null;

      latestRouteAttemptIdsRef.current = {
        ...latestRouteAttemptIdsRef.current,
        [existing.attemptKind]: latestForKind,
      };
    }

    if (relayConnRef.current === existing.conn) {
      relayConnRef.current = null;
    }

    pendingRouteMessagesRef.current.delete(attemptId);
  };

  const bufferRouteMessage = (attemptId: string, msg: P2PMessage) => {
    const existing = pendingRouteMessagesRef.current.get(attemptId) ?? [];
    pendingRouteMessagesRef.current.set(attemptId, [...existing, msg]);
  };

  const takePendingRouteMessages = (attemptId: string) => {
    const queued = pendingRouteMessagesRef.current.get(attemptId) ?? [];
    pendingRouteMessagesRef.current.delete(attemptId);
    return queued;
  };

  const closeRouteAttempt = (
    attemptId: string,
    reason: 'session_closed' | 'winner_selected'
  ) => {
    const existing = routeAttemptsRef.current.get(attemptId);
    if (!existing) {
      return;
    }

    if (existing.conn.open) {
      try {
        existing.conn.send({
          type: 'ROUTE_ABORT',
          payload: {
            receiverSessionId: receiverSessionIdRef.current,
            attemptId,
            reason,
          },
        });
      } catch {
        // Best-effort abort signal before closing the losing route.
      }
    }

    try {
      existing.conn.close();
    } catch {
      // Ignore close errors while tearing down non-winning attempts.
    }

    unregisterRouteAttempt(attemptId);
  };

  const closeNonWinningRouteAttempts = (winnerAttemptId: string) => {
    const losingAttemptIds = Array.from(routeAttemptsRef.current.keys()).filter(
      (attemptId) => attemptId !== winnerAttemptId
    );

    for (const losingAttemptId of losingAttemptIds) {
      closeRouteAttempt(losingAttemptId, 'winner_selected');
    }
  };

  const resetRouteAttemptState = () => {
    const activeAttemptIds = Array.from(routeAttemptsRef.current.keys());
    for (const attemptId of activeAttemptIds) {
      closeRouteAttempt(attemptId, 'session_closed');
    }
    routeAttemptsRef.current.clear();
    pendingRouteMessagesRef.current.clear();
    latestRouteAttemptIdsRef.current = {
      all: null,
      relay: null,
    };
    receiveRouteArbiterRef.current = null;
  };

  const startWinnerHeartbeat = (conn: DataConnection) => {
    clearHeartbeatTimer();
    heartbeatTimerRef.current = window.setInterval(() => {
      if (!conn.open) return;
      try {
        conn.send({ type: 'HEARTBEAT', payload: { t: Date.now() } });
      } catch {
        // Ignore heartbeat failures; close/error path handles reconnect.
      }
    }, 2500);
  };

  const collectSelectedRoute = (conn: DataConnection) => {
    const pc = conn.peerConnection;
    if (!pc) {
      return;
    }

    collectIceRouteWithRetry(pc).then((route) => {
      attachIceRouteToSession(connectTelemetryRef.current, route);
      if (!route) return;
      const routeSignature = [
        route.protocol || '',
        route.localCandidateType || '',
        route.remoteCandidateType || '',
        route.localUrl || '',
        route.remoteUrl || '',
        route.relayProtocol || '',
        route.pathType || '',
      ].join('|');
      if (connectionRouteLogSignatureRef.current !== routeSignature) {
        connectionRouteLogSignatureRef.current = routeSignature;
        const turnUrl = route.localUrl?.startsWith('turn')
          ? route.localUrl
          : route.remoteUrl?.startsWith('turn')
            ? route.remoteUrl
            : '';
        console.info('[ice-route:selected]', {
          role: 'receiver',
          peerId: conn.peer,
          protocol: route.protocol,
          localCandidateType: route.localCandidateType,
          remoteCandidateType: route.remoteCandidateType,
          localNetworkType: route.localNetworkType,
          remoteNetworkType: route.remoteNetworkType,
          relayProtocol: route.relayProtocol,
          turnUrlType: turnUrl ? (turnUrl.startsWith('turns:') ? 'turns' : 'turn') : 'none',
          turnUrl: turnUrl || undefined,
          pathType: route.pathType,
          rttMs: route.rttMs,
        });
      }
    });
  };

  const handleConnectRef = useRef<() => void>(() => {});
  useEffect(() => {
    handleConnectRef.current = handleConnect;
  });

  useEffect(() => {
    if (code.length === 4 && state === TransferState.IDLE) {
      handleConnectRef.current();
    }
  }, [code, state]);


  useEffect(() => {
    isMountedRef.current = true;
    pruneStaleIndexedDbSessions().catch(() => {});
    return () => {
      isMountedRef.current = false;
      clearConnectionTimeout();
      clearHeartbeatTimer();
      resetRouteAttemptState();
      if (connRef.current) connRef.current.close();
      if (peerRef.current) peerRef.current.destroy();
      if (relayPeerRef.current) { try { relayPeerRef.current.destroy(); } catch {} }
      deleteIndexedDbChunksForSession().catch(() => {});
      abortStreams();
      fileHasherRef.current?.terminate();
      fileHasherRef.current = null;
    };
  }, []);

  const getFileHasher = (): Crc32Hasher => {
    if (!fileHasherRef.current) {
      fileHasherRef.current = createCrc32Hasher('receiver');
    }
    return fileHasherRef.current;
  };

  const isIndexedDbSupported = () => typeof window !== 'undefined' && 'indexedDB' in window;

  const resetIndexedDbBufferRuntime = () => {
    indexedDbBatchRef.current = [];
    indexedDbBatchBytesRef.current = 0;
  };

  const resetIndexedDbFileState = () => {
    isIndexedDbBufferingRef.current = false;
    indexedDbChunkSeqRef.current = 0;
    indexedDbBufferedBytesRef.current = 0;
    indexedDbBufferedFileIndexRef.current = null;
    resetIndexedDbBufferRuntime();
  };

  const openIndexedDb = async (): Promise<IDBDatabase> => {
    if (!isIndexedDbSupported()) {
      throw new Error('INDEXED_DB_UNSUPPORTED');
    }
    if (!indexedDbOpenPromiseRef.current) {
      indexedDbOpenPromiseRef.current = new Promise<IDBDatabase>((resolve, reject) => {
        const request = window.indexedDB.open(IOS_IDB_DB_NAME, 1);
        request.onerror = () => reject(request.error || new Error('INDEXED_DB_OPEN_FAILED'));
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(IOS_IDB_STORE)) {
            const store = db.createObjectStore(IOS_IDB_STORE, { keyPath: ['sessionId', 'fileIndex', 'seq'] });
            store.createIndex('bySessionFile', ['sessionId', 'fileIndex'], { unique: false });
          }
        };
        request.onsuccess = () => resolve(request.result);
      });
    }
    return indexedDbOpenPromiseRef.current;
  };

  const acquireIndexedDbPruneLock = (): boolean => {
    try {
      const now = Date.now();
      const owner = indexedDbCleanupLockIdRef.current;
      const currentRaw = window.localStorage.getItem(IOS_IDB_PRUNE_LOCK_KEY);
      if (currentRaw) {
        const current = JSON.parse(currentRaw) as { owner?: string; expiresAt?: number };
        const currentOwner = typeof current?.owner === 'string' ? current.owner : '';
        const expiresAt = typeof current?.expiresAt === 'number' ? current.expiresAt : 0;
        if (currentOwner && currentOwner !== owner && expiresAt > now) {
          return false;
        }
      }

      const next = { owner, expiresAt: now + IOS_IDB_PRUNE_LOCK_TTL_MS };
      window.localStorage.setItem(IOS_IDB_PRUNE_LOCK_KEY, JSON.stringify(next));
      const confirmRaw = window.localStorage.getItem(IOS_IDB_PRUNE_LOCK_KEY);
      if (!confirmRaw) return false;
      const confirm = JSON.parse(confirmRaw) as { owner?: string };
      return confirm.owner === owner;
    } catch {
      // If localStorage is unavailable (privacy mode), fall back to single-tab guard.
      return true;
    }
  };

  const releaseIndexedDbPruneLock = () => {
    try {
      const owner = indexedDbCleanupLockIdRef.current;
      const currentRaw = window.localStorage.getItem(IOS_IDB_PRUNE_LOCK_KEY);
      if (!currentRaw) return;
      const current = JSON.parse(currentRaw) as { owner?: string };
      if (current?.owner === owner) {
        window.localStorage.removeItem(IOS_IDB_PRUNE_LOCK_KEY);
      }
    } catch {
      // Ignore lock release errors.
    }
  };

  const pruneStaleIndexedDbSessions = async (): Promise<void> => {
    if (!isIndexedDbSupported()) return;
    if (indexedDbCleanupStartedRef.current) return;
    if (!acquireIndexedDbPruneLock()) return;
    indexedDbCleanupStartedRef.current = true;

    try {
      const db = await openIndexedDb();
      const currentSessionId = receiverSessionIdRef.current;
      const cutoff = Date.now() - IOS_IDB_STALE_SESSION_TTL_MS;
      const sessionLastSeen = new Map<string, number>();

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IOS_IDB_STORE, 'readonly');
        const store = tx.objectStore(IOS_IDB_STORE);
        const req = store.openCursor();
        req.onerror = () => reject(req.error || new Error('INDEXED_DB_PRUNE_SCAN_FAILED'));
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          const record = cursor.value as { sessionId?: string; createdAt?: number } | null;
          const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : '';
          if (sessionId) {
            const createdAt = typeof record?.createdAt === 'number' && Number.isFinite(record.createdAt)
              ? record.createdAt
              : 0;
            const prev = sessionLastSeen.get(sessionId) || 0;
            if (createdAt > prev) {
              sessionLastSeen.set(sessionId, createdAt);
            }
          }
          cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('INDEXED_DB_PRUNE_SCAN_TX_FAILED'));
        tx.onabort = () => reject(tx.error || new Error('INDEXED_DB_PRUNE_SCAN_TX_ABORTED'));
      });

      const staleSessions = Array.from(sessionLastSeen.entries())
        .filter(([sessionId, lastSeen]) => sessionId !== currentSessionId && lastSeen < cutoff)
        .map(([sessionId]) => sessionId);

      if (staleSessions.length === 0) return;
      const staleSet = new Set(staleSessions);

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IOS_IDB_STORE, 'readwrite');
        const store = tx.objectStore(IOS_IDB_STORE);
        const req = store.openCursor();
        req.onerror = () => reject(req.error || new Error('INDEXED_DB_PRUNE_DELETE_FAILED'));
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          const record = cursor.value as { sessionId?: string } | null;
          const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : '';
          if (sessionId && staleSet.has(sessionId)) {
            cursor.delete();
          }
          cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('INDEXED_DB_PRUNE_DELETE_TX_FAILED'));
        tx.onabort = () => reject(tx.error || new Error('INDEXED_DB_PRUNE_DELETE_TX_ABORTED'));
      });
    } catch (err) {
      console.warn('IndexedDB stale session cleanup failed:', err);
    } finally {
      releaseIndexedDbPruneLock();
    }
  };

  const deleteIndexedDbChunksForFile = async (fileIndex: number): Promise<void> => {
    if (!isIndexedDbSupported()) return;
    const db = await openIndexedDb();
    const sessionId = receiverSessionIdRef.current;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IOS_IDB_STORE, 'readwrite');
      const store = tx.objectStore(IOS_IDB_STORE);
      const index = store.index('bySessionFile');
      const req = index.openCursor(IDBKeyRange.only([sessionId, fileIndex]));
      req.onerror = () => reject(req.error || new Error('INDEXED_DB_CURSOR_FAILED'));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('INDEXED_DB_DELETE_FAILED'));
      tx.onabort = () => reject(tx.error || new Error('INDEXED_DB_DELETE_ABORTED'));
    });
  };

  const deleteIndexedDbChunksForSession = async (): Promise<void> => {
    if (!isIndexedDbSupported()) return;
    const db = await openIndexedDb();
    const sessionId = receiverSessionIdRef.current;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IOS_IDB_STORE, 'readwrite');
      const store = tx.objectStore(IOS_IDB_STORE);
      const index = store.index('bySessionFile');
      const req = index.openCursor(IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]));
      req.onerror = () => reject(req.error || new Error('INDEXED_DB_SESSION_CURSOR_FAILED'));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('INDEXED_DB_SESSION_DELETE_FAILED'));
      tx.onabort = () => reject(tx.error || new Error('INDEXED_DB_SESSION_DELETE_ABORTED'));
    });
  };

  const appendIndexedDbChunkBlob = async (fileIndex: number, blob: Blob, size: number): Promise<void> => {
    const db = await openIndexedDb();
    const sessionId = receiverSessionIdRef.current;
    const seq = indexedDbChunkSeqRef.current++;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IOS_IDB_STORE, 'readwrite');
      const store = tx.objectStore(IOS_IDB_STORE);
      store.put({
        sessionId,
        fileIndex,
        seq,
        blob,
        size,
        createdAt: Date.now(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('INDEXED_DB_APPEND_FAILED'));
      tx.onabort = () => reject(tx.error || new Error('INDEXED_DB_APPEND_ABORTED'));
    });
    indexedDbBufferedBytesRef.current += size;
  };

  const readIndexedDbBlobsForFile = async (fileIndex: number): Promise<Blob[]> => {
    const db = await openIndexedDb();
    const sessionId = receiverSessionIdRef.current;
    return new Promise<Blob[]>((resolve, reject) => {
      const blobs: Blob[] = [];
      const tx = db.transaction(IOS_IDB_STORE, 'readonly');
      const store = tx.objectStore(IOS_IDB_STORE);
      const range = IDBKeyRange.bound([sessionId, fileIndex, 0], [sessionId, fileIndex, Number.MAX_SAFE_INTEGER]);
      const req = store.openCursor(range);
      req.onerror = () => reject(req.error || new Error('INDEXED_DB_READ_CURSOR_FAILED'));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const record = cursor.value as { blob?: Blob };
        if (record?.blob) blobs.push(record.blob);
        cursor.continue();
      };
      tx.oncomplete = () => resolve(blobs);
      tx.onerror = () => reject(tx.error || new Error('INDEXED_DB_READ_FAILED'));
      tx.onabort = () => reject(tx.error || new Error('INDEXED_DB_READ_ABORTED'));
    });
  };

  const flushIndexedDbBatch = async (fileIndex: number, batch: ArrayBuffer[], totalLen: number) => {
    try {
      const blob = new Blob(batch, { type: 'application/octet-stream' });
      await appendIndexedDbChunkBlob(fileIndex, blob, totalLen);
      indexedDbBufferedFileIndexRef.current = fileIndex;
    } catch (err) {
      console.error('IndexedDB write error:', err);
      failTransferPersistence('iOS 大文件缓冲写入失败，请释放存储空间后重试。');
    }
  };

  useEffect(() => {
    const notifyClosing = () => {
      const conn = connRef.current;
      if (!conn || !conn.open) return;
      try {
        conn.send({ type: 'TRANSFER_CANCELLED' });
      } catch {
        // Ignore; sender side heartbeat timeout will clean up.
      }
    };

    window.addEventListener('pagehide', notifyClosing);
    window.addEventListener('beforeunload', notifyClosing);
    return () => {
      window.removeEventListener('pagehide', notifyClosing);
      window.removeEventListener('beforeunload', notifyClosing);
    };
  }, []);

  const createNativeStreamingTarget = (
    handle: FileSystemFileHandle,
    writable: FileSystemWritableFileStream
  ): ReceiveStreamingTarget => ({
    kind: 'native-fs',
    write: async (chunk) => {
      await writable.write(chunk);
    },
    close: async () => {
      await writable.close();
    },
    truncate: async (size) => {
      await writable.truncate(size);
    },
    verifyCommittedBytes: async (expectedBytes) => {
      const file = await handle.getFile();
      return file.size === expectedBytes;
    },
  });

  const createStreamSaverTarget = (
    writer: WritableStreamDefaultWriter<Uint8Array>
  ): ReceiveStreamingTarget => ({
    kind: 'stream-saver',
    write: async (chunk) => {
      await writer.write(chunk);
    },
    close: async () => {
      await writer.close();
    },
    abort: async () => {
      await writer.abort();
    },
  });

  const handleStreamingWriteFailure = async (error: unknown) => {
    if (stateRef.current === TransferState.ERROR) {
      return;
    }

    console.error('Write Error:', error);
    const closeOk = await receiveStreamingWriter.closeCurrentTarget({
      abortStreamSaver: true,
      preserveCommittedBytes: true,
    });

    if (!closeOk) {
      console.warn('Streaming target close after write failure was not clean; preserving partial file state.');
    }

    isStreamingRef.current = receiveStreamingWriter.isStreaming();
    failTransferPersistence("写入文件失败，磁盘可能已满或权限不足。");
  };

  const abortStreams = async () => {
      const ok = await receiveStreamingWriter.closeCurrentTarget({
        abortStreamSaver: true,
        preserveCommittedBytes: true,
      });
      if (!ok) {
        console.warn("Stream abort warning: failed to close active target cleanly");
      }
      isStreamingRef.current = receiveStreamingWriter.isStreaming();
      resetIndexedDbBufferRuntime();
  };

  const closeStreams = async (options?: {
      truncateNativeBeforeClose?: boolean;
      abortStreamSaver?: boolean;
  }): Promise<boolean> => {
      const ok = await receiveStreamingWriter.closeCurrentTarget({
        truncateNativeBeforeClose: options?.truncateNativeBeforeClose === true,
        abortStreamSaver: options?.abortStreamSaver === true,
        preserveCommittedBytes: false,
      });
      isStreamingRef.current = receiveStreamingWriter.isStreaming();
      return ok;
  };

  const flushPendingStreamWrites = async (): Promise<boolean> => {
      if (!receiveStreamingWriter.isStreaming()) {
          await receiveStreamingWriter.awaitIdle();
          return true;
      }

      try {
        await receiveStreamingWriter.flushPending();
        await receiveStreamingWriter.awaitIdle();
        return stateRef.current !== TransferState.ERROR;
      } catch (error) {
        await handleStreamingWriteFailure(error);
        return false;
      }
  };

  const markCurrentFilePersisted = (fileName: string) => {
      completedFileIndicesRef.current.add(currentFileIndexRef.current);
      receiveRecoveryCoordinatorRef.current?.clearRepairStateForFile(currentFileIndexRef.current);
      sendTransferProgress(lastReportedSpeedBytesRef.current);
      if (onNotification) {
          onNotification(`文件 ${fileName} 已保存`, 'success');
      }
  };

  const enqueueWrite = (task: () => Promise<void>): Promise<void> => {
      writeQueueRef.current = writeQueueRef.current.then(task);
      return writeQueueRef.current;
  };

  const resetIndexedDbPersistedFileState = () => {
      indexedDbBufferedBytesRef.current = 0;
      indexedDbChunkSeqRef.current = 0;
      indexedDbBufferedFileIndexRef.current = null;
      resetIndexedDbBufferRuntime();
  };

  const resetMemoryFileState = () => {
      chunksRef.current = [];
      receivedChunksCountRef.current = 0;
      receivedSizeRef.current = 0;
  };

  const resetFileBuffersForRepair = (fileIndex: number) => {
      chunksRef.current = [];
      receiveStreamingWriter.reset();
      isStreamingRef.current = false;
      resetIndexedDbBufferRuntime();
      indexedDbChunkSeqRef.current = 0;
      indexedDbBufferedBytesRef.current = 0;
      indexedDbBufferedFileIndexRef.current = fileIndex;
      receivedChunksCountRef.current = 0;
      receivedSizeRef.current = 0;
  };

  const resetHasherForRepair = async (): Promise<boolean> => {
      try {
        await getFileHasher().reset();
        hashedBytesRef.current = 0;
        return true;
      } catch {
        return false;
      }
  };

  const reopenNativeWriterForResume = async (targetFileIndex: number, byteOffset: number): Promise<boolean> => {
    const handle = nativeFileHandleRef.current;
    if (!handle) return false;
    const meta = metadataRef.current;
    if (!meta || meta.files.length !== 1 || targetFileIndex !== 0) return false;

    try {
      const reopened = await receiveStreamingWriter.reopenForResume(async (resumeOffset) => {
        const writable = await handle.createWritable({ keepExistingData: true });
        await writable.seek(resumeOffset);
        return createNativeStreamingTarget(handle, writable);
      }, byteOffset);
      isStreamingRef.current = receiveStreamingWriter.isStreaming();
      preparedNativeWriterFileIndexRef.current = reopened ? targetFileIndex : null;
      return reopened;
    } catch (error) {
      console.warn('Failed to reopen native writer for resume:', error);
      receiveStreamingWriter.reset();
      isStreamingRef.current = false;
      return false;
    }
  };

  const hasRetainedCurrentFileData = (fileIndex: number): boolean => {
    const hasIndexedDbBufferedData =
      indexedDbBufferedFileIndexRef.current === fileIndex &&
      (indexedDbBufferedBytesRef.current > 0 || indexedDbBatchBytesRef.current > 0);
    const hasStreamingTarget =
      currentFileIndexRef.current === fileIndex &&
      receivedSizeRef.current > 0 &&
      receiveStreamingWriter.hasRetainedData();

    return (
      currentFileIndexRef.current === fileIndex &&
      (
        chunksRef.current.length > 0 ||
        hasIndexedDbBufferedData ||
        hasStreamingTarget
      )
    );
  };

  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;
    const requestWakeLock = async () => {
      try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (err) {}
    };
    const handleVisibilityChange = () => { if (document.visibilityState === 'visible' && state === TransferState.TRANSFERRING) requestWakeLock(); };
    if (state === TransferState.TRANSFERRING) { requestWakeLock(); document.addEventListener('visibilitychange', handleVisibilityChange); }
    return () => { if (wakeLock) wakeLock.release().catch(() => {}); document.removeEventListener('visibilitychange', handleVisibilityChange); };
  }, [state]);

  useEffect(() => {
    let interval: number;
    if (state === TransferState.TRANSFERRING) {
        interval = window.setInterval(() => {
            if (!currentFileSizeRef.current) return;
            const now = Date.now();
            const received = receivedSizeRef.current;
            const total = currentFileSizeRef.current;
            const pct = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;
            setProgress(pct);
            
            const timeDiff = now - lastSpeedUpdateRef.current;
            let latestSpeedBytes = lastReportedSpeedBytesRef.current;
            if (timeDiff >= 1000) {
                const bytesDiff = received - lastSpeedBytesRef.current;
                const speed = (bytesDiff / timeDiff) * 1000;
                const safeSpeed = Math.max(0, speed);
                latestSpeedBytes = safeSpeed;
                setDownloadSpeed(formatFileSize(safeSpeed) + '/s');
                setDownloadSpeedBytes(safeSpeed);
                if (safeSpeed > 0 && total > received) {
                    const remainingBytes = total - received;
                    const seconds = remainingBytes / safeSpeed;
                    if (seconds > 60) setEta(`${Math.ceil(seconds / 60)} 分钟`); else setEta(`${Math.ceil(seconds)} 秒`);
                } else if (received >= total) { setEta('完成'); } else { setEta('--'); }
                lastSpeedUpdateRef.current = now;
                lastSpeedBytesRef.current = received;
                lastReportedSpeedBytesRef.current = safeSpeed;
            }
            sendTransferProgress(latestSpeedBytes);
        }, 1000);
    }
    return () => clearInterval(interval);
  }, [state]);

  const getOverallTransferSnapshot = () => {
    const meta = metadataRef.current;
    if (!meta) {
      return { overallTransferredBytes: 0, overallTotalBytes: 0 };
    }
    const files = meta.files || [];
    const overallTotalBytes = Math.max(0, meta.totalSize || files.reduce((acc, file) => acc + file.size, 0));
    const completedBytes = files.reduce((acc, file, idx) => {
      return acc + (completedFileIndicesRef.current.has(idx) ? file.size : 0);
    }, 0);
    const currentIndex = currentFileIndexRef.current;
    const currentFileBytes = (
      currentIndex >= 0 &&
      currentIndex < files.length &&
      !completedFileIndicesRef.current.has(currentIndex)
    ) ? Math.min(receivedSizeRef.current, files[currentIndex].size) : 0;
    const overallTransferredBytes = Math.min(overallTotalBytes, completedBytes + currentFileBytes);
    return { overallTransferredBytes, overallTotalBytes };
  };

  const sendTransferProgress = (speedBytes: number) => {
    const conn = connRef.current;
    if (!conn || !conn.open) return;
    const { overallTransferredBytes, overallTotalBytes } = getOverallTransferSnapshot();
    try {
      conn.send({
        type: 'TRANSFER_PROGRESS',
        payload: {
          overallTransferredBytes,
          overallTotalBytes,
          speedBytes: Math.max(0, speedBytes),
        }
      });
    } catch {
      // Ignore transient progress sync failures; next tick will retry.
    }
  };

  const flushSpecificBatch = async (batch: Uint8Array[], totalLen: number) => {
      void batch;
      void totalLen;
  };

  const failTransferPersistence = (message: string) => {
      isTransferActiveRef.current = false;
      receiveRecoveryCoordinatorRef.current?.reset();
      setErrorMsg(message);
      setState(TransferState.ERROR);
      abortStreams().catch(() => {});
      if (connRef.current?.open) {
        try { connRef.current.send({ type: 'TRANSFER_CANCELLED', payload: { reason: message } }); } catch {}
        try { connRef.current.close(); } catch {}
      }
  };

  const handleIncomingMessage = async (conn: DataConnection, msg: P2PMessage) => {
    if (msg.type === 'DEVICE_INFO') {
      const remoteName = typeof msg.payload?.deviceName === 'string' ? msg.payload.deviceName.trim().slice(0, 24) : '';
      setSenderDeviceName(remoteName || '发送设备');
    }
    else if (msg.type === 'METADATA') {
      const meta = msg.payload as FileMetadata;
      const remoteProtocolVersion = typeof meta.protocolVersion === 'number' ? meta.protocolVersion : 1;
      if (remoteProtocolVersion > P2P_PROTOCOL_VERSION) {
          setErrorMsg(`发送方协议版本(${remoteProtocolVersion})高于当前版本(${P2P_PROTOCOL_VERSION})，请升级接收端。`);
          setState(TransferState.ERROR);
          conn.close();
          return;
      }
      const previousMeta = metadataRef.current;
      let isResumable = false;
      if (previousMeta &&
          previousMeta.totalSize === meta.totalSize &&
          previousMeta.files.length === meta.files.length) {
          isResumable = meta.files.every((file, idx) => {
              const prev = previousMeta.files[idx];
              if (file.fingerprint && prev.fingerprint) {
                  return file.fingerprint === prev.fingerprint;
              }
              return file.name === prev.name && file.size === prev.size;
          });
      } else {
          resetStateForNewTransfer();
      }

      setMetadata(meta);
      metadataRef.current = meta;
      setTotalFiles(meta.files?.length || 0);
      setState(TransferState.PEER_CONNECTED);
      setCanResume(isResumable);
      isTransferActiveRef.current = false;

      if (isResumable && onNotification) onNotification("发现上次未完成的传输", 'info');
      if ((isIOS || isSafari) && meta.totalSize >= IOS_MEMORY_WARN_BYTES && onNotification) {
          onNotification('检测到超大文件：将优先尝试使用 IndexedDB 分块缓冲，减少内存占用。', 'info');
      }
    }
    else if (msg.type === 'FILE_START') {
      await receiveSessionCoordinator.handleFileStart({
        ...msg.payload,
        fileName: sanitizeFileName(msg.payload.fileName || `file_${Date.now()}`),
      });
    }
    else if (msg.type === 'FILE_COMPLETE') {
       await receiveSessionCoordinator.handleFileComplete(msg.payload);
    }
    else if (msg.type === 'ALL_FILES_COMPLETE') {
       await receiveSessionCoordinator.handleAllFilesComplete();
    }
    else if (msg.type === 'REJECT_TRANSFER') {
       markConnectionFailure(connectTelemetryRef.current, 'rejected_by_sender', { reason: msg.payload?.reason });
       setErrorMsg(msg.payload?.reason || "发送方拒绝了请求。");
       setState(TransferState.ERROR);
       conn.close();
    }
    else if (msg.type === 'TRANSFER_CANCELLED') {
       setErrorMsg("发送方已停止分享。");
       setState(TransferState.ERROR);
       conn.close();
    }
  };

  const setupConnListeners = (
    conn: DataConnection,
    attemptKind: RouteAttemptKind,
    attemptId: string
  ) => {
    let reconnectScheduled = false;
    registerRouteAttempt({ attemptId, attemptKind, conn });

    const scheduleFastReconnect = () => {
      if (reconnectScheduled) return true;
      if (attemptKind !== 'all') return false;
      if (happyEyeballsWonRef.current) return false;
      if (stateRef.current !== TransferState.WAITING_FOR_PEER) return false;
      if (retryCountRef.current >= MAX_CONNECT_RETRY) return false;
      if (!peerRef.current || peerRef.current.destroyed) return false;

      reconnectScheduled = true;
      retryCountRef.current += 1;
      const delay = Math.min(FAST_RETRY_BASE_MS * Math.pow(2, retryCountRef.current - 1), FAST_RETRY_MAX_MS);
      markConnectionRetry(connectTelemetryRef.current, 'data_channel_close_or_error');
      window.setTimeout(() => {
        if (!peerRef.current || peerRef.current.destroyed) return;
        if (stateRef.current !== TransferState.WAITING_FOR_PEER) return;
        startConnectionAttempt(connectTelemetryRef.current, 'fast_retry');
        const nextConn = peerRef.current.connect(`aerodrop-${codeRef.current}`, { serialization: 'binary' });
        const nextAttemptId = getNextRouteAttemptId('all');
        setupConnListeners(nextConn, 'all', nextAttemptId);
      }, delay);
      return true;
    };

    conn.on('open', () => {
      clearConnectionTimeout();
      retryCountRef.current = 0;

      if (happyEyeballsWonRef.current) {
        closeRouteAttempt(attemptId, 'winner_selected');
        return;
      }

      receiveRouteArbiterRef.current?.markAttemptOpen(attemptKind);

      try {
        conn.send({
          type: 'ROUTE_PROBE',
          payload: {
            receiverSessionId: receiverSessionIdRef.current,
            attemptId,
            attemptKind,
            deviceName: localDeviceNameRef.current,
          },
        });
      } catch {
        if (scheduleFastReconnect()) {
          return;
        }
        markConnectionFailure(connectTelemetryRef.current, 'route_probe_failed');
        setErrorMsg('连接初始化失败，请重试');
        setState(TransferState.ERROR);
        try { conn.close(); } catch {}
      }
    });

    conn.on('data', async (data: any) => {
      if (data == null) return;

      const currentState = stateRef.current;
      if (!isTransferActiveRef.current && currentState !== TransferState.IDLE && currentState !== TransferState.WAITING_FOR_PEER && currentState !== TransferState.PEER_CONNECTED) {
          return;
      }

      const isBinary = data instanceof ArrayBuffer || (data.constructor && data.constructor.name === 'ArrayBuffer') || ArrayBuffer.isView(data);

      if (isBinary) {
         if (connRef.current !== conn) {
           return;
         }
         if (!await receivePersistenceOrchestrator.awaitPendingFileFinalize('binary_chunk')) return;
         if (!isTransferActiveRef.current) return;
 
         const chunkData = ((): ArrayBuffer => {
              if (ArrayBuffer.isView(data)) {
                  const view = data as ArrayBufferView;
                 return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
             }
             return data as ArrayBuffer;
         })();
         const byteLength = chunkData.byteLength;

          if (byteLength > 0) {
              receivedChunksCountRef.current++;
              receivedSizeRef.current += byteLength;
              try {
                getFileHasher().update(new Uint8Array(chunkData));
              } catch {
                failTransferPersistence("文件校验计算失败，请重试传输。");
                return;
              }
             hashedBytesRef.current += byteLength;
             
             if (isStreamingRef.current) {
                 void receiveStreamingWriter.enqueueChunk(new Uint8Array(chunkData)).catch((error) => {
                   void handleStreamingWriteFailure(error);
                 });
             } else if (isIndexedDbBufferingRef.current) {
                 indexedDbBatchRef.current.push(chunkData);
                 indexedDbBatchBytesRef.current += byteLength;

                 if (indexedDbBatchBytesRef.current >= BUFFER_FLUSH_THRESHOLD) {
                     const fileIndexForBatch = currentFileIndexRef.current;
                     const batch = indexedDbBatchRef.current;
                     const batchSize = indexedDbBatchBytesRef.current;

                     indexedDbBatchRef.current = [];
                     indexedDbBatchBytesRef.current = 0;

                     writeQueueRef.current = writeQueueRef.current.then(() => flushIndexedDbBatch(fileIndexForBatch, batch, batchSize));
                 }
              } else {
                  chunksRef.current.push(chunkData);
              }
          }
          return;
      }

      const msg = data as P2PMessage;

      if (connRef.current !== conn) {
        if (
          msg.type === 'DEVICE_INFO' ||
          msg.type === 'METADATA' ||
          msg.type === 'REJECT_TRANSFER' ||
          msg.type === 'TRANSFER_CANCELLED'
        ) {
          bufferRouteMessage(attemptId, msg);
        }
        return;
      }

      await handleIncomingMessage(conn, msg);
    });

    conn.on('close', () => {
       if (connRef.current !== conn) {
        unregisterRouteAttempt(attemptId);
        if (happyEyeballsWonRef.current) return;
        if (stateRef.current === TransferState.WAITING_FOR_PEER) {
          scheduleFastReconnect();
        }
        return;
       }

       unregisterRouteAttempt(attemptId);
       connRef.current = null;
       clearHeartbeatTimer();
       const currentState = stateRef.current;
       if (currentState === TransferState.WAITING_FOR_PEER && scheduleFastReconnect()) {
          return;
       }
       clearConnectionTimeout();
       if (currentState !== TransferState.COMPLETED) {
         markConnectionFailure(connectTelemetryRef.current, 'connection_closed', { state: currentState });
       }
      if (
        currentState === TransferState.TRANSFERRING ||
        currentState === TransferState.WAITING_FOR_PEER ||
        currentState === TransferState.PEER_CONNECTED
      ) {
        setErrorMsg(
          getReceiverDisconnectedMessage(
            hasTurnRef.current,
            currentState === TransferState.WAITING_FOR_PEER
          )
        );
        setState(TransferState.ERROR);
      }
    });

    conn.on('error', () => {
      if (connRef.current !== conn) {
        if (happyEyeballsWonRef.current) return;
        if (stateRef.current === TransferState.WAITING_FOR_PEER) {
          scheduleFastReconnect();
        }
        return;
      }
      clearHeartbeatTimer();
      if (scheduleFastReconnect()) {
        return;
      }
      markConnectionFailure(connectTelemetryRef.current, 'data_channel_error');
    });
  };

  const cleanupLosingPeer = (winningConn: DataConnection) => {
    // Destroy the relay peer if the P2P peer won, or vice-versa.
    const winningPeer = winningConn.provider;
    if (relayPeerRef.current && relayPeerRef.current !== winningPeer) {
      try { relayPeerRef.current.destroy(); } catch {}
      relayPeerRef.current = null;
      relayConnRef.current = null;
    }
    if (peerRef.current && peerRef.current !== winningPeer) {
      try { peerRef.current.destroy(); } catch {}
    }
    peerRef.current = winningPeer;
  };

  const resetStateForNewTransfer = () => {
      chunksRef.current = [];
      receiveStreamingWriter.reset();
      isStreamingRef.current = false;
      resetIndexedDbFileState();
      receivedChunksCountRef.current = 0;
      receivedSizeRef.current = 0;
      hashedBytesRef.current = 0;
      completedFileIndicesRef.current.clear();
      currentFileIndexRef.current = 0;
      currentFileNameRef.current = '';
      setDownloadSpeed('0 KB/s');
      setDownloadSpeedBytes(0);
      lastReportedSpeedBytesRef.current = 0;
      receiveRecoveryCoordinator.reset();
      setEta('--');
      preparedNativeWriterFileIndexRef.current = null;
      receivePersistenceAdapter.reset();
      receivePersistenceOrchestrator.reset();
      writeQueueRef.current = Promise.resolve();
  };

  const prepareFilePersistenceTarget = async ({
    fileIndex,
    fileName,
    fileSize,
    persistenceStrategy,
    usePreparedNativeWriter,
  }: {
    fileIndex: number;
    fileName: string;
    fileSize: number;
    persistenceStrategy: 'native-fs' | 'stream-saver' | 'indexeddb-buffer' | 'memory-blob';
    usePreparedNativeWriter: boolean;
  }) => {
    if (usePreparedNativeWriter) {
      isStreamingRef.current = receiveStreamingWriter.isStreaming();
      preparedNativeWriterFileIndexRef.current = null;
      return;
    }

    if (persistenceStrategy === 'native-fs' && nativeFileHandleRef.current) {
      try {
        const writable = await nativeFileHandleRef.current.createWritable({ keepExistingData: false });
        receiveStreamingWriter.attachTarget(createNativeStreamingTarget(nativeFileHandleRef.current, writable), {
          committedBytes: 0,
        });
        isStreamingRef.current = receiveStreamingWriter.isStreaming();
        return;
      } catch {
        receiveStreamingWriter.reset();
        isStreamingRef.current = false;
      }
    }

    if (!receiveStreamingWriter.isStreaming()) {
      if (persistenceStrategy === 'indexeddb-buffer' || persistenceStrategy === 'memory-blob') {
        receiveStreamingWriter.reset();
        isStreamingRef.current = false;
        return;
      }

      if (persistenceStrategy === 'stream-saver') {
        try {
          const streamPathname =
            `${STREAMSAVER_PATH_PREFIX}${Date.now().toString(36)}-` +
            `${Math.random().toString(36).slice(2, 8)}/${encodeURIComponent(fileName)}`;
          const fileStream = streamSaver.createWriteStream(fileName, {
            size: fileSize,
            pathname: streamPathname,
          });
          receiveStreamingWriter.attachTarget(createStreamSaverTarget(fileStream.getWriter()), {
            committedBytes: 0,
          });
          isStreamingRef.current = receiveStreamingWriter.isStreaming();
          return;
        } catch {
          receiveStreamingWriter.reset();
          isStreamingRef.current = false;
          return;
        }
      }

      receiveStreamingWriter.reset();
      isStreamingRef.current = false;
      return;
    }

    isStreamingRef.current = receiveStreamingWriter.isStreaming();
  };

  const setCurrentFileTransferState = ({
    fileIndex,
    fileName,
    fileSize,
  }: {
    fileIndex: number;
    fileName: string;
    fileSize: number;
  }) => {
    currentFileSizeRef.current = fileSize;
    currentFileIndexRef.current = fileIndex;
    currentFileNameRef.current = fileName;
    lastSpeedUpdateRef.current = Date.now();
    lastSpeedBytesRef.current = receivedSizeRef.current;
    lastReportedSpeedBytesRef.current = 0;
    setCurrentFileName(fileName);
    setCurrentFileIndex(fileIndex + 1);
    setProgress(fileSize > 0 ? Math.min(100, Math.floor((receivedSizeRef.current / fileSize) * 100)) : 0);
    setEta('计算中...');
    setDownloadSpeed('0 KB/s');
  };

  const markReceiveSessionCompleted = () => {
    setState(TransferState.COMPLETED);
    if (onNotification) onNotification("所有文件接收完毕", 'success');
    resetStateForNewTransfer();
    isTransferActiveRef.current = false;
  };

  if (!receiveRecoveryCoordinatorRef.current) {
    receiveRecoveryCoordinatorRef.current = createReceiveRecoveryCoordinator({
      maxAutoRepairRetries: MAX_AUTO_REPAIR_RETRIES_PER_FILE,
      getConnection: () => connRef.current,
      setTransferActive: (active) => {
        isTransferActiveRef.current = active;
      },
      getCurrentFileIndex: () => currentFileIndexRef.current,
      getReceivedSize: () => receivedSizeRef.current,
      isFileCompleted: (fileIndex) => completedFileIndicesRef.current.has(fileIndex),
      hasRetainedCurrentFileData,
      flushPendingStreamWrites,
      reopenNativeWriterForResume,
      resetFileBuffersForRepair,
      resetHasherForRepair,
      abortStreams,
      awaitWriteQueue: () => writeQueueRef.current,
      deleteIndexedDbChunksForFile,
      setProgress,
      setDownloadSpeed,
      setDownloadSpeedBytes,
      setEta,
      setTransferState: setState,
      setError: setErrorMsg,
      notify: onNotification,
      failTransferPersistence,
    });
  }
  const receiveRecoveryCoordinator = receiveRecoveryCoordinatorRef.current!;

  if (!receivePersistenceAdapterRef.current) {
    receivePersistenceAdapterRef.current = createReceivePersistenceAdapter({
      isIOS,
      isSafari,
      isTransferActive: () => isTransferActiveRef.current,
      getReceivedSize: () => receivedSizeRef.current,
      getCurrentFileSize: () => currentFileSizeRef.current,
      getCurrentFileIndex: () => currentFileIndexRef.current,
      getCurrentFileInfo: () => {
        const file = metadataRef.current?.files?.[currentFileIndexRef.current];
        return file ? { name: file.name, type: file.type } : null;
      },
      isIndexedDbBuffering: () => isIndexedDbBufferingRef.current,
      getMemoryChunks: () => chunksRef.current,
      readIndexedDbBlobsForFile,
      deleteIndexedDbChunksForFile,
      resetIndexedDbFileState: resetIndexedDbPersistedFileState,
      resetMemoryFileState,
      failTransferPersistence,
    });
  }
  const receivePersistenceAdapter = receivePersistenceAdapterRef.current!;

  if (!receivePersistenceOrchestratorRef.current) {
    receivePersistenceOrchestratorRef.current = createReceivePersistenceOrchestrator({
      getState: () => stateRef.current,
      isTransferActive: () => isTransferActiveRef.current,
      getCurrentFileIndex: () => currentFileIndexRef.current,
      isIndexedDbBuffering: () => isIndexedDbBufferingRef.current,
      isStreaming: () => receiveStreamingWriter.isStreaming(),
      finalizeStreamingWriter: async () => {
        const finalized = await receiveStreamingWriter.finalize();
        isStreamingRef.current = receiveStreamingWriter.isStreaming();
        return finalized;
      },
      takeIndexedDbBatch: () => {
        const batch = indexedDbBatchRef.current;
        const size = indexedDbBatchBytesRef.current;
        indexedDbBatchRef.current = [];
        indexedDbBatchBytesRef.current = 0;
        return { batch, size };
      },
      flushIndexedDbBatch,
      takeStreamBatch: () => ({ batch: [], size: 0 }),
      flushSpecificBatch,
      enqueueWrite,
      closeStreams: () => closeStreams(),
      saveCurrentFile: () => receivePersistenceAdapter.saveCurrentFile(),
      markCurrentFilePersisted,
      failTransferPersistence,
    });
  }
  const receivePersistenceOrchestrator = receivePersistenceOrchestratorRef.current!;

  if (!receiveSessionCoordinatorRef.current) {
    receiveSessionCoordinatorRef.current = createReceiveSessionCoordinator({
      awaitPendingFileFinalize: (reason) => receivePersistenceOrchestrator.awaitPendingFileFinalize(reason),
      isIOS,
      isSafari,
      preferBrowserDownload: false,
      supportsStreamSaver: !!streamSaver,
      indexedDbThresholdBytes: IOS_IDB_BUFFER_THRESHOLD_BYTES,
      getMetadataFileCount: () => metadataRef.current?.files?.length ?? 0,
      getFileStartPersistenceCapabilities: (fileIndex) => {
        const usePreparedNativeWriter = false;
        const canUseNativeFs =
          !isIOS &&
          !isSafari &&
          !!window.showSaveFilePicker &&
          (metadataRef.current?.files?.length ?? 0) === 1 &&
          !!nativeFileHandleRef.current;
        return {
          canUseNativeFs,
          usePreparedNativeWriter,
        };
      },
      supportsIndexedDb: isIndexedDbSupported,
      setTransferActive: (active) => {
        isTransferActiveRef.current = active;
      },
      isTransferActive: () => isTransferActiveRef.current,
      isStreaming: () => receiveStreamingWriter.isStreaming(),
      isIndexedDbBuffering: () => isIndexedDbBufferingRef.current,
      setIndexedDbBuffering: (enabled) => {
        isIndexedDbBufferingRef.current = enabled;
      },
      notifyIndexedDbBufferingEnabled: () => {
        if (isIndexedDbBufferingRef.current && !indexedDbNotifiedRef.current && onNotification) {
          indexedDbNotifiedRef.current = true;
          onNotification('iOS 大文件已启用 IndexedDB 缓冲模式', 'info');
        }
      },
      hasRetainedCurrentFileData,
      abortStreams,
      resetIncomingFileBuffers: resetFileBuffersForRepair,
      awaitWriteQueue: async () => {
        await writeQueueRef.current;
        await receiveStreamingWriter.awaitIdle();
      },
      deleteIndexedDbChunksForFile,
      prepareFilePersistenceTarget,
      setCurrentFileState: setCurrentFileTransferState,
      resetFileHasher: resetHasherForRepair,
      getCurrentFileIndex: () => currentFileIndexRef.current,
      getCurrentFileName: () => currentFileNameRef.current,
      getCurrentFileSize: () => currentFileSizeRef.current,
      getReceivedSize: () => receivedSizeRef.current,
      getHashedBytes: () => hashedBytesRef.current,
      finalizeHasher: () => getFileHasher().finalizeHex(),
      requestAutoRepair: (fileIndex, reason) => receiveRecoveryCoordinator.requestAutoRepair(fileIndex, reason),
      clearPendingAutoRepairFile: (fileIndex) => receiveRecoveryCoordinator.clearPendingAutoRepairFile(fileIndex),
      getPendingAutoRepairFile: () => receiveRecoveryCoordinator.getPendingAutoRepairFile(),
      hasPendingAutoRepair: () => receiveRecoveryCoordinator.hasPendingAutoRepair(),
      finalizeCurrentFilePersistence: (fileName) => receivePersistenceOrchestrator.finalizeCurrentFile(fileName),
      saveCurrentFile: () => receivePersistenceAdapter.saveCurrentFile(),
      markCurrentFilePersisted,
      getExpectedFiles: () => metadataRef.current?.files?.length ?? 0,
      getSavedFiles: () => completedFileIndicesRef.current.size,
      sendTransferProgress,
      sendAllFilesReceived: () => {
        const conn = connRef.current;
        if (!conn) return;
        try {
          conn.send({ type: 'ALL_FILES_RECEIVED' });
        } catch {
          // Ignore ack send failures; sender has heartbeat/close fallback.
        }
      },
      markCompleted: markReceiveSessionCompleted,
      failTransferPersistence,
    });
  }
  const receiveSessionCoordinator = receiveSessionCoordinatorRef.current!;

  const handleConnect = async () => {
    if (!code || code.length !== 4) return;
    connectTelemetryRef.current = createConnectionSession('receiver', { code });
    setState(TransferState.WAITING_FOR_PEER);
    setConnectingStage('fetching_ice');
    setErrorMsg('');
    retryCountRef.current = 0;
    happyEyeballsWonRef.current = false;
    resetRouteAttemptState();
    connRef.current = null;
    relayConnRef.current = null;
    startConnectionAttempt(connectTelemetryRef.current, 'initial_connect');

    if (peerRef.current) peerRef.current.destroy();
    if (relayPeerRef.current) { try { relayPeerRef.current.destroy(); } catch {} relayPeerRef.current = null; }

    const iceConfig = await getIceConfig();
    const networkProfile = getBrowserNetworkProfile();
    const connectionPlan = createHappyEyeballsPlan(iceConfig, networkProfile, {
      defaultInitialTimeoutMs: INITIAL_TIMEOUT_MS,
      relayInitialTimeoutMs: RELAY_TIMEOUT_MS,
      relayParallelDelayMs: RELAY_PARALLEL_DELAY_MS,
      p2pBackfillDelayMs: P2P_BACKFILL_DELAY_MS,
    });
    const routeSelectionTimings = getRouteSelectionTimings({
      isMobileDevice: networkProfile.isMobileDevice,
      isConstrained: networkProfile.isConstrained,
      relayRecommended: iceConfig.relayRecommended,
    });
    markIceConfigFetched(connectTelemetryRef.current);
    setConnectingStage('connecting_signaling');
    hasTurnRef.current = iceConfig.hasTurn;
    preferredIcePolicyRef.current = connectionPlan.initialPolicy;
    p2pTimeoutRetryCountRef.current = 0;
    receiveRouteArbiterRef.current = createReceiveRouteArbiter({
      p2pGraceWindowMs: routeSelectionTimings.p2pGraceWindowMs,
      onCommit: (winningKind) => {
        if (stateRef.current !== TransferState.WAITING_FOR_PEER) {
          return;
        }

        const winnerAttemptId = latestRouteAttemptIdsRef.current[winningKind];
        if (!winnerAttemptId) {
          return;
        }

        const winner = routeAttemptsRef.current.get(winnerAttemptId);
        if (!winner || !winner.conn.open) {
          return;
        }

        clearConnectionTimeout();
        connRef.current = winner.conn;
        happyEyeballsWonRef.current = true;
        closeNonWinningRouteAttempts(winnerAttemptId);
        cleanupLosingPeer(winner.conn);
        markConnectionSuccess(connectTelemetryRef.current, { peerId: winner.conn.peer });
        setConnectingStage('waiting_response');

        try {
          winner.conn.send({
            type: 'ROUTE_COMMIT',
            payload: {
              receiverSessionId: receiverSessionIdRef.current,
              attemptId: winnerAttemptId,
              selectedKind: winningKind,
            },
          });
          winner.conn.send({
            type: 'DEVICE_INFO',
            payload: {
              deviceName: localDeviceNameRef.current,
              sessionId: receiverSessionIdRef.current,
            },
          });
        } catch {
          markConnectionFailure(connectTelemetryRef.current, 'route_commit_failed');
          setErrorMsg('建立路由失败，请重试');
          setState(TransferState.ERROR);
          try { winner.conn.close(); } catch {}
          return;
        }

        startWinnerHeartbeat(winner.conn);
        collectSelectedRoute(winner.conn);
        const pendingMessages = takePendingRouteMessages(winnerAttemptId);
        void pendingMessages.reduce(
          (chain, message) => chain.then(() => handleIncomingMessage(winner.conn, message)),
          Promise.resolve()
        );
      },
      schedule: (ms, fn) => window.setTimeout(fn, ms),
      clearScheduled: (id) => window.clearTimeout(id),
    });

    if (
      iceConfig.hasTurn &&
      (connectionPlan.reason === 'mobile_network' ||
        connectionPlan.reason === 'constrained_network' ||
        connectionPlan.reason === 'relay_recommended') &&
      onNotification
    ) {
      if (connectionPlan.initialPolicy === 'relay') {
        onNotification('检测到移动或高延迟网络，已优先尝试中继连接以提升成功率。', 'info');
      } else {
        onNotification('检测到当前网络可能受限，将优先尝试直连，并在需要时快速回退到中继。', 'info');
      }
    } else if (!iceConfig.hasTurn && onNotification) {
      onNotification(NO_TURN_WARNING_MESSAGE, 'info');
    }

    const applyConnectTimeout = (timeoutMs: number) => {
      clearConnectionTimeout();
      connectionTimeoutRef.current = setTimeout(() => {
        connectionTimeoutRef.current = null;

        // If happy-eyeballs already connected, ignore the timeout.
        if (happyEyeballsWonRef.current) return;

        if (hasTurnRef.current && preferredIcePolicyRef.current === 'all') {
          if (p2pTimeoutRetryCountRef.current < 1) {
            p2pTimeoutRetryCountRef.current += 1;
            markSessionEvent(connectTelemetryRef.current, 'p2p_timeout_retry');
            markConnectionRetry(connectTelemetryRef.current, 'timeout_retry_p2p_all');
            startConnectionAttempt(connectTelemetryRef.current, 'p2p_retry_all');
            createAndConnectPeer('all', INITIAL_TIMEOUT_MS);
            return;
          }
        }

        // Final timeout — tear down everything.
        resetRouteAttemptState();
        if (peerRef.current) peerRef.current.destroy();
        if (relayPeerRef.current) { try { relayPeerRef.current.destroy(); } catch {} relayPeerRef.current = null; }
        markConnectionFailure(connectTelemetryRef.current, 'connect_timeout', { timeoutMs });
        setErrorMsg(getReceiverPreTransferFailureMessage(hasTurnRef.current));
        setState(TransferState.ERROR);
      }, timeoutMs);
    };

    const createAndConnectPeer = async (policy: RTCIceTransportPolicy, timeoutMs: number) => {
      // For relay fallback via happy-eyeballs, keep the P2P peer alive.
      if (policy !== 'relay' && peerRef.current && !peerRef.current.destroyed) {
        peerRef.current.destroy();
      }

      let peer: Peer;
      try {
        const { default: PeerRuntime } = await loadPeerRuntime();
        peer = new PeerRuntime({
          debug: peerDebugLevel,
          pingInterval: 5000,
          config: {
            iceServers: iceConfig.iceServers,
            iceCandidatePoolSize: iceConfig.iceCandidatePoolSize,
            iceTransportPolicy: policy,
          }
        });
      } catch {
        clearConnectionTimeout();
        setErrorMsg('加载连接模块失败，请重试');
        setState(TransferState.ERROR);
        return;
      }

      if (stateRef.current !== TransferState.WAITING_FOR_PEER) {
        try { peer.destroy(); } catch {}
        return;
      }

      peer.on('open', () => {
        if (happyEyeballsWonRef.current) { peer.destroy(); return; }
        markSignalingOpen(connectTelemetryRef.current);
        setConnectingStage('connecting_peer');
        markSessionEvent(connectTelemetryRef.current, 'peer_open', { iceTransportPolicy: policy });
        const conn = peer.connect(`aerodrop-${code}`, { serialization: 'binary' });
        const attemptKind: RouteAttemptKind = policy === 'relay' ? 'relay' : 'all';
        const attemptId = getNextRouteAttemptId(attemptKind);
        if (policy === 'relay') {
          relayConnRef.current = conn;
        }
        setupConnListeners(conn, attemptKind, attemptId);
      });

      peer.on('error', (err) => {
        if (happyEyeballsWonRef.current) return;
        if (err.type === 'peer-unavailable' && retryCountRef.current < MAX_CONNECT_RETRY) {
          // Skip peer-unavailable retries for the background relay attempt
          // to avoid burning the shared retry budget and routing through the wrong peer.
          if (policy === 'relay') return;
          retryCountRef.current++;
          const delay = Math.min(FAST_RETRY_BASE_MS * Math.pow(2, retryCountRef.current - 1), FAST_RETRY_MAX_MS);
          markConnectionRetry(connectTelemetryRef.current, 'peer_unavailable');
          window.setTimeout(() => {
            if (happyEyeballsWonRef.current) return;
            if (peer && !peer.destroyed) {
              startConnectionAttempt(connectTelemetryRef.current, 'peer_unavailable_retry');
              const conn = peer.connect(`aerodrop-${code}`, { serialization: 'binary' });
              const attemptId = getNextRouteAttemptId('all');
              setupConnListeners(conn, 'all', attemptId);
            }
          }, delay);
        } else {
          // Only fail if this is the primary peer (not a background relay attempt).
          if (policy === 'relay' && peerRef.current && !peerRef.current.destroyed) return;
          clearConnectionTimeout();
          markConnectionFailure(connectTelemetryRef.current, `peer_error:${err.type}`);
          setErrorMsg(`连接错误: ${err.type}`);
          setState(TransferState.ERROR);
        }
      });

      if (policy === 'relay') {
        relayPeerRef.current = peer;
      } else {
        peerRef.current = peer;
      }
      applyConnectTimeout(timeoutMs);
      };

    const initialPolicy = connectionPlan.initialPolicy;
    const backgroundPolicy = connectionPlan.backgroundPolicy;
    const initialTimeoutMs = connectionPlan.initialTimeoutMs;
    const backgroundDelayMs = connectionPlan.backgroundDelayMs;
    const backgroundTimeoutMs = connectionPlan.backgroundTimeoutMs;

    markSessionEvent(connectTelemetryRef.current, 'ice_strategy_selected', {
      initialPolicy,
      backgroundPolicy,
      relayRecommended: iceConfig.relayRecommended,
      relayReason: iceConfig.relayReason,
      fetchLatencyMs: iceConfig.fetchLatencyMs,
      strategyReason: connectionPlan.reason,
      networkType: networkProfile.connectionType,
      effectiveType: networkProfile.effectiveType,
      isLikelyMobileNetwork: networkProfile.isLikelyMobileNetwork,
      isConstrained: networkProfile.isConstrained,
    });
    void createAndConnectPeer(initialPolicy, initialTimeoutMs);

    if (
      iceConfig.hasTurn &&
      backgroundPolicy &&
      backgroundPolicy !== initialPolicy &&
      backgroundDelayMs !== null &&
      backgroundTimeoutMs !== null
    ) {
      window.setTimeout(() => {
        if (happyEyeballsWonRef.current) return;
        if (stateRef.current !== TransferState.WAITING_FOR_PEER) return;
        markSessionEvent(
          connectTelemetryRef.current,
          backgroundPolicy === 'relay' ? 'happy_eyeballs_relay_start' : 'happy_eyeballs_p2p_backfill_start'
        );
        startConnectionAttempt(
          connectTelemetryRef.current,
          backgroundPolicy === 'relay' ? 'relay_parallel' : 'p2p_backfill_parallel'
        );
        void createAndConnectPeer(backgroundPolicy, backgroundTimeoutMs);
      }, backgroundDelayMs);
    }
  };

  const acceptTransfer = async () => {
    if (connRef.current?.open) {
      resetStateForNewTransfer();
      isTransferActiveRef.current = true;
      preparedNativeWriterFileIndexRef.current = null;
      nativeFileHandleRef.current = null;

      if (
        !isIOS &&
        !isSafari &&
        !!window.showSaveFilePicker &&
        (metadataRef.current?.files?.length ?? 0) === 1
      ) {
        const suggestedName = sanitizeFileName(
          metadataRef.current?.files?.[0]?.name || `file_${Date.now()}.bin`
        );
        try {
          nativeFileHandleRef.current = await window.showSaveFilePicker({
            suggestedName,
          });
          if (onNotification) {
            onNotification("已启用原生流式写入模式。", 'info');
          }
        } catch {
          nativeFileHandleRef.current = null;
          if (onNotification) {
            onNotification("未授予本地保存权限，将回退到备用保存模式。", 'info');
          }
        }
      } else if (isIOS || isSafari) {
          isStreamingRef.current = false;
          if (onNotification) onNotification("iOS 模式：文件将在传输完成后保存", 'info');
      } else if (onNotification) {
          onNotification("当前将优先尝试流式写入备用模式；若不可用则回退到浏览器保存。", 'info');
      }

      connRef.current.send({ type: 'ACCEPT_TRANSFER' });
      setState(TransferState.TRANSFERRING);
    } else {
      setErrorMsg("连接已断开，请重新连接发送方。");
      setState(TransferState.ERROR);
      if (onNotification) onNotification("连接已断开，请重试", 'error');
    }
  };

  const resumeTransfer = () => {
      void receiveRecoveryCoordinator.resumeTransfer();
  };

  const reset = () => {
    isStreamingRef.current = false;
    isTransferActiveRef.current = false;
    happyEyeballsWonRef.current = false;
    clearConnectionTimeout();
    clearHeartbeatTimer();
    resetRouteAttemptState();
    
    abortStreams().then(() => {
        deleteIndexedDbChunksForSession().catch(() => {});
        if (connRef.current) connRef.current.close();
        if (peerRef.current) peerRef.current.destroy();
        if (relayPeerRef.current) { try { relayPeerRef.current.destroy(); } catch {} relayPeerRef.current = null; }
        setMetadata(null);
        setCode('');
        setState(TransferState.IDLE);
        setErrorMsg('');
        setConnectingStage('');
        setProgress(0);
        setDownloadSpeedBytes(0);
        setSenderDeviceName('');
        indexedDbNotifiedRef.current = false;
        nativeFileHandleRef.current = null;
        resetStateForNewTransfer();
        resetReceiverSnapshot();
    });
  };

  
  const handleRetry = () => { if (code.length === 4) handleConnect(); else reset(); };
  const handleDigitClick = (digit: string) => { if (code.length < 4) setCode(prev => prev + digit); };
  const handleBackspace = () => { setCode(prev => prev.slice(0, -1)); };
  const handleClear = () => { setCode(''); };
  const handlePasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (/^\d{4}$/.test(text)) {
        setCode(text);
        return;
      }
      const match = text.match(/[?&]code=(\d{4})(?:&|$)/);
      if (match) {
        setCode(match[1]);
        return;
      }
      if (onNotification) onNotification("剪贴板中未找到 4 位口令", 'info');
    } catch {
      if (onNotification) onNotification("无法读取剪贴板，请手动输入口令", 'info');
    }
  };

  const primaryFile = metadata?.files?.[0];
  const isMultiFile = (metadata?.files?.length || 0) > 1;
  const formatEta = (seconds: number): string => {
    if (!Number.isFinite(seconds) || seconds <= 0) return '--';
    if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
    if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
    return `${Math.ceil(seconds / 3600)} 小时`;
  };
  const totalBytes = metadata?.totalSize ?? 0;
  const completedBytes = metadata?.files.reduce((acc, file, idx) => {
    return acc + (completedFileIndicesRef.current.has(idx) ? file.size : 0);
  }, 0) ?? 0;
  const currentFileBytes = (() => {
    if (!metadata) return 0;
    const idx = currentFileIndexRef.current;
    if (idx < 0 || idx >= metadata.files.length) return 0;
    if (completedFileIndicesRef.current.has(idx)) return 0;
    return Math.min(receivedSizeRef.current, metadata.files[idx].size);
  })();
  const overallTransferredBytes = Math.min(totalBytes, completedBytes + currentFileBytes);
  const overallRemainingBytes = Math.max(0, totalBytes - overallTransferredBytes);
  const overallEta = downloadSpeedBytes > 0 ? formatEta(overallRemainingBytes / downloadSpeedBytes) : '--';

  useEffect(() => {
    setReceiverSnapshot({
      state,
      errorMsg,
      code,
      connectingStage,
      metadata,
      senderDeviceName,
      canResume,
      isStreaming: isStreamingRef.current,
      progress,
      downloadSpeed,
      downloadSpeedBytes,
      eta,
      overallTransferredBytes,
      totalBytes,
      overallEta,
      currentFileIndex: currentFileIndexRef.current,
      totalFiles,
      currentFileName,
    });
  }, [
    canResume,
    code,
    connectingStage,
    currentFileName,
    downloadSpeed,
    downloadSpeedBytes,
    errorMsg,
    eta,
    metadata,
    overallEta,
    overallTransferredBytes,
    progress,
    senderDeviceName,
    setReceiverSnapshot,
    state,
    totalBytes,
    totalFiles,
  ]);

  const receiverSessionService = createReceiverSessionService({
    connect: async (nextCode: string) => {
      if (nextCode !== code) {
        setCode(nextCode);
        return;
      }
      await handleConnect();
    },
    acceptTransfer,
    resumeTransfer,
    resetReceiverSession: reset,
    getReceiverSessionSnapshot: () => useTransferStore.getState().receiver,
  });

  return (
    <ReceiverUI
      state={state}
      code={code}
      inputRef={inputRef}
      isMobileDevice={isMobileDevice}
      onCodeChange={(value) => setCode(value.replace(/[^0-9]/g, '').slice(0, 4))}
      onDigitClick={handleDigitClick}
      onPasteFromClipboard={handlePasteFromClipboard}
      onBackspace={handleBackspace}
      onClear={handleClear}
      connectingStage={connectingStage}
      onReset={receiverSessionService.resetReceiverSession}
      metadata={metadata}
      senderDeviceName={senderDeviceName}
      isMultiFile={isMultiFile}
      primaryFileName={primaryFile?.name}
      canResume={canResume}
      isStreaming={isStreamingRef.current}
      onResumeTransfer={receiverSessionService.resumeTransfer}
      onAcceptTransfer={receiverSessionService.acceptTransfer}
      progress={progress}
      downloadSpeed={downloadSpeed}
      eta={eta}
      overallTransferredBytes={overallTransferredBytes}
      totalBytes={totalBytes}
      overallEta={overallEta}
      errorMsg={errorMsg}
      onRetry={handleRetry}
    />
  );
};
