import React, { useState, useEffect, useRef, useCallback } from 'react';
import Peer, { DataConnection } from 'peerjs';
import { TransferState, FileMetadata, P2PMessage, FileStartPayload, FileCompletePayload, ResumePayload, P2P_PROTOCOL_VERSION } from '../types';
import { formatFileSize, generatePreview, generateFileFingerprint } from '../services/fileUtils';
import { createCrc32Hasher } from '../services/crc32WorkerClient';
import { getIceConfig, prefetchIceConfig } from '../services/stunService';
import { TRANSFER_CONFIG, FLOW_CONTROL } from '../constants/transfer'; 
import {
  attachIceRouteToSession,
  collectIceRouteWithRetry,
  ConnectionSession,
  createConnectionSession,
  markConnectionFailure,
  markConnectionSuccess,
  markIceConfigFetched,
  markSignalingOpen,
  markSessionEvent,
  startConnectionAttempt,
} from '../services/connectionTelemetry';
import { SenderUI } from './sender/SenderUI';

interface SenderProps {
  onNotification: (msg: string, type: 'success' | 'info' | 'error') => void;
  deviceName: string;
}

type PeerTransferStat = {
  peerId: string;
  deviceName: string;
  connectionType: '直连' | '点对点' | '中继（速度会变慢）' | '检测中';
  speed: string;
  progress: number;
  status: 'waiting' | 'transferring' | 'completed';
};

type ConnectionRoute = {
  isLan: boolean;
  isRelay: boolean;
  protocol: string;
};

type ConnectionMetrics = {
  rttMs: number | null;
  lossPct: number | null;
  availableOutgoingBitrate: number | null;
};

type AdaptiveFlowProfile = {
  chunkSize: number;
  highWaterMark: number;
  lowWaterMark: number;
  lastUpdatedAt: number;
  metrics: ConnectionMetrics;
};

