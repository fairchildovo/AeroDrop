import React, { useState, useEffect, useRef } from 'react';
import Peer, { DataConnection } from 'peerjs';

import streamSaver from 'streamsaver';
streamSaver.mitm = '/mitm.html';
import { TransferState, FileMetadata, P2PMessage, FileCompletePayload, P2P_PROTOCOL_VERSION } from '../types';
import { formatFileSize } from '../services/fileUtils';
import { createCrc32Hasher, Crc32Hasher } from '../services/crc32WorkerClient';
import { getIceConfig, prefetchIceConfig } from '../services/stunService';
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

export const Receiver: React.FC<ReceiverProps> = ({ initialCode, onNotification, deviceName }) => {
  const INITIAL_TIMEOUT_MS = 8000;
  const RELAY_TIMEOUT_MS = 15000;
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
  const currentIcePolicyRef = useRef<RTCIceTransportPolicy>('all');
  const relayPeerRef = useRef<Peer | null>(null);
  const relayConnRef = useRef<DataConnection | null>(null);
  const happyEyeballsWonRef = useRef(false);
  const p2pTimeoutRetryCountRef = useRef(0);

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const isMobileDevice = /android|iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const metadataRef = useRef<FileMetadata | null>(null);
  const currentFileIndexRef = useRef<number>(0); 
  const completedFileIndicesRef = useRef<Set<number>>(new Set());
  const isTransferActiveRef = useRef<boolean>(false);

  const chunksRef = useRef<ArrayBuffer[]>([]);
  const receivedChunksCountRef = useRef<number>(0);
  const receivedSizeRef = useRef<number>(0);
  const currentFileSizeRef = useRef<number>(0);
  const fileHasherRef = useRef<Crc32Hasher | null>(null);
  const hashedBytesRef = useRef<number>(0);
  const fileRepairAttemptsRef = useRef<Map<number, number>>(new Map());
  const pendingAutoRepairFileRef = useRef<number | null>(null);
  
  const isStreamingRef = useRef<boolean>(false);
  const nativeWriterRef = useRef<FileSystemWritableFileStream | null>(null);
  const streamSaverWriterRef = useRef<WritableStreamDefaultWriter | null>(null);
  const preparedNativeWriterFileIndexRef = useRef<number | null>(null);

  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const writeBufferRef = useRef<Uint8Array[]>([]);
  const writeBufferSizeRef = useRef<number>(0);
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
    prefetchIceConfig();
    pruneStaleIndexedDbSessions().catch(() => {});
    return () => {
      isMountedRef.current = false;
      clearConnectionTimeout();
      clearHeartbeatTimer();
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

  const abortStreams = async () => {
      try {
          if (nativeWriterRef.current) {
              try { await nativeWriterRef.current.truncate(0); } catch {}
              await nativeWriterRef.current.close();
              nativeWriterRef.current = null;
          }
          if (streamSaverWriterRef.current) { await streamSaverWriterRef.current.abort(); streamSaverWriterRef.current = null; }
          isStreamingRef.current = false;
      } catch (e) { console.warn("Stream abort warning:", e); }
      resetIndexedDbBufferRuntime();
  };

  const closeStreams = async (options?: {
      truncateNativeBeforeClose?: boolean;
      abortStreamSaver?: boolean;
  }): Promise<boolean> => {
      const truncateNativeBeforeClose = options?.truncateNativeBeforeClose === true;
      const abortStreamSaver = options?.abortStreamSaver === true;
      const closeWithTimeout = async (task: Promise<void>, timeoutMs: number, label: string) => {
          return Promise.race<void>([
              task,
              new Promise<void>((_, reject) => {
                  window.setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), timeoutMs);
              })
          ]);
      };
      let ok = true;
      try {
          if (nativeWriterRef.current) {
              if (truncateNativeBeforeClose) {
                  try {
                      await closeWithTimeout(nativeWriterRef.current.truncate(0), 12000, 'NATIVE_WRITER_TRUNCATE');
                  } catch (e) {
                      ok = false;
                      console.warn("Native writer truncate warning:", e);
                  }
              }
              await closeWithTimeout(nativeWriterRef.current.close(), 12000, 'NATIVE_WRITER_CLOSE');
              nativeWriterRef.current = null;
          }
          if (streamSaverWriterRef.current) {
              if (abortStreamSaver) {
                  await closeWithTimeout(streamSaverWriterRef.current.abort(), 12000, 'STREAM_SAVER_ABORT');
              } else {
                  await closeWithTimeout(streamSaverWriterRef.current.close(), 12000, 'STREAM_SAVER_CLOSE');
              }
              streamSaverWriterRef.current = null;
          }
          isStreamingRef.current = false;
          return ok;
      } catch (e) {
          console.warn("Stream close warning:", e);
      }
      return false;
  };

  const prepareNativeWriterForSingleFile = async (targetFileIndex: number): Promise<boolean> => {
    if (isIOS || isSafari) return false;
    if (!window.showSaveFilePicker) return false;
    const meta = metadataRef.current;
    if (!meta || meta.files.length !== 1) return false;
    const info = meta.files[targetFileIndex];
    if (!info) return false;

    const ext = (() => {
      const dot = info.name.lastIndexOf('.');
      return dot > -1 ? info.name.slice(dot).toLowerCase() : '';
    })();

    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: sanitizeFileName(info.name),
        types: ext
          ? [{ description: '文件', accept: { [info.type || 'application/octet-stream']: [ext] } }]
          : undefined,
        excludeAcceptAllOption: false,
      });
      const writable = await handle.createWritable();
      nativeWriterRef.current = writable;
      isStreamingRef.current = true;
      preparedNativeWriterFileIndexRef.current = targetFileIndex;
      return true;
    } catch {
      return false;
    }
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
      if (!isStreamingRef.current) return;

      try {
          const combined = new Uint8Array(totalLen);
          let offset = 0;
          for (const chunk of batch) {
              combined.set(chunk, offset);
              offset += chunk.byteLength;
          }

          if (nativeWriterRef.current) {
              await nativeWriterRef.current.write(combined);
          } else if (streamSaverWriterRef.current) {
              await streamSaverWriterRef.current.write(combined);
          }
      } catch (err) {
          console.error("Write Error:", err);
          const closeOk = await closeStreams({
              truncateNativeBeforeClose: true,
              abortStreamSaver: true,
          });
          if (!closeOk) {
              await abortStreams();
          }
          setErrorMsg("写入文件失败，磁盘可能已满或权限不足。");
          setState(TransferState.ERROR);
          if (connRef.current) connRef.current.close();
      }
  };

  const failTransferPersistence = (message: string) => {
      isTransferActiveRef.current = false;
      pendingAutoRepairFileRef.current = null;
      setErrorMsg(message);
      setState(TransferState.ERROR);
      abortStreams().catch(() => {});
      if (connRef.current?.open) {
        try { connRef.current.send({ type: 'TRANSFER_CANCELLED', payload: { reason: message } }); } catch {}
        try { connRef.current.close(); } catch {}
      }
  };

  const requestFileAutoRepair = async (fileIndex: number, reason: string): Promise<boolean> => {
      const attempt = (fileRepairAttemptsRef.current.get(fileIndex) || 0) + 1;
      fileRepairAttemptsRef.current.set(fileIndex, attempt);

      if (attempt > MAX_AUTO_REPAIR_RETRIES_PER_FILE) {
          failTransferPersistence(`文件自动修复失败（已重试 ${MAX_AUTO_REPAIR_RETRIES_PER_FILE} 次）：${reason}`);
          return false;
      }

      pendingAutoRepairFileRef.current = fileIndex;
      setProgress(0);
      setDownloadSpeed('0 KB/s');
      setDownloadSpeedBytes(0);
      setEta('自动修复中...');

      chunksRef.current = [];
      writeBufferRef.current = [];
      writeBufferSizeRef.current = 0;
      resetIndexedDbBufferRuntime();
      indexedDbChunkSeqRef.current = 0;
      indexedDbBufferedBytesRef.current = 0;
      indexedDbBufferedFileIndexRef.current = fileIndex;
      receivedChunksCountRef.current = 0;
      receivedSizeRef.current = 0;
      try {
        await getFileHasher().reset();
      } catch {
        failTransferPersistence("文件校验初始化失败，请重试传输。");
        return false;
      }
      hashedBytesRef.current = 0;

      await abortStreams();
      try {
        await writeQueueRef.current;
        await deleteIndexedDbChunksForFile(fileIndex);
      } catch (e) {
        console.warn('IndexedDB cleanup before repair failed:', e);
      }

      const conn = connRef.current;
      if (!conn || !conn.open) {
          failTransferPersistence("连接已断开，无法自动修复，请重试。");
          return false;
      }

      try {
          conn.send({
            type: 'RESUME_REQUEST',
            payload: {
              fileIndex,
              byteOffset: 0,
              silent: true
            }
          });
      } catch {
          failTransferPersistence("自动修复请求发送失败，请重试。");
          return false;
      }

      return true;
  };

  const setupConnListeners = (conn: DataConnection) => {
    let reconnectScheduled = false;
    const scheduleFastReconnect = () => {
      if (reconnectScheduled) return true;
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
        setupConnListeners(nextConn);
      }, delay);
      return true;
    };

    connRef.current = conn;
    conn.on('open', () => {
      clearConnectionTimeout();
      retryCountRef.current = 0;

      // Happy-eyeballs: if a parallel attempt already won, discard this one.
      if (happyEyeballsWonRef.current && connRef.current !== conn) {
        try { conn.close(); } catch {}
        return;
      }
      happyEyeballsWonRef.current = true;
      connRef.current = conn;

      // Tear down the losing parallel peer (if any).
      cleanupLosingPeer(conn);

      markConnectionSuccess(connectTelemetryRef.current, { peerId: conn.peer });
      setConnectingStage('waiting_response');
      conn.send({
        type: 'DEVICE_INFO',
        payload: {
          deviceName: localDeviceNameRef.current,
          sessionId: receiverSessionIdRef.current
        }
      });
      clearHeartbeatTimer();
      heartbeatTimerRef.current = window.setInterval(() => {
        if (!conn.open) return;
        try {
          conn.send({ type: 'HEARTBEAT', payload: { t: Date.now() } });
        } catch {
          // Ignore heartbeat failures; close/error path handles reconnect.
        }
      }, 2500);

      const pc = conn.peerConnection;
      if (pc) {
        collectIceRouteWithRetry(pc).then((route) => {
          attachIceRouteToSession(connectTelemetryRef.current, route);
        });
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
                 writeBufferRef.current.push(new Uint8Array(chunkData));
                 writeBufferSizeRef.current += byteLength;

                 if (writeBufferSizeRef.current >= BUFFER_FLUSH_THRESHOLD) {
                     const batch = writeBufferRef.current;
                     const batchSize = writeBufferSizeRef.current;

                     writeBufferRef.current = [];
                     writeBufferSizeRef.current = 0;

                      writeQueueRef.current = writeQueueRef.current.then(() => flushSpecificBatch(batch, batchSize));
                  }
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
        isTransferActiveRef.current = true;
        const { fileSize, fileIndex } = msg.payload;
        const fileName = sanitizeFileName(msg.payload.fileName || `file_${Date.now()}`);

        const shouldUseIndexedDbBuffering =
          (isIOS || isSafari) &&
          fileSize >= IOS_IDB_BUFFER_THRESHOLD_BYTES &&
          isIndexedDbSupported();
        isIndexedDbBufferingRef.current = shouldUseIndexedDbBuffering;

        if (shouldUseIndexedDbBuffering && !indexedDbNotifiedRef.current && onNotification) {
          indexedDbNotifiedRef.current = true;
          onNotification('iOS 大文件已启用 IndexedDB 缓冲模式', 'info');
        }

        const hasIndexedDbBufferedData =
          isIndexedDbBufferingRef.current &&
          indexedDbBufferedFileIndexRef.current === fileIndex &&
          indexedDbBufferedBytesRef.current > 0;

        const resumingSameFile =
          currentFileIndexRef.current === fileIndex &&
          (chunksRef.current.length > 0 || hasIndexedDbBufferedData);
        const usePreparedNativeWriter =
          preparedNativeWriterFileIndexRef.current === fileIndex && !!nativeWriterRef.current;

        if (!resumingSameFile) {
            if (!usePreparedNativeWriter) {
              await abortStreams();
            }
            chunksRef.current = [];
            writeBufferRef.current = [];
            writeBufferSizeRef.current = 0;
            resetIndexedDbBufferRuntime();
            indexedDbChunkSeqRef.current = 0;
            indexedDbBufferedBytesRef.current = 0;
            indexedDbBufferedFileIndexRef.current = fileIndex;
            receivedChunksCountRef.current = 0;
            receivedSizeRef.current = 0;

            if (isIndexedDbBufferingRef.current) {
              try {
                await writeQueueRef.current;
                await deleteIndexedDbChunksForFile(fileIndex);
              } catch (e) {
                failTransferPersistence('无法初始化 iOS 大文件缓存，请重试。');
                return;
              }
            }

            if (usePreparedNativeWriter) {
                isStreamingRef.current = true;
                preparedNativeWriterFileIndexRef.current = null;
            } else if (!nativeWriterRef.current) {
                if (isIndexedDbBufferingRef.current || isIOS || isSafari) {
                    isStreamingRef.current = false;
                } else if (streamSaver) {
                     try {
                         const streamPathname =
                           `${STREAMSAVER_PATH_PREFIX}${Date.now().toString(36)}-` +
                           `${Math.random().toString(36).slice(2, 8)}/${encodeURIComponent(fileName)}`;
                         const fileStream = streamSaver.createWriteStream(fileName, {
                           size: fileSize,
                           pathname: streamPathname,
                         });
                         streamSaverWriterRef.current = fileStream.getWriter();
                         isStreamingRef.current = true;
                     } catch {
                         // Fallback to browser default save flow when stream writer is unavailable.
                         isStreamingRef.current = false;
                     }
                } else {
                    isStreamingRef.current = false;
                }
            } else {
                isStreamingRef.current = true;
            }
        }
        
        currentFileSizeRef.current = fileSize;
        currentFileIndexRef.current = fileIndex;
        if (pendingAutoRepairFileRef.current === fileIndex) {
          pendingAutoRepairFileRef.current = null;
        }
        try {
          await getFileHasher().reset();
        } catch {
          failTransferPersistence('文件校验初始化失败，请重试。');
          return;
        }
        hashedBytesRef.current = 0;
        
        lastSpeedUpdateRef.current = Date.now();
        lastSpeedBytesRef.current = receivedSizeRef.current;
        lastReportedSpeedBytesRef.current = 0;
        
        setCurrentFileName(fileName);
        setCurrentFileIndex(fileIndex + 1);
        setProgress(0);
        setEta('计算中...');
        setDownloadSpeed('0 KB/s');
        sendTransferProgress(0);
      }
      else if (msg.type === 'FILE_COMPLETE') {
         if (!isTransferActiveRef.current) return;
         if (receivedSizeRef.current !== currentFileSizeRef.current) {
             const repaired = await requestFileAutoRepair(
               currentFileIndexRef.current,
               `文件长度不一致（${receivedSizeRef.current}/${currentFileSizeRef.current}）`
             );
             if (!repaired) return;
             return;
         }
         const completePayload = (msg.payload || {}) as FileCompletePayload;
         if (completePayload.hashAlgorithm === 'crc32' && typeof completePayload.fileHash === 'string') {
             const expectedBytes = typeof completePayload.hashedBytes === 'number'
               ? Math.max(0, completePayload.hashedBytes)
               : hashedBytesRef.current;
             if (hashedBytesRef.current !== expectedBytes) {
                const repaired = await requestFileAutoRepair(currentFileIndexRef.current, `字节数不一致（${hashedBytesRef.current}/${expectedBytes}）`);
                if (!repaired) return;
                return;
             }
              let actualHash = '';
              try {
                actualHash = await getFileHasher().finalizeHex();
              } catch {
                failTransferPersistence('文件校验计算失败，请重试。');
                return;
              }
              if (actualHash !== completePayload.fileHash.toLowerCase()) {
                 const repaired = await requestFileAutoRepair(currentFileIndexRef.current, `哈希不一致（${actualHash} != ${completePayload.fileHash}）`);
                 if (!repaired) return;
                 return;
             }
         }

         if (isStreamingRef.current || isIndexedDbBufferingRef.current) {
              if (isIndexedDbBufferingRef.current) {
                  const finalBatch = indexedDbBatchRef.current;
                  const finalSize = indexedDbBatchBytesRef.current;
                  indexedDbBatchRef.current = [];
                  indexedDbBatchBytesRef.current = 0;

                  writeQueueRef.current = writeQueueRef.current.then(async () => {
                      if (finalSize > 0) await flushIndexedDbBatch(currentFileIndexRef.current, finalBatch, finalSize);
                  }).catch(e => console.error("IndexedDB final batch flush error", e));
              }

              const finalBatch = writeBufferRef.current;
              const finalSize = writeBufferSizeRef.current;
              writeBufferRef.current = [];
              writeBufferSizeRef.current = 0;

              writeQueueRef.current = writeQueueRef.current.then(async () => {
                  if (finalSize > 0) await flushSpecificBatch(finalBatch, finalSize);
                  if (isStreamingRef.current) {
                    const closeOk = await closeStreams();
                    if (!closeOk) {
                       failTransferPersistence("文件落盘失败，请重试。");
                       return;
                    }
                  }

                  if (isTransferActiveRef.current) {
                     if (isIndexedDbBufferingRef.current) {
                       if (await saveCurrentFile()) {
                         completedFileIndicesRef.current.add(currentFileIndexRef.current);
                         fileRepairAttemptsRef.current.delete(currentFileIndexRef.current);
                         sendTransferProgress(lastReportedSpeedBytesRef.current);
                         if (onNotification) onNotification(`文件 ${currentFileName} 已保存`, 'success');
                       }
                     } else {
                       completedFileIndicesRef.current.add(currentFileIndexRef.current);
                       fileRepairAttemptsRef.current.delete(currentFileIndexRef.current);
                       sendTransferProgress(lastReportedSpeedBytesRef.current);
                       if (onNotification) onNotification(`文件 ${currentFileName} 已保存`, 'success');
                     }
                  }
              }).catch(e => console.error("File Complete Error", e));

              await writeQueueRef.current;
          } else {
              if (!await saveCurrentFile()) {
                return;
              }
              completedFileIndicesRef.current.add(currentFileIndexRef.current);
              fileRepairAttemptsRef.current.delete(currentFileIndexRef.current);
              sendTransferProgress(lastReportedSpeedBytesRef.current);
              if (onNotification) onNotification(`文件 ${currentFileName} 已保存`, 'success');
           }
      }
      else if (msg.type === 'ALL_FILES_COMPLETE') {
         if (!isTransferActiveRef.current) return;
         if (pendingAutoRepairFileRef.current !== null) return;
         await writeQueueRef.current;
         const expectedFiles = metadataRef.current?.files?.length ?? 0;
         const savedFiles = completedFileIndicesRef.current.size;
         if (expectedFiles > 0 && savedFiles < expectedFiles) {
           failTransferPersistence(`文件保存不完整（${savedFiles}/${expectedFiles}），请重试。`);
           return;
         }
         sendTransferProgress(0);
         try {
           conn.send({ type: 'ALL_FILES_RECEIVED' });
         } catch {
           // Ignore ack send failures; sender has heartbeat/close fallback.
         }
         setState(TransferState.COMPLETED);
         if (onNotification) onNotification("所有文件接收完毕", 'success');
         resetStateForNewTransfer();
         isTransferActiveRef.current = false; 
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
    });

    conn.on('close', () => {
       // Ignore close events from the losing happy-eyeballs connection.
       if (happyEyeballsWonRef.current && connRef.current !== conn) return;
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
           setErrorMsg("连接已断开");
           setState(TransferState.ERROR);
       }
    });

    conn.on('error', () => {
      // Ignore error events from the losing happy-eyeballs connection.
      if (happyEyeballsWonRef.current && connRef.current !== conn) return;
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
      writeBufferRef.current = [];
      writeBufferSizeRef.current = 0;
      resetIndexedDbFileState();
      receivedChunksCountRef.current = 0;
      receivedSizeRef.current = 0;
      hashedBytesRef.current = 0;
      completedFileIndicesRef.current.clear();
      currentFileIndexRef.current = 0;
      setDownloadSpeed('0 KB/s');
      setDownloadSpeedBytes(0);
      lastReportedSpeedBytesRef.current = 0;
      fileRepairAttemptsRef.current.clear();
      pendingAutoRepairFileRef.current = null;
      setEta('--');
      preparedNativeWriterFileIndexRef.current = null;
      writeQueueRef.current = Promise.resolve();
  };

  const saveFileForIOS = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);

    const downloadModal = document.createElement('div');
    downloadModal.id = 'ios-download-modal';
    downloadModal.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.8); z-index: 99999;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 20px;
    `;

    const contentDiv = document.createElement('div');
    contentDiv.style.cssText = 'background: white; padding: 24px; border-radius: 16px; max-width: 320px; text-align: center;';

    const title = document.createElement('h3');
    title.style.cssText = 'margin: 0 0 12px; font-size: 18px; color: #1e293b;';
    title.textContent = '文件已准备就绪';

    const fileNameP = document.createElement('p');
    fileNameP.style.cssText = 'margin: 0 0 20px; font-size: 14px; color: #64748b; word-break: break-all;';
    fileNameP.textContent = fileName;

    const downloadLink = document.createElement('a');
    downloadLink.href = url;
    downloadLink.download = fileName;
    downloadLink.style.cssText = 'display: block; background: #3b82f6; color: white; padding: 14px 24px; border-radius: 12px; text-decoration: none; font-weight: 600; font-size: 16px;';
    downloadLink.textContent = '点击保存文件';
    downloadLink.onclick = () => {
      setTimeout(() => downloadModal.remove(), 500);
      scheduleBlobUrlRevokeAfterFocus(url, { fallbackMs: 10 * 60 * 1000, focusDelayMs: 5000 });
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.style.cssText = 'margin-top: 12px; background: none; border: none; color: #64748b; font-size: 14px; cursor: pointer;';
    cancelBtn.textContent = '取消';
    cancelBtn.onclick = () => {
      downloadModal.remove();
      URL.revokeObjectURL(url);
    };

    contentDiv.appendChild(title);
    contentDiv.appendChild(fileNameP);
    contentDiv.appendChild(downloadLink);
    contentDiv.appendChild(cancelBtn);
    downloadModal.appendChild(contentDiv);
    document.body.appendChild(downloadModal);
  };

  const scheduleBlobUrlRevokeAfterFocus = (url: string, opts?: { fallbackMs?: number; focusDelayMs?: number }) => {
      const fallbackMs = opts?.fallbackMs ?? 5 * 60 * 1000;
      const focusDelayMs = opts?.focusDelayMs ?? 4000;
      let revoked = false;
      let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
      let focusDelayTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanupListener = () => {
          window.removeEventListener('focus', onFocus);
      };

      const revokeNow = () => {
          if (revoked) return;
          revoked = true;
          cleanupListener();
          if (fallbackTimer) {
              clearTimeout(fallbackTimer);
              fallbackTimer = null;
          }
          if (focusDelayTimer) {
              clearTimeout(focusDelayTimer);
              focusDelayTimer = null;
          }
          URL.revokeObjectURL(url);
      };

      const onFocus = () => {
          if (revoked) return;
          if (focusDelayTimer) clearTimeout(focusDelayTimer);
          focusDelayTimer = setTimeout(() => {
              revokeNow();
          }, focusDelayMs);
      };

      window.addEventListener('focus', onFocus);
      fallbackTimer = setTimeout(() => {
          revokeNow();
      }, fallbackMs);
  };

  const saveCurrentFile = async (): Promise<boolean> => {
      if (!isTransferActiveRef.current) return false;
      if (receivedSizeRef.current === 0 && currentFileSizeRef.current > 0) return false;

      let finalName = `file_${Date.now()}.bin`;
      let finalType = 'application/octet-stream';
      if (metadataRef.current && metadataRef.current.files[currentFileIndexRef.current]) {
          finalName = metadataRef.current.files[currentFileIndexRef.current].name;
          finalType = metadataRef.current.files[currentFileIndexRef.current].type;
      }
      try {
          let blob: Blob;
          if (isIndexedDbBufferingRef.current) {
              const fileIndex = currentFileIndexRef.current;
              const blobs = await readIndexedDbBlobsForFile(fileIndex);
              if (blobs.length === 0 && currentFileSizeRef.current > 0) {
                failTransferPersistence("iOS 缓冲文件为空，请重试传输。");
                return false;
              }
              blob = new Blob(blobs, { type: finalType });
          } else {
              blob = new Blob(chunksRef.current, { type: finalType });
          }

          if (isIOS || isSafari) {
              saveFileForIOS(blob, finalName);
          } else {
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url; a.download = finalName;
              document.body.appendChild(a); a.click(); document.body.removeChild(a);
              scheduleBlobUrlRevokeAfterFocus(url);
          }

      } catch (e) {
          console.error("Save failed:", e);
          failTransferPersistence("浏览器保存失败，请检查下载权限后重试。");
          return false;
      }
      if (isIndexedDbBufferingRef.current) {
          try {
              await deleteIndexedDbChunksForFile(currentFileIndexRef.current);
          } catch (e) {
              console.warn('IndexedDB cleanup after save failed:', e);
          }
          indexedDbBufferedBytesRef.current = 0;
          indexedDbChunkSeqRef.current = 0;
          indexedDbBufferedFileIndexRef.current = null;
          resetIndexedDbBufferRuntime();
      }
      chunksRef.current = [];
      receivedChunksCountRef.current = 0;
      receivedSizeRef.current = 0;
      return true;
  };

  const handleConnect = async () => {
    if (!code || code.length !== 4) return;
    connectTelemetryRef.current = createConnectionSession('receiver', { code });
    setState(TransferState.WAITING_FOR_PEER);
    setConnectingStage('fetching_ice');
    setErrorMsg('');
    retryCountRef.current = 0;
    happyEyeballsWonRef.current = false;
    startConnectionAttempt(connectTelemetryRef.current, 'initial_connect');

    if (peerRef.current) peerRef.current.destroy();
    if (relayPeerRef.current) { try { relayPeerRef.current.destroy(); } catch {} relayPeerRef.current = null; }

    const iceConfig = await getIceConfig();
    markIceConfigFetched(connectTelemetryRef.current);
    setConnectingStage('connecting_signaling');
    hasTurnRef.current = iceConfig.hasTurn;
    p2pTimeoutRetryCountRef.current = 0;

    const applyConnectTimeout = (timeoutMs: number) => {
      clearConnectionTimeout();
      connectionTimeoutRef.current = setTimeout(() => {
        connectionTimeoutRef.current = null;

        // If happy-eyeballs already connected, ignore the timeout.
        if (happyEyeballsWonRef.current) return;

        if (hasTurnRef.current && currentIcePolicyRef.current !== 'relay') {
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
        if (peerRef.current) peerRef.current.destroy();
        if (relayPeerRef.current) { try { relayPeerRef.current.destroy(); } catch {} relayPeerRef.current = null; }
        markConnectionFailure(connectTelemetryRef.current, 'connect_timeout', { timeoutMs });
        setErrorMsg("连接超时。请检查口令是否正确。");
        setState(TransferState.ERROR);
      }, timeoutMs);
    };

    const createAndConnectPeer = (policy: RTCIceTransportPolicy, timeoutMs: number) => {
      currentIcePolicyRef.current = policy;

      // For relay fallback via happy-eyeballs, keep the P2P peer alive.
      if (policy !== 'relay' && peerRef.current && !peerRef.current.destroyed) {
        peerRef.current.destroy();
      }

      const peer = new Peer({
        debug: peerDebugLevel,
        pingInterval: 5000,
        config: {
          iceServers: iceConfig.iceServers,
          iceCandidatePoolSize: iceConfig.iceCandidatePoolSize,
          iceTransportPolicy: policy,
        }
      });

      peer.on('open', () => {
        if (happyEyeballsWonRef.current) { peer.destroy(); return; }
        markSignalingOpen(connectTelemetryRef.current);
        setConnectingStage('connecting_peer');
        markSessionEvent(connectTelemetryRef.current, 'peer_open', { iceTransportPolicy: policy });
        const conn = peer.connect(`aerodrop-${code}`, { serialization: 'binary' });
        if (policy === 'relay') {
          relayConnRef.current = conn;
        }
        setupConnListeners(conn);
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
              setupConnListeners(conn);
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

    // Start P2P attempt.
    createAndConnectPeer(iceConfig.hasTurn ? 'all' : iceConfig.iceTransportPolicy, INITIAL_TIMEOUT_MS);

    // Happy-eyeballs: launch relay attempt in parallel after a short delay.
    if (iceConfig.hasTurn) {
      window.setTimeout(() => {
        if (happyEyeballsWonRef.current) return;
        if (stateRef.current !== TransferState.WAITING_FOR_PEER) return;
        markSessionEvent(connectTelemetryRef.current, 'happy_eyeballs_relay_start');
        startConnectionAttempt(connectTelemetryRef.current, 'relay_parallel');
        createAndConnectPeer('relay', RELAY_TIMEOUT_MS);
      }, 3000);
    }
  };

  const acceptTransfer = async () => {
    if (connRef.current?.open) {
      resetStateForNewTransfer();
      isTransferActiveRef.current = true;
      // Default to browser-managed download behavior; do not force a save-path picker on accept.
      preparedNativeWriterFileIndexRef.current = null;

      if (isIOS || isSafari) {
          isStreamingRef.current = false;
          if (onNotification) onNotification("iOS 模式：文件将在传输完成后保存", 'info');
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
      if (connRef.current?.open) {
          isTransferActiveRef.current = true;
          const currentIdx = currentFileIndexRef.current;
          const byteOffset = Math.max(0, receivedSizeRef.current);

          isStreamingRef.current = false;
          preparedNativeWriterFileIndexRef.current = null;

          if (completedFileIndicesRef.current.has(currentIdx)) {
              connRef.current.send({ type: 'RESUME_REQUEST', payload: { fileIndex: currentIdx + 1, byteOffset: 0 } });
          } else {
              connRef.current.send({ type: 'RESUME_REQUEST', payload: { fileIndex: currentIdx, byteOffset } });
          }
          setState(TransferState.TRANSFERRING);
      } else {
          setErrorMsg("连接已断开，请重新连接发送方。");
          setState(TransferState.ERROR);
          if (onNotification) onNotification("连接已断开，请重试", 'error');
      }
  };

  const reset = () => {
    isStreamingRef.current = false;
    isTransferActiveRef.current = false;
    happyEyeballsWonRef.current = false;
    clearConnectionTimeout();
    clearHeartbeatTimer();
    
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
        resetStateForNewTransfer();
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
      onReset={reset}
      metadata={metadata}
      senderDeviceName={senderDeviceName}
      isMultiFile={isMultiFile}
      primaryFileName={primaryFile?.name}
      canResume={canResume}
      isStreaming={isStreamingRef.current}
      onResumeTransfer={resumeTransfer}
      onAcceptTransfer={acceptTransfer}
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