export const Sender: React.FC<SenderProps> = ({ onNotification, deviceName }) => {
  type PreparingStage = 'fetching_ice' | 'connecting_signaling';
  const [state, setState] = useState<TransferState>(TransferState.IDLE);
  const [fileList, setFileList] = useState<File[]>([]);
  const [metadata, setMetadata] = useState<FileMetadata | null>(null);
  const [transferCode, setTransferCode] = useState<string>('');
  const [customCodeInput, setCustomCodeInput] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');
  
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [totalProgress, setTotalProgress] = useState(0);
  const [currentSpeed, setCurrentSpeed] = useState<string>('0 KB/s');
  const [avgSpeed, setAvgSpeed] = useState<string>('0 KB/s');
  const [currentSpeedBytes, setCurrentSpeedBytes] = useState(0);
  const [avgSpeedBytes, setAvgSpeedBytes] = useState(0);
  
  const [individualStats, setIndividualStats] = useState<PeerTransferStat[]>([]);

  const [isDragOver, setIsDragOver] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<string>('');
  const [showFileList, setShowFileList] = useState(false);
  const [peerNames, setPeerNames] = useState<Record<string, string>>({});

  const [expiryOption, setExpiryOption] = useState<string>('1h');
  const [remainingTime, setRemainingTime] = useState<string>('');

  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [preparingStage, setPreparingStage] = useState<PreparingStage>('fetching_ice');

  const peerRef = useRef<Peer | null>(null);
  const activeConnections = useRef<Set<DataConnection>>(new Set());
  const isDestroyingRef = useRef(false);
  const isMountedRef = useRef(true);

  const transferSessionId = useRef<number>(0);
  const activeTransfersCount = useRef<number>(0);
  const activeSendingPeersRef = useRef<Set<string>>(new Set());
  const peerSessionIdsRef = useRef<Map<string, string>>(new Map());
  const sessionToPeerRef = useRef<Map<string, string>>(new Map());
  const ghostCandidateSinceRef = useRef<Map<string, number>>(new Map());
  const peerConnectionTypeRef = useRef<Map<string, PeerTransferStat['connectionType']>>(new Map());
  const peerHeartbeatAtRef = useRef<Map<string, number>>(new Map());
  const peerAwaitingFinalizeAckRef = useRef<Set<string>>(new Set());
  const peerHasProgressSyncRef = useRef<Set<string>>(new Set());
  const peerTransferredBytesRef = useRef<Map<string, number>>(new Map());
  const peerTotalBytesRef = useRef<Map<string, number>>(new Map());
  const peerSyncStartAtRef = useRef<Map<string, number>>(new Map());
  const peerSyncBaseBytesRef = useRef<Map<string, number>>(new Map());
  const peerTransferEpochRef = useRef<Map<string, number>>(new Map());
  const pendingSendPeersRef = useRef<Set<string>>(new Set());

  const peerProgress = useRef<Map<string, number>>(new Map());
  const peerRealtimeSpeed = useRef<Map<string, number>>(new Map());
  const peerAverageSpeed = useRef<Map<string, number>>(new Map());

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileListRef = useRef<File[]>([]);
  const lastConnectionStatsPollRef = useRef<number>(0);
  const peerDebugLevel = import.meta.env.DEV ? 1 : 0;
  const shareTelemetryRef = useRef<ConnectionSession | null>(null);
  const localDeviceNameRef = useRef<string>(deviceName);
  const peerNamesRef = useRef<Record<string, string>>(peerNames);
  const GHOST_SWEEP_INTERVAL_MS = 4000;
  const GHOST_GRACE_MS = 10000;
  const HEARTBEAT_TIMEOUT_MS = 30000;
  const HARD_HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;
  const SIGNALING_OPEN_TIMEOUT_MS = 10000;
  const MAX_SIGNALING_OPEN_RETRY = 1;
  const lastStatsPollIndexRef = useRef(0);
  const signalingOpenTimeoutRef = useRef<number | null>(null);

  const totalProgressRef = useRef(0);
  useEffect(() => {
    totalProgressRef.current = totalProgress;
  }, [totalProgress]);

  useEffect(() => {
    localDeviceNameRef.current = deviceName;
  }, [deviceName]);

  useEffect(() => {
    peerNamesRef.current = peerNames;
  }, [peerNames]);

  useEffect(() => {
    let interval: number;
    if (state === TransferState.TRANSFERRING || state === TransferState.PEER_CONNECTED) {
        interval = window.setInterval(() => {
            let totalSpeed = 0;
            let totalAvgSpeed = 0;
            let combinedProgress = 0;

            const stats: PeerTransferStat[] = Array.from(activeConnections.current).map((conn) => {
                const peerId = conn.peer;
                const progress = peerProgress.current.get(peerId) || 0;
                const realtimeSpeed = peerRealtimeSpeed.current.get(peerId) || 0;
                const avg = peerAverageSpeed.current.get(peerId) || 0;
                const hasTransferStarted = peerProgress.current.has(peerId) || activeSendingPeersRef.current.has(peerId);
                const waitingFinalizeAck = peerAwaitingFinalizeAckRef.current.has(peerId);

                const status: PeerTransferStat['status'] =
                    progress >= 100 && !waitingFinalizeAck ? 'completed' : hasTransferStarted && state === TransferState.TRANSFERRING ? 'transferring' : 'waiting';

                if (status === 'transferring' || status === 'completed') {
                    combinedProgress += progress;
                    totalSpeed += realtimeSpeed;
                    totalAvgSpeed += avg;
                }

                return {
                    peerId,
                    speed: status === 'transferring' ? `${formatFileSize(realtimeSpeed)}/s` : status === 'completed' ? '完成' : '--',
                    progress,
                    deviceName: peerNamesRef.current[peerId] || `设备 ...${peerId.slice(-4)}`,
                    connectionType: peerConnectionTypeRef.current.get(peerId) || '检测中',
                    status
                };
            });

            stats.sort((a, b) => {
                const order = { transferring: 0, waiting: 1, completed: 2 };
                const statusDiff = order[a.status] - order[b.status];
                if (statusDiff !== 0) return statusDiff;
                return a.deviceName.localeCompare(b.deviceName);
            });

            setIndividualStats(stats);

            if (state === TransferState.TRANSFERRING) {
                setCurrentSpeed(formatFileSize(totalSpeed) + '/s');
                setAvgSpeed(formatFileSize(totalAvgSpeed) + '/s');
                setCurrentSpeedBytes(totalSpeed);
                setAvgSpeedBytes(totalAvgSpeed);
                const activeProgressCount = stats.filter((s) => s.status !== 'waiting').length;

                if (activeProgressCount > 0) {
                    setTotalProgress(Math.floor(combinedProgress / activeProgressCount));
                } else {
                    if (activeTransfersCount.current === 0 && totalProgressRef.current === 100) {
                        
                    } else {
                        setTotalProgress(0);
                    }
                }
            }

            const now = Date.now();
            if (
              activeConnections.current.size > 0 &&
              now - lastConnectionStatsPollRef.current >= 3000
            ) {
              lastConnectionStatsPollRef.current = now;
              // Stagger: poll one connection per tick instead of all at once.
              const conns = Array.from(activeConnections.current);
              if (conns.length > 0) {
                const idx = lastStatsPollIndexRef.current % conns.length;
                lastStatsPollIndexRef.current = idx + 1;
                updateConnectionStats(conns[idx]);
              }
            }
        }, 800);
    }
    return () => clearInterval(interval);
  }, [state]);

  const updatePeerName = (peerId: string, name: string) => {
    const cleaned = name.trim().slice(0, 24);
    const finalName = cleaned || `设备 ...${peerId.slice(-4)}`;
    setPeerNames(prev => {
      if (prev[peerId] === finalName) {
        return prev;
      }
      return { ...prev, [peerId]: finalName };
    });
  };

  const removePeerName = (peerId: string) => {
    setPeerNames(prev => {
      if (!prev[peerId]) {
        return prev;
      }
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  };

  const updateConnectionStatusUI = () => {
    const count = activeConnections.current.size;
    if (count > 1) {
       setConnectionStatus(`已连接 ${count} 个设备`);
    } else if (count === 0) {
       setConnectionStatus('');
    }
  };

  const isPrivateIP = (ip: string) => {
      if (!ip) return false;
      const cleanIp = ip.replace(/^\[|\](:[0-9]+)?$/g, '').split(':')[0];

      if (cleanIp === '127.0.0.1' || cleanIp === '::1' || cleanIp.toLowerCase() === 'localhost') return true;

      if (cleanIp.toLowerCase().startsWith('fe80:')) return true;

      const parts = cleanIp.split('.');
      if (parts.length === 4) {
          const p0 = parseInt(parts[0], 10);
          const p1 = parseInt(parts[1], 10);

          if (p0 === 10) return true; 
          if (p0 === 172 && p1 >= 16 && p1 <= 31) return true; 
          if (p0 === 192 && p1 === 168) return true; 
      }

      return false;
  };

  const peerIsLAN = useRef<Map<string, boolean>>(new Map());
  const peerAdaptiveFlowRef = useRef<Map<string, AdaptiveFlowProfile>>(new Map());

  const toStep = (value: number, step = 16 * 1024) => {
    return Math.max(step, Math.round(value / step) * step);
  };

  const getBaseFlowByRoute = (route: ConnectionRoute) => {
    if (route.isLan) {
      return {
        chunkSize: TRANSFER_CONFIG.CHUNK_SIZE_LAN,
        highWaterMark: FLOW_CONTROL.HIGH_WATER_MARK_LAN,
        lowWaterMark: FLOW_CONTROL.LOW_WATER_MARK_LAN,
      };
    }
    if (route.isRelay) {
      return {
        chunkSize: TRANSFER_CONFIG.CHUNK_SIZE_RELAY,
        highWaterMark: FLOW_CONTROL.HIGH_WATER_MARK_RELAY,
        lowWaterMark: FLOW_CONTROL.LOW_WATER_MARK_RELAY,
      };
    }
    return {
      chunkSize: TRANSFER_CONFIG.CHUNK_SIZE_WAN,
      highWaterMark: FLOW_CONTROL.HIGH_WATER_MARK_WAN,
      lowWaterMark: FLOW_CONTROL.LOW_WATER_MARK_WAN,
    };
  };

  const deriveAdaptiveFlow = (route: ConnectionRoute, metrics: ConnectionMetrics) => {
    const base = getBaseFlowByRoute(route);
    let chunkSize = base.chunkSize;
    let highWaterMark = base.highWaterMark;
    let lowWaterMark = base.lowWaterMark;

    const rtt = metrics.rttMs ?? 0;
    const loss = metrics.lossPct ?? 0;
    const bitrate = metrics.availableOutgoingBitrate ?? 0;

    if (route.isLan) {
      if (loss > 1 || rtt > 80) {
        chunkSize = Math.max(128 * 1024, Math.floor(base.chunkSize / 2));
        highWaterMark = Math.max(8 * 1024 * 1024, Math.floor(base.highWaterMark * 0.75));
        lowWaterMark = Math.max(2 * 1024 * 1024, Math.floor(base.lowWaterMark * 0.75));
      } else if (loss < 0.2 && rtt > 0 && rtt < 25) {
        highWaterMark = Math.min(24 * 1024 * 1024, Math.floor(base.highWaterMark * 1.25));
        lowWaterMark = Math.min(6 * 1024 * 1024, Math.floor(base.lowWaterMark * 1.25));
      }
    } else if (route.isRelay) {
      if (loss > 4 || rtt > 350 || (bitrate > 0 && bitrate < 8_000_000)) {
        chunkSize = Math.max(32 * 1024, Math.floor(base.chunkSize / 2));
        highWaterMark = Math.max(1 * 1024 * 1024, Math.floor(base.highWaterMark * 0.6));
        lowWaterMark = Math.max(256 * 1024, Math.floor(base.lowWaterMark * 0.6));
      } else if (loss < 1 && rtt > 0 && rtt < 120 && bitrate > 20_000_000) {
        chunkSize = Math.min(128 * 1024, Math.floor(base.chunkSize * 1.5));
        highWaterMark = Math.min(4 * 1024 * 1024, Math.floor(base.highWaterMark * 1.5));
        lowWaterMark = Math.min(1 * 1024 * 1024, Math.floor(base.lowWaterMark * 1.5));
      }
    } else {
      if (loss > 3 || rtt > 260 || (bitrate > 0 && bitrate < 12_000_000)) {
        chunkSize = Math.max(128 * 1024, Math.floor(base.chunkSize / 2));
        highWaterMark = Math.max(4 * 1024 * 1024, Math.floor(base.highWaterMark * 0.6));
        lowWaterMark = Math.max(1 * 1024 * 1024, Math.floor(base.lowWaterMark * 0.6));
      } else if (loss < 0.5 && rtt > 0 && rtt < 90) {
        highWaterMark = Math.min(16 * 1024 * 1024, Math.floor(base.highWaterMark * 1.5));
        lowWaterMark = Math.min(4 * 1024 * 1024, Math.floor(base.lowWaterMark * 1.5));
      }
    }

    const finalHigh = toStep(highWaterMark);
    const finalLow = toStep(Math.min(lowWaterMark, Math.floor(finalHigh * 0.5)));
    const finalChunk = toStep(chunkSize, 4 * 1024);
    return {
      chunkSize: finalChunk,
      highWaterMark: finalHigh,
      lowWaterMark: finalLow,
    };
  };

  const updateAdaptiveFlow = (peerId: string, route: ConnectionRoute, metrics: ConnectionMetrics) => {
    const next = deriveAdaptiveFlow(route, metrics);
    const prev = peerAdaptiveFlowRef.current.get(peerId);
    if (
      prev &&
      prev.chunkSize === next.chunkSize &&
      prev.highWaterMark === next.highWaterMark &&
      prev.lowWaterMark === next.lowWaterMark &&
      prev.metrics.rttMs === metrics.rttMs &&
      prev.metrics.lossPct === metrics.lossPct
    ) {
      return;
    }
    peerAdaptiveFlowRef.current.set(peerId, {
      ...next,
      lastUpdatedAt: Date.now(),
      metrics,
    });
  };

  const updateConnectionStats = async (conn: DataConnection, options?: { updateUi?: boolean }): Promise<ConnectionRoute> => {
      const shouldUpdateUi = options?.updateUi ?? true;
      if (!conn.peerConnection || conn.peerConnection.connectionState === 'closed') {
        return { isLan: false, isRelay: false, protocol: 'udp' };
      }

      let route: ConnectionRoute = { isLan: false, isRelay: false, protocol: 'udp' };

      try {
          const stats = await conn.peerConnection.getStats();
          let selectedPair: any = null;

          stats.forEach(report => {
              if (report.type === 'transport' && report.selectedCandidatePairId) {
                  selectedPair = stats.get(report.selectedCandidatePairId);
              }
          });

          if (!selectedPair) {
              stats.forEach(report => {
                  if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.selected) {
                      selectedPair = report;
                  }
              });
          }

          if (selectedPair) {
              const localCandidate = stats.get(selectedPair.localCandidateId);
              const remoteCandidate = stats.get(selectedPair.remoteCandidateId);
              const protocol = localCandidate?.protocol || 'udp';
              const localCandidateType = localCandidate?.candidateType || '';
              const remoteCandidateType = remoteCandidate?.candidateType || '';
              const rttMs = typeof selectedPair.currentRoundTripTime === 'number'
                ? Math.round(selectedPair.currentRoundTripTime * 1000)
                : null;
              const availableOutgoingBitrate = typeof selectedPair.availableOutgoingBitrate === 'number'
                ? selectedPair.availableOutgoingBitrate
                : null;
              const packetsSent = typeof selectedPair.packetsSent === 'number' ? selectedPair.packetsSent : null;
              const packetsLost = typeof selectedPair.packetsLost === 'number'
                ? selectedPair.packetsLost
                : typeof selectedPair.packetsDiscardedOnSend === 'number'
                  ? selectedPair.packetsDiscardedOnSend
                  : null;
              const lossPct = packetsSent && packetsSent > 0 && packetsLost !== null
                ? Math.max(0, Math.min(100, (packetsLost / packetsSent) * 100))
                : null;

              const localIP = localCandidate?.address || localCandidate?.ip || '';
              const remoteIP = remoteCandidate?.address || remoteCandidate?.ip || '';
              const isRelayConnection = localCandidateType === 'relay' || remoteCandidateType === 'relay';
              const isLanConnection = !isRelayConnection && isPrivateIP(localIP) && isPrivateIP(remoteIP);
              route = { isLan: isLanConnection, isRelay: isRelayConnection, protocol };
              updateAdaptiveFlow(conn.peer, route, { rttMs, lossPct, availableOutgoingBitrate });

              peerIsLAN.current.set(conn.peer, isLanConnection);
              const networkType = isRelayConnection ? '中继（速度会变慢）' : isLanConnection ? '直连' : '点对点';
              peerConnectionTypeRef.current.set(conn.peer, networkType);

              if (shouldUpdateUi) {
                  if (activeConnections.current.size === 1) {
                    setConnectionStatus(`已连接 | ${protocol.toUpperCase()} | ${networkType}`);
                  } else {
                    setConnectionStatus(`已连接 ${activeConnections.current.size} 个设备`);
                  }
              }
          }
      } catch (e) {
          
      }

      return route;
  };

  
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (state === TransferState.WAITING_FOR_PEER || state === TransferState.PEER_CONNECTED || state === TransferState.TRANSFERRING) {
        e.preventDefault();
        e.returnValue = ''; 
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [state]);

  useEffect(() => {
    isMountedRef.current = true;
    prefetchIceConfig();
    return () => {
      isMountedRef.current = false;
      stopSharing();
    };
  }, []);

  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;
    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator) {
          wakeLock = await navigator.wakeLock.request('screen');
        }
      } catch (err) { console.warn('Wake Lock request failed:', err); }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && state === TransferState.TRANSFERRING) {
        requestWakeLock();
      }
    };
    if (state === TransferState.TRANSFERRING) {
      requestWakeLock();
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }
    return () => {
      if (wakeLock) wakeLock.release().catch(() => {});
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [state]);

  useEffect(() => {
    if (state === TransferState.WAITING_FOR_PEER || state === TransferState.PEER_CONNECTED || state === TransferState.TRANSFERRING) {
      if (metadata?.constraints?.expiresAt) {
        const updateTimer = () => {
          const now = Date.now();
          const end = metadata.constraints!.expiresAt!;
          const diff = end - now;
          if (diff <= 0) {
            setRemainingTime('已过期');
            stopSharing();
            setErrorMsg('分享时间已结束。');
            setState(TransferState.ERROR);
            if (timerRef.current) clearInterval(timerRef.current);
          } else {
            const h = Math.floor(diff / (1000 * 60 * 60));
            const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const s = Math.floor((diff % (1000 * 60)) / 1000);
            setRemainingTime(`${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`);
          }
        };
        updateTimer();
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = setInterval(updateTimer, 1000);
      } else {
        setRemainingTime('永久有效');
      }
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [state, metadata]);

  const decodeFileName = useCallback((name: string) => {
    try {
      return decodeURIComponent(name);
    } catch {
      return name;
    }
  }, []);

  const processFiles = useCallback(async (files: File[]) => {
    setFileList(files);
    fileListRef.current = files;
    setState(TransferState.CONFIGURING);

    let totalSize = 0;
    const filesInfo = [];
    for (const f of files) {
        totalSize += f.size;
        let preview = undefined;
        if (files.length === 1) {
            preview = await generatePreview(f);
        }
        const name = f.fullPath || (f as any).webkitRelativePath || f.name;
        filesInfo.push({
            name: decodeFileName(name),
            size: f.size,
            type: f.type,
            lastModified: f.lastModified,
            preview,
            fingerprint: generateFileFingerprint(f)
        });
    }
    setMetadata({ files: filesInfo, totalSize: totalSize });
  }, [decodeFileName]);

  const traverseFileTree = (item: FileSystemEntry, path: string = ""): Promise<File[]> => {
    return new Promise((resolve, reject) => {
      if (item.isFile) {
        (item as FileSystemFileEntry).file((file: File) => {
          try {
            const safeFile = new File([file], file.name, { type: file.type, lastModified: file.lastModified });
            safeFile.fullPath = path + file.name;
            resolve([safeFile]);
          } catch (e) {
            file.fullPath = path + file.name;
            resolve([file]);
          }
        }, (err: any) => resolve([]));
      } else if (item.isDirectory) {
        const dirReader = (item as FileSystemDirectoryEntry).createReader();
        const entries: FileSystemEntry[] = [];
        const readEntries = () => {
          dirReader.readEntries(async (results: FileSystemEntry[]) => {
            if (results.length === 0) {
               try {
                  const subPromises = entries.map(entry => traverseFileTree(entry, path + item.name + "/"));
                  const filesArrays = await Promise.all(subPromises);
                  resolve(filesArrays.flat());
               } catch (err) { reject(err); }
            } else {
               entries.push(...results);
               readEntries();
            }
          }, (err: any) => reject(err));
        };
        readEntries();
      }
    });
  };

  const handleDirectoryDrop = async (entry: FileSystemEntry) => {
      try {
          const files = await traverseFileTree(entry, ""); 
          if (files.length === 0) throw new Error("文件夹为空");
          processFiles(files);
      } catch (err) {
          console.error("Folder processing failed", err);
          onNotification("文件夹解析失败", "error");
      }
  };

  const handleDragEvents = useCallback((e: DragEvent) => {
      e.preventDefault();
      if (e.type === 'dragover') setIsDragOver(true);
      if (e.type === 'dragleave' && e.clientX === 0 && e.clientY === 0) setIsDragOver(false);
      if (e.type === 'drop') {
          setIsDragOver(false);
          const items = e.dataTransfer?.items;
          if (items && items.length > 0) {
              const item = items[0];
              const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
              if (entry && entry.isDirectory) {
                  handleDirectoryDrop(entry);
                  return;
              }
          }
          if (e.dataTransfer?.files.length) {
             const files = Array.from(e.dataTransfer.files).map((f: any) => 
                new File([f], f.name, { type: f.type, lastModified: f.lastModified })
             );
             processFiles(files);
          }
      }
  }, [processFiles]);

  useEffect(() => {
    if (state !== TransferState.IDLE) return;
    window.addEventListener('dragover', handleDragEvents);
    window.addEventListener('dragleave', handleDragEvents);
    window.addEventListener('drop', handleDragEvents);
    return () => {
      window.removeEventListener('dragover', handleDragEvents);
      window.removeEventListener('dragleave', handleDragEvents);
      window.removeEventListener('drop', handleDragEvents);
    };
  }, [state, handleDragEvents]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const safeFiles = Array.from(files).map((f: any) => new File([f], f.name, { type: f.type, lastModified: f.lastModified }));
    e.target.value = '';
    processFiles(safeFiles);
  };

  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const safeFiles = Array.from(files).map((f: any) => {
        const safe = new File([f], f.name, { type: f.type, lastModified: f.lastModified });
        safe.fullPath = f.webkitRelativePath || f.name;
        return safe;
    });
    e.target.value = '';
    processFiles(safeFiles);
  };

  const startSharing = async () => {
    if (!fileList.length || !metadata) return;
    shareTelemetryRef.current = createConnectionSession('sender', {
      fileCount: fileList.length,
      totalSize: metadata.totalSize,
      customCode: customCodeInput.length === 4,
    });
    startConnectionAttempt(shareTelemetryRef.current, 'create_share');
    isDestroyingRef.current = false;
    
    
    peerProgress.current.clear();
    peerRealtimeSpeed.current.clear();
    peerAverageSpeed.current.clear();
    peerHasProgressSyncRef.current.clear();
    peerTransferredBytesRef.current.clear();
    peerTotalBytesRef.current.clear();
    peerSyncStartAtRef.current.clear();
    peerSyncBaseBytesRef.current.clear();
    peerTransferEpochRef.current.clear();
    pendingSendPeersRef.current.clear();
    setIndividualStats([]);

    setState(TransferState.GENERATING_CODE);
    setPreparingStage('fetching_ice');
    setConnectionStatus('');
    let expiresAt: number | undefined;
    const now = Date.now();
    if (expiryOption === '10m') expiresAt = now + 10 * 60 * 1000;
    if (expiryOption === '1h') expiresAt = now + 60 * 60 * 1000;
    if (expiryOption === '1d') expiresAt = now + 24 * 60 * 60 * 1000;
    const metadataWithConstraints: FileMetadata = { ...metadata, protocolVersion: P2P_PROTOCOL_VERSION, constraints: { expiresAt } };
    setMetadata(metadataWithConstraints);
    const iceConfig = await getIceConfig();
    setPreparingStage('connecting_signaling');
    markIceConfigFetched(shareTelemetryRef.current);
    const clearSignalingOpenTimeout = () => {
      if (signalingOpenTimeoutRef.current !== null) {
        window.clearTimeout(signalingOpenTimeoutRef.current);
        signalingOpenTimeoutRef.current = null;
      }
    };

    const createSharePeer = (attempt: number) => {
      const finalCode = customCodeInput.length === 4 ? customCodeInput : (() => {
        const arr = new Uint32Array(1);
        crypto.getRandomValues(arr);
        return (1000 + (arr[0] % 9000)).toString();
      })();

      const customPeer = new Peer(`aerodrop-${finalCode}`, {
        debug: peerDebugLevel,
        pingInterval: 5000,
        config: {
          iceServers: iceConfig.iceServers,
          iceCandidatePoolSize: iceConfig.iceCandidatePoolSize,
          iceTransportPolicy: iceConfig.iceTransportPolicy,
        }
      });

      clearSignalingOpenTimeout();
      signalingOpenTimeoutRef.current = window.setTimeout(() => {
        if (isDestroyingRef.current) return;
        if (peerRef.current !== customPeer) return;
        markSessionEvent(shareTelemetryRef.current, 'signaling_open_timeout', { attempt });
        try { customPeer.destroy(); } catch {}
        if (attempt < MAX_SIGNALING_OPEN_RETRY) {
          setPreparingStage('connecting_signaling');
          createSharePeer(attempt + 1);
          return;
        }
        setErrorMsg('准备传输节点超时，请重试');
        setState(TransferState.ERROR);
      }, SIGNALING_OPEN_TIMEOUT_MS);

      customPeer.on('open', clearSignalingOpenTimeout);
      customPeer.on('error', clearSignalingOpenTimeout);
      setupPeerListeners(customPeer, finalCode, metadataWithConstraints);
    };

    createSharePeer(0);
  };

  const cleanupConnectionState = (conn: DataConnection) => {
      if (peerAwaitingFinalizeAckRef.current.delete(conn.peer)) {
          activeTransfersCount.current = Math.max(0, activeTransfersCount.current - 1);
      }
      activeConnections.current.delete(conn);
      peerProgress.current.delete(conn.peer);
      peerRealtimeSpeed.current.delete(conn.peer);
      peerAverageSpeed.current.delete(conn.peer);
      peerHasProgressSyncRef.current.delete(conn.peer);
      peerTransferredBytesRef.current.delete(conn.peer);
      peerTotalBytesRef.current.delete(conn.peer);
      peerSyncStartAtRef.current.delete(conn.peer);
      peerSyncBaseBytesRef.current.delete(conn.peer);
      peerTransferEpochRef.current.delete(conn.peer);
      pendingSendPeersRef.current.delete(conn.peer);
      activeSendingPeersRef.current.delete(conn.peer);
      ghostCandidateSinceRef.current.delete(conn.peer);
      peerConnectionTypeRef.current.delete(conn.peer);
      peerHeartbeatAtRef.current.delete(conn.peer);
      peerAdaptiveFlowRef.current.delete(conn.peer);
      removePeerName(conn.peer);

      const removedSessionId = peerSessionIdsRef.current.get(conn.peer);
      if (removedSessionId && sessionToPeerRef.current.get(removedSessionId) === conn.peer) {
          sessionToPeerRef.current.delete(removedSessionId);
      }
      peerSessionIdsRef.current.delete(conn.peer);

      updateConnectionStatusUI();

      if (isDestroyingRef.current) return;
      if (activeSendingPeersRef.current.size === 0 && pendingSendPeersRef.current.size === 0) {
          if (activeConnections.current.size > 0) {
              setState(TransferState.PEER_CONNECTED);
              return;
          }

          setConnectionStatus('');
          setState(TransferState.WAITING_FOR_PEER);
      }
  };

  useEffect(() => {
      const sweep = () => {
          const now = Date.now();
          const conns = Array.from(activeConnections.current);

          conns.forEach((conn) => {
              const dataChannel = (conn as any).dataChannel as RTCDataChannel | undefined;
              const pc = conn.peerConnection;

              const dcState = dataChannel?.readyState;
              const pcState = pc?.connectionState;
              const closedByState =
                  !conn.open ||
                  dcState === 'closed' ||
                  pcState === 'closed' ||
                  pcState === 'failed';

              const unstableByState =
                  dcState === 'closing' ||
                  pcState === 'disconnected';

              if (closedByState) {
                  try { if (conn.open) conn.close(); } catch {}
                  cleanupConnectionState(conn);
                  return;
              }

              const transportHealthy =
                  pcState === 'connected' &&
                  (dcState === 'open' || conn.open);
              const lastHeartbeatAt = peerHeartbeatAtRef.current.get(conn.peer) ?? now;
              const heartbeatGapMs = now - lastHeartbeatAt;

              // Browsers heavily throttle timers in background tabs. When SCTP/DataChannel
              // is still healthy, trust WebRTC transport keepalive and avoid heartbeat-based kills.
              if (transportHealthy) {
                  peerHeartbeatAtRef.current.set(conn.peer, now);
              } else if (heartbeatGapMs >= HARD_HEARTBEAT_TIMEOUT_MS) {
                  markSessionEvent(shareTelemetryRef.current, 'heartbeat_hard_timeout_kill', {
                    peer: conn.peer,
                    timeoutMs: heartbeatGapMs,
                    pcState: pcState ?? 'unknown',
                    dcState: dcState ?? 'unknown',
                  });
                  try { if (conn.open) conn.close(); } catch {}
                  cleanupConnectionState(conn);
                  return;
              } else if (heartbeatGapMs >= HEARTBEAT_TIMEOUT_MS) {
                  markSessionEvent(shareTelemetryRef.current, 'heartbeat_stale_signal', {
                    peer: conn.peer,
                    timeoutMs: heartbeatGapMs,
                    pcState: pcState ?? 'unknown',
                    dcState: dcState ?? 'unknown',
                  });
              }

              if (unstableByState) {
                  const firstSeen = ghostCandidateSinceRef.current.get(conn.peer) ?? now;
                  ghostCandidateSinceRef.current.set(conn.peer, firstSeen);
                  if (now - firstSeen >= GHOST_GRACE_MS) {
                      markSessionEvent(shareTelemetryRef.current, 'ghost_sweep_kill', {
                        peer: conn.peer,
                        pcState: pcState ?? 'unknown',
                        dcState: dcState ?? 'unknown',
                        graceDurationMs: now - firstSeen,
                      });
                      try { if (conn.open) conn.close(); } catch {}
                      cleanupConnectionState(conn);
                  }
                  return;
              }

              ghostCandidateSinceRef.current.delete(conn.peer);
          });
      };

      const timer = window.setInterval(sweep, GHOST_SWEEP_INTERVAL_MS);
      return () => clearInterval(timer);
  }, []);

  const scheduleSendFileSequence = (conn: DataConnection, startFileIndex: number, startByteOffset: number) => {
      // Bump the per-peer epoch so any running sendFileSequence for this peer
      // will detect the change at its next check-point and exit gracefully.
      const nextEpoch = (peerTransferEpochRef.current.get(conn.peer) || 0) + 1;
      peerTransferEpochRef.current.set(conn.peer, nextEpoch);

      // Track as pending so cleanupConnectionState knows a transfer is
      // scheduled even before sendFileSequence starts executing.
      pendingSendPeersRef.current.add(conn.peer);
      setTimeout(() => {
          sendFileSequence(conn, startFileIndex, startByteOffset, nextEpoch);
      }, 100);
  };

  const setupPeerListeners = (peer: Peer, code: string, sessionMetadata: FileMetadata) => {
      peerRef.current = peer;
      peer.on('open', () => {
          markSignalingOpen(shareTelemetryRef.current);
          markConnectionSuccess(shareTelemetryRef.current, { code });
          setTransferCode(code);
          setPreparingStage('fetching_ice');
          setState(TransferState.WAITING_FOR_PEER);
      });
      peer.on('disconnected', () => {
          if (peer && !peer.destroyed) peer.reconnect();
      });
      peer.on('error', (err) => {
          if (err.type === 'unavailable-id') {
              markConnectionFailure(shareTelemetryRef.current, 'code_unavailable');
              setErrorMsg('该口令已被占用，请换一个。');
              setState(TransferState.CONFIGURING);
          } else {
              if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') { return; }
              console.error("Peer Error:", err);
              markConnectionFailure(shareTelemetryRef.current, `peer_error:${err.type}`);
              if (activeConnections.current.size === 0) {
                 setErrorMsg(`连接错误: ${err.type}`);
                 setPreparingStage('fetching_ice');
                 setState(TransferState.ERROR);
              }
          }
      });
      peer.on('connection', (conn) => {
          if (sessionMetadata.constraints?.expiresAt && Date.now() > sessionMetadata.constraints.expiresAt) {
             conn.on('open', () => {
                 conn.send({ type: 'REJECT_TRANSFER', payload: { reason: '分享已过期' } });
                 setTimeout(() => conn.close(), 1000);
             });
             return;
          }
          
          conn.on('open', () => {
              markSessionEvent(shareTelemetryRef.current, 'receiver_connected', { peerId: conn.peer });
              activeConnections.current.add(conn);
              peerHeartbeatAtRef.current.set(conn.peer, Date.now());
              peerProgress.current.set(conn.peer, peerProgress.current.get(conn.peer) || 0);
              peerRealtimeSpeed.current.set(conn.peer, peerRealtimeSpeed.current.get(conn.peer) || 0);
              peerAverageSpeed.current.set(conn.peer, peerAverageSpeed.current.get(conn.peer) || 0);
              peerHasProgressSyncRef.current.delete(conn.peer);
              peerTransferredBytesRef.current.set(conn.peer, peerTransferredBytesRef.current.get(conn.peer) || 0);
              peerTotalBytesRef.current.set(conn.peer, peerTotalBytesRef.current.get(conn.peer) || (sessionMetadata.totalSize || 0));
              peerSyncStartAtRef.current.delete(conn.peer);
              peerSyncBaseBytesRef.current.delete(conn.peer);
              updateConnectionStatusUI();
              
              updateConnectionStats(conn);
              const pc = conn.peerConnection;
              if (pc) {
                collectIceRouteWithRetry(pc).then((route) => {
                  attachIceRouteToSession(shareTelemetryRef.current, route);
                });
              }

              setState(TransferState.PEER_CONNECTED);
              try {
                  conn.send({ type: 'DEVICE_INFO', payload: { deviceName: localDeviceNameRef.current } });
                  conn.send({ type: 'METADATA', payload: sessionMetadata });
              } catch(e) { console.error("Failed to send metadata", e); }
          });
          
          conn.on('data', (data: any) => {
              const msg = data as P2PMessage;
              if (msg.type === 'DEVICE_INFO') {
                  const remoteName = typeof msg.payload?.deviceName === 'string' ? msg.payload.deviceName : '';
                  updatePeerName(conn.peer, remoteName);

                  const remoteSessionId = typeof msg.payload?.sessionId === 'string' ? msg.payload.sessionId : '';
                  if (remoteSessionId) {
                      const existingPeerId = sessionToPeerRef.current.get(remoteSessionId);
                      if (existingPeerId && existingPeerId !== conn.peer) {
                          const oldConn = Array.from(activeConnections.current).find(c => c.peer === existingPeerId);
                          if (oldConn) {
                              oldConn.close();
                          }
                      }
                      peerSessionIdsRef.current.set(conn.peer, remoteSessionId);
                      sessionToPeerRef.current.set(remoteSessionId, conn.peer);
                  }
              } else if (msg.type === 'ACCEPT_TRANSFER') {
                  setState(TransferState.TRANSFERRING);
                  scheduleSendFileSequence(conn, 0, 0);
              } else if (msg.type === 'RESUME_REQUEST') {
                  const payload = msg.payload as ResumePayload;
                  const legacyChunkIndex = typeof payload.chunkIndex === 'number' ? Math.max(0, payload.chunkIndex) : 0;
                  const resumedByteOffset = typeof payload.byteOffset === 'number' ? Math.max(0, payload.byteOffset) : legacyChunkIndex * TRANSFER_CONFIG.CHUNK_SIZE_WAN;
                  if (peerAwaitingFinalizeAckRef.current.delete(conn.peer)) {
                    activeTransfersCount.current = Math.max(0, activeTransfersCount.current - 1);
                  }
                  if (!payload.silent) {
                    onNotification(`检测到断点，正在从第 ${payload.fileIndex + 1} 个文件恢复...`, 'info');
                  }
                  setState(TransferState.TRANSFERRING);
                  scheduleSendFileSequence(conn, payload.fileIndex, resumedByteOffset);
              } else if (msg.type === 'TRANSFER_CANCELLED') {
                  const remoteName = peerNamesRef.current[conn.peer] || `设备 ${conn.peer.slice(0, 5)}...`;
                  onNotification(`${remoteName} 取消了下载`, 'info');
                  // Receiver explicitly cancelled; close immediately so sender UI exits "transferring" state without delay.
                  try {
                    if (conn.open) conn.close();
                  } catch {}
                  cleanupConnectionState(conn);
              } else if (msg.type === 'TRANSFER_PROGRESS') {
                  const payload = (msg.payload || {}) as {
                    overallTransferredBytes?: number;
                    overallTotalBytes?: number;
                    speedBytes?: number;
                  };
                  const totalBytes = typeof payload.overallTotalBytes === 'number' ? Math.max(0, payload.overallTotalBytes) : 0;
                  const transferredBytes = typeof payload.overallTransferredBytes === 'number'
                    ? Math.max(0, payload.overallTransferredBytes)
                    : 0;
                  const safeTransferredBytes = totalBytes > 0 ? Math.min(totalBytes, transferredBytes) : transferredBytes;
                  const rawProgress = totalBytes > 0
                    ? Math.floor((safeTransferredBytes / totalBytes) * 100)
                    : 0;
                  const waitingFinalizeAck = peerAwaitingFinalizeAckRef.current.has(conn.peer);
                  const syncProgress = waitingFinalizeAck
                    ? Math.min(rawProgress, 99)
                    : Math.max(0, Math.min(100, rawProgress));
                  const speedBytes = typeof payload.speedBytes === 'number' ? Math.max(0, payload.speedBytes) : 0;
                  const now = Date.now();
                  const hasSyncStarted = peerSyncStartAtRef.current.has(conn.peer);
                  if (!hasSyncStarted) {
                    peerSyncStartAtRef.current.set(conn.peer, now);
                    peerSyncBaseBytesRef.current.set(conn.peer, safeTransferredBytes);
                  }
                  const syncStartAt = peerSyncStartAtRef.current.get(conn.peer) || now;
                  const syncBaseBytes = peerSyncBaseBytesRef.current.get(conn.peer) || 0;
                  const elapsedSec = Math.max(0.001, (now - syncStartAt) / 1000);
                  const avgSpeedFromSync = Math.max(0, safeTransferredBytes - syncBaseBytes) / elapsedSec;

                  peerHasProgressSyncRef.current.add(conn.peer);
                  peerTransferredBytesRef.current.set(conn.peer, safeTransferredBytes);
                  peerTotalBytesRef.current.set(conn.peer, totalBytes);
                  peerProgress.current.set(conn.peer, syncProgress);
                  peerRealtimeSpeed.current.set(conn.peer, speedBytes);
                  peerAverageSpeed.current.set(conn.peer, avgSpeedFromSync);
              } else if (msg.type === 'ALL_FILES_RECEIVED') {
                  if (peerAwaitingFinalizeAckRef.current.delete(conn.peer)) {
                    activeTransfersCount.current = Math.max(0, activeTransfersCount.current - 1);
                  }
                  const finalTotalBytes = peerTotalBytesRef.current.get(conn.peer) || metadata?.totalSize || 0;
                  peerTransferredBytesRef.current.set(conn.peer, finalTotalBytes);
                  peerTotalBytesRef.current.set(conn.peer, finalTotalBytes);
                  peerProgress.current.set(conn.peer, 100);
                  peerRealtimeSpeed.current.set(conn.peer, 0);
                  if (activeTransfersCount.current === 0) {
                    setTotalProgress(100);
                    setCurrentFileIndex(0);
                    onNotification("文件发送完成！", 'success');
                  }
              } else if (msg.type === 'HEARTBEAT') {
                  peerHeartbeatAtRef.current.set(conn.peer, Date.now());
              }
          });
          
          conn.on('close', () => {
              cleanupConnectionState(conn);
          });
          
          conn.on('error', (err) => {
              console.warn("Connection error", err);
          });
      });
  };

  const sendFileSequence = async (conn: DataConnection, startFileIndex: number = 0, startByteOffset: number = 0, peerEpoch: number = 0) => {
    const files = fileListRef.current;
    if (!files.length) return;

    // If a newer sequence was already scheduled for this peer, bail out.
    if (peerTransferEpochRef.current.get(conn.peer) !== peerEpoch) return;

    // Wait for any previous sequence to finish exiting (it will detect the
    // epoch bump and return soon).  Re-check our own epoch each iteration so
    // we also bail if yet another sequence is scheduled while we wait.
    let waitAttempts = 0;
    while (activeSendingPeersRef.current.has(conn.peer)) {
        await new Promise(r => setTimeout(r, 50));
        waitAttempts++;
        if (waitAttempts > 120) {
            // Safety cap — clean up pending since this attempt failed.
            pendingSendPeersRef.current.delete(conn.peer);
            return;
        }
        if (peerTransferEpochRef.current.get(conn.peer) !== peerEpoch) return;
        // ^ Newer epoch scheduled — that sequence owns the pending entry.
        if (!conn.open) {
            // Connection dead — clean up pending.
            pendingSendPeersRef.current.delete(conn.peer);
            return;
        }
    }

    // Transition from pending → active now that the previous sequence exited.
    pendingSendPeersRef.current.delete(conn.peer);
    activeSendingPeersRef.current.add(conn.peer);

    const currentSessionId = transferSessionId.current;
    activeTransfersCount.current += 1;

    // Start with WAN profile, then auto-adapt by live RTT/loss/bitrate stats.
    const defaultFlow: AdaptiveFlowProfile = {
      chunkSize: TRANSFER_CONFIG.CHUNK_SIZE_WAN,
      highWaterMark: FLOW_CONTROL.HIGH_WATER_MARK_WAN,
      lowWaterMark: FLOW_CONTROL.LOW_WATER_MARK_WAN,
      lastUpdatedAt: Date.now(),
      metrics: { rttMs: null, lossPct: null, availableOutgoingBitrate: null },
    };
    peerAdaptiveFlowRef.current.set(conn.peer, defaultFlow);
    const READ_BUFFER_SIZE = TRANSFER_CONFIG.READ_BUFFER_SIZE;
    updateConnectionStats(conn, { updateUi: false }).catch(() => {});

    let totalBytesSent = 0;
    let sendCompleted = false;
    let lastBufferedAmount = 0;
    let lastUpdateTime = Date.now();
    let bytesInLastPeriod = 0;
    const startTime = Date.now();

    const peerId = conn.peer;
    peerHasProgressSyncRef.current.delete(peerId);
    peerSyncStartAtRef.current.delete(peerId);
    peerSyncBaseBytesRef.current.delete(peerId);
    peerProgress.current.set(peerId, 0);
    peerTransferredBytesRef.current.set(peerId, 0);

    for(let i = 0; i < startFileIndex; i++) {
        totalBytesSent += files[i].size;
    }
    if (startByteOffset > 0) {
        totalBytesSent += startByteOffset;
    }

    const totalSize = metadata?.totalSize || 0;

    const dataChannel = (conn as any).dataChannel as RTCDataChannel | undefined;
    const fileHasher = createCrc32Hasher(`sender-${peerId}`);
    const adaptiveTimer = window.setInterval(() => {
      if (transferSessionId.current !== currentSessionId || !conn.open) {
        window.clearInterval(adaptiveTimer);
        return;
      }
      updateConnectionStats(conn, { updateUi: false }).catch(() => {});
    }, 2000);

    try {
        let fileStartByteOffset = startByteOffset;

        for (let i = startFileIndex; i < files.length; i++) {
            if (transferSessionId.current !== currentSessionId || peerTransferEpochRef.current.get(peerId) !== peerEpoch) return;
            if (!conn.open) throw new Error("Connection closed");

            if (activeConnections.current.size === 1) {
                setCurrentFileIndex(i);
            }

            const file = files[i];
            const fName = file.fullPath || (file as any).webkitRelativePath || file.name;

            const startPayload: FileStartPayload = {
                fileIndex: i,
                fileName: decodeFileName(fName),
                fileSize: file.size,
                fileType: file.type
            };
            try {
                conn.send({ type: 'FILE_START', payload: startPayload });
            } catch(e) { throw new Error("Failed to send FILE_START"); }

            let fileOffset = i === startFileIndex ? Math.min(Math.max(0, fileStartByteOffset), file.size) : 0;
            fileStartByteOffset = 0;
            const hashStartOffset = fileOffset;
            await fileHasher.reset();
            let hashedBytes = 0;

            while (fileOffset < file.size) {
                if (transferSessionId.current !== currentSessionId || peerTransferEpochRef.current.get(peerId) !== peerEpoch) return;
                if (!conn.open) throw new Error("Connection closed during transfer");

                const readSize = Math.min(READ_BUFFER_SIZE, file.size - fileOffset);
                const blobSlice = file.slice(fileOffset, fileOffset + readSize);
                const largeBuffer = await blobSlice.arrayBuffer();

                let bufferOffset = 0;
                while (bufferOffset < readSize) {
                    if (!conn.open) throw new Error("Connection closed");
                    const flow = peerAdaptiveFlowRef.current.get(peerId) || defaultFlow;
                    const HIGH_WATER_MARK = flow.highWaterMark;
                    const LOW_WATER_MARK = flow.lowWaterMark;
                    const CHUNK_SIZE = flow.chunkSize;

                    if (dataChannel && dataChannel.bufferedAmount > HIGH_WATER_MARK) {
                        dataChannel.bufferedAmountLowThreshold = LOW_WATER_MARK;

                        await new Promise<void>((resolve, reject) => {
                            let settled = false;
                            const pc = conn.peerConnection;
                            const BACKPRESSURE_DRAIN_TIMEOUT_MS = 30000;
                            const BACKPRESSURE_CHECK_INTERVAL_MS = 250;
                            let checkTimer: ReturnType<typeof setInterval> | null = null;

                            const isTerminalState = () => {
                                const pcState = pc?.connectionState;
                                return (
                                    !conn.open ||
                                    dataChannel.readyState !== 'open' ||
                                    pcState === 'closed' ||
                                    pcState === 'failed'
                                );
                            };

                            const done = (err?: Error) => {
                                if (settled) return;
                                settled = true;
                                clearTimeout(timeoutId);
                                if (checkTimer) {
                                    clearInterval(checkTimer);
                                }
                                dataChannel.removeEventListener('bufferedamountlow', onLow);
                                dataChannel.removeEventListener('close', onClose);
                                if (pc) {
                                    pc.removeEventListener('connectionstatechange', onPcStateChange);
                                }
                                if (err) {
                                    reject(err);
                                } else {
                                    resolve();
                                }
                            };

                            const onLow = () => {
                                if (dataChannel.bufferedAmount <= LOW_WATER_MARK) {
                                    done();
                                }
                            };

                            const onClose = () => {
                                done(new Error("Data channel closed while waiting for buffer drain"));
                            };

                            const onPcStateChange = () => {
                                if (!isTerminalState()) return;
                                done(new Error(
                                    `Transport closed while waiting for buffer drain: ` +
                                    `dc=${dataChannel.readyState}, pc=${pc?.connectionState ?? 'unknown'}`
                                ));
                            };

                            const checkProgress = () => {
                                if (isTerminalState()) {
                                    done(new Error(
                                        `Transport unavailable while waiting for buffer drain: ` +
                                        `dc=${dataChannel.readyState}, pc=${pc?.connectionState ?? 'unknown'}`
                                    ));
                                    return;
                                }

                                const bufferedNow = dataChannel.bufferedAmount;
                                if (bufferedNow <= LOW_WATER_MARK) {
                                    done();
                                }
                            };

                            const timeoutId = setTimeout(() => {
                                if (isTerminalState()) {
                                    done(new Error(
                                        `Transport closed while waiting for buffer drain: ` +
                                        `dc=${dataChannel.readyState}, pc=${pc?.connectionState ?? 'unknown'}`
                                    ));
                                    return;
                                }

                                if (dataChannel.bufferedAmount <= LOW_WATER_MARK) {
                                    done();
                                    return;
                                }

                                done(new Error(
                                    `Backpressure drain timeout (${BACKPRESSURE_DRAIN_TIMEOUT_MS}ms): ` +
                                    `buffered=${dataChannel.bufferedAmount}, high=${HIGH_WATER_MARK}, low=${LOW_WATER_MARK}, ` +
                                    `dc=${dataChannel.readyState}, pc=${pc?.connectionState ?? 'unknown'}`,
                                ));
                            }, BACKPRESSURE_DRAIN_TIMEOUT_MS);

                            checkTimer = setInterval(checkProgress, BACKPRESSURE_CHECK_INTERVAL_MS);

                            if (isTerminalState()) {
                                done(new Error(
                                    `Transport unavailable while waiting for buffer drain: ` +
                                    `dc=${dataChannel.readyState}, pc=${pc?.connectionState ?? 'unknown'}`
                                ));
                                return;
                            }

                            if (dataChannel.bufferedAmount <= LOW_WATER_MARK) {
                                done();
                                return;
                            }

                            dataChannel.addEventListener('bufferedamountlow', onLow);
                            dataChannel.addEventListener('close', onClose);
                            if (pc) {
                                pc.addEventListener('connectionstatechange', onPcStateChange);
                            }
                        });
                    }

                    const chunkEnd = Math.min(bufferOffset + CHUNK_SIZE, readSize);
                    // Use typed-array views to avoid per-chunk memory copy from ArrayBuffer.slice.
                    const chunkView = new Uint8Array(largeBuffer, bufferOffset, chunkEnd - bufferOffset);

                    try {
                        conn.send(chunkView);
                    } catch (e) {
                         if (!conn.open) throw new Error("Connection closed during send");
                         await new Promise(r => setTimeout(r, 20));
                         conn.send(chunkView);
                    }

                    const currentChunkSize = chunkView.byteLength;
                    fileHasher.update(chunkView);
                    hashedBytes += currentChunkSize;
                    totalBytesSent += currentChunkSize;
                    bytesInLastPeriod += currentChunkSize;
                    bufferOffset += currentChunkSize;

                    const now = Date.now();
                    if (now - lastUpdateTime >= 500) {
                        const duration = (now - lastUpdateTime) / 1000;
                        const currentBuffered = dataChannel?.bufferedAmount || 0;

                        const actualBytesTransferred = bytesInLastPeriod - (currentBuffered - lastBufferedAmount);
                        
                        if (duration > 0) {
                            const effectiveSpeed = Math.max(0, actualBytesTransferred) / duration;
                            const totalDuration = (now - startTime) / 1000;
                            const realTotal = Math.max(0, totalBytesSent - currentBuffered);
                            
                            const hasProgressSync = peerHasProgressSyncRef.current.has(peerId);
                            if (!hasProgressSync) {
                                peerRealtimeSpeed.current.set(peerId, effectiveSpeed);
                                peerAverageSpeed.current.set(peerId, realTotal / totalDuration);
                                if (totalSize > 0) {
                                    const p = Math.min(99, Math.floor((realTotal / totalSize) * 100));
                                    peerProgress.current.set(peerId, p);
                                }
                                peerTotalBytesRef.current.set(peerId, totalSize);
                                peerTransferredBytesRef.current.set(peerId, Math.max(0, Math.min(totalSize, realTotal)));
                            }
                        }
                        
                        lastUpdateTime = now;
                        lastBufferedAmount = currentBuffered;
                        bytesInLastPeriod = 0;
                    }
                }
                fileOffset += readSize;
            }

            const fileHash = await fileHasher.finalizeHex();
            const completePayload: FileCompletePayload = {
                fileIndex: i,
                hashAlgorithm: 'crc32',
                fileHash,
                hashStartOffset,
                hashedBytes,
            };
            try { conn.send({ type: 'FILE_COMPLETE', payload: completePayload }); } catch(e) {}
        }

        try { conn.send({ type: 'ALL_FILES_COMPLETE' }); } catch(e) {}
        
        sendCompleted = true;
        peerAwaitingFinalizeAckRef.current.add(peerId);
        peerProgress.current.set(peerId, 99);
        peerRealtimeSpeed.current.set(peerId, 0);

    } catch (err) {
        if (transferSessionId.current === currentSessionId) {
            console.warn(`Transfer to ${peerId} interrupted/failed:`, err);
            const remoteName = peerNamesRef.current[conn.peer] || `设备 ...${conn.peer.slice(-4)}`;
            onNotification(`${remoteName} 传输中断，等待重连后可继续`, 'error');

            if (conn.open) {
                conn.close();
            }
        }
    } finally {
        fileHasher.terminate();
        window.clearInterval(adaptiveTimer);
        // Always remove — the new sequence adds itself only after this
        // sequence has exited, so there is no ownership conflict.
        activeSendingPeersRef.current.delete(peerId);
        if (transferSessionId.current === currentSessionId) {
            if (!sendCompleted) {
                activeTransfersCount.current = Math.max(0, activeTransfersCount.current - 1);
            }
        }
    }
  };

  const stopSharing = () => {
    isDestroyingRef.current = true;
    if (signalingOpenTimeoutRef.current !== null) {
      window.clearTimeout(signalingOpenTimeoutRef.current);
      signalingOpenTimeoutRef.current = null;
    }
    transferSessionId.current += 1; 
    
    activeConnections.current.forEach(conn => {
        if (conn.open) {
            try { conn.send({ type: 'TRANSFER_CANCELLED' }); } catch(e) { console.error(e); }
            conn.close();
        }
    });
    activeConnections.current.clear();
    activeSendingPeersRef.current.clear();
    pendingSendPeersRef.current.clear();
    peerAwaitingFinalizeAckRef.current.clear();
    peerHasProgressSyncRef.current.clear();
    peerTransferredBytesRef.current.clear();
    peerTotalBytesRef.current.clear();
    peerSyncStartAtRef.current.clear();
    peerSyncBaseBytesRef.current.clear();
    peerTransferEpochRef.current.clear();
    peerSessionIdsRef.current.clear();
    sessionToPeerRef.current.clear();
    ghostCandidateSinceRef.current.clear();
    peerConnectionTypeRef.current.clear();
    peerHeartbeatAtRef.current.clear();
    peerAdaptiveFlowRef.current.clear();

    setTimeout(() => {
        if (peerRef.current) { peerRef.current.destroy(); peerRef.current = null; }
    }, 100);
    
    activeTransfersCount.current = 0;
    
    peerProgress.current.clear();
    peerRealtimeSpeed.current.clear();
    peerAverageSpeed.current.clear();
    setIndividualStats([]);
    setPeerNames({});

    setConnectionStatus('');
    setPreparingStage('fetching_ice');
    setState(TransferState.IDLE);
    setFileList([]);
    setMetadata(null);
    setTransferCode('');
    setCustomCodeInput('');
    setTotalProgress(0);
    setCurrentSpeed('0 KB/s');
    setAvgSpeed('0 KB/s');
    setCurrentSpeedBytes(0);
    setAvgSpeedBytes(0);
    fileListRef.current = [];
    if (timerRef.current) clearInterval(timerRef.current);
  };

  const handleCopyCode = async () => {
      if (!transferCode) return;
      try {
          await navigator.clipboard.writeText(transferCode);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
          onNotification('口令已复制', 'success');
      } catch (err) {
          console.warn('Clipboard write failed:', err);
          onNotification('复制失败，请手动复制', 'error');
      }
  };

  const shareLink = `${window.location.origin}${window.location.pathname}?code=${transferCode}`;
  const formatEta = (seconds: number): string => {
      if (!Number.isFinite(seconds) || seconds <= 0) return '--';
      if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
      if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
      return `${Math.ceil(seconds / 3600)} 小时`;
  };
  const perDeviceTotalBytes = metadata?.totalSize ?? 0;
  const activeTransferStats = individualStats.filter((s) => s.status !== 'waiting');
  const transferTargetCount = activeTransferStats.length;
  const totalBytes = activeTransferStats.reduce((acc, s) => {
    const peerTotal = peerTotalBytesRef.current.get(s.peerId);
    return acc + (typeof peerTotal === 'number' && peerTotal > 0 ? peerTotal : perDeviceTotalBytes);
  }, 0);
  const transferredBytes = activeTransferStats.reduce((acc, s) => {
    const peerTotal = peerTotalBytesRef.current.get(s.peerId);
    const fallbackTotal = typeof peerTotal === 'number' && peerTotal > 0 ? peerTotal : perDeviceTotalBytes;
    const peerDone = peerTransferredBytesRef.current.get(s.peerId);
    if (typeof peerDone === 'number') {
      return acc + Math.max(0, Math.min(fallbackTotal, peerDone));
    }
    return acc + Math.floor((Math.max(0, Math.min(100, s.progress)) / 100) * fallbackTotal);
  }, 0);
  const remainingBytes = Math.max(0, totalBytes - transferredBytes);
  const etaSpeedBytes = currentSpeedBytes > 0 ? currentSpeedBytes : avgSpeedBytes;
  const overallEta = etaSpeedBytes > 0 ? formatEta(remainingBytes / etaSpeedBytes) : '--';

  const handleCopyLink = async () => {
      try {
          await navigator.clipboard.writeText(shareLink);
          setLinkCopied(true);
          setTimeout(() => setLinkCopied(false), 2000);
          onNotification('链接已复制', 'success');
      } catch (err) {
          console.warn('Clipboard write failed:', err);
          onNotification('复制失败，请手动复制', 'error');
      }
  };

  return (
    <SenderUI
      state={state}
      isDragOver={isDragOver}
      handleFileSelect={handleFileSelect}
      handleFolderSelect={handleFolderSelect}
      metadata={metadata}
      showFileList={showFileList}
      onToggleFileList={() => setShowFileList((prev) => !prev)}
      stopSharing={stopSharing}
      expiryOption={expiryOption}
      setExpiryOption={setExpiryOption}
      customCodeInput={customCodeInput}
      setCustomCodeInput={setCustomCodeInput}
      errorMsg={errorMsg}
      startSharing={startSharing}
      preparingStage={preparingStage}
      handleCopyCode={handleCopyCode}
      copied={copied}
      transferCode={transferCode}
      linkCopied={linkCopied}
      shareLink={shareLink}
      handleCopyLink={handleCopyLink}
      remainingTime={remainingTime}
      connectionStatus={connectionStatus}
      individualStats={individualStats}
      totalProgress={totalProgress}
      activeTransfersCount={activeTransfersCount.current}
      currentFileIndex={currentFileIndex}
      fileList={fileList}
      totalBytes={totalBytes}
      transferredBytes={transferredBytes}
      overallEta={overallEta}
      activeConnectionsCount={activeConnections.current.size}
      currentSpeed={currentSpeed}
      avgSpeed={avgSpeed}
    />
  );
};
