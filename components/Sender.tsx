import React, { useState, useEffect, useRef, useCallback } from 'react';
import Peer, { DataConnection } from 'peerjs';
import { TransferState, FileMetadata, P2PMessage, FileStartPayload, FileCompletePayload, ResumePayload } from '../types';
import { formatFileSize, generatePreview, generateFileFingerprint } from '../services/fileUtils';
import { getIceConfig } from '../services/stunService';
import { TRANSFER_CONFIG, FLOW_CONTROL } from '../constants/transfer'; 
import {
  attachIceRouteToSession,
  collectIceRouteWithRetry,
  ConnectionSession,
  createConnectionSession,
  markConnectionFailure,
  markConnectionSuccess,
  markSessionEvent,
  startConnectionAttempt,
} from '../services/connectionTelemetry';
import { Upload, AlertCircle, X, Check, Loader2, Link as LinkIcon, Folder, ChevronDown, ChevronUp, Users, Monitor } from 'lucide-react';

interface SenderProps {
  onNotification: (msg: string, type: 'success' | 'info' | 'error') => void;
  deviceName: string;
}

type PeerTransferStat = {
  peerId: string;
  deviceName: string;
  speed: string;
  progress: number;
  status: 'waiting' | 'transferring' | 'completed';
};

type ConnectionRoute = {
  isLan: boolean;
  isRelay: boolean;
  protocol: string;
};

export const Sender: React.FC<SenderProps> = ({ onNotification, deviceName }) => {
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
  const GHOST_GRACE_MS = 4000;

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

                const status: PeerTransferStat['status'] =
                    progress >= 100 ? 'completed' : hasTransferStarted && state === TransferState.TRANSFERRING ? 'transferring' : 'waiting';

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
              activeConnections.current.forEach(conn => updateConnectionStats(conn));
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

  const updateConnectionStats = async (conn: DataConnection): Promise<ConnectionRoute> => {
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

              const localIP = localCandidate?.address || localCandidate?.ip || '';
              const remoteIP = remoteCandidate?.address || remoteCandidate?.ip || '';
              const isRelayConnection = localCandidateType === 'relay' || remoteCandidateType === 'relay';
              const isLanConnection = !isRelayConnection && isPrivateIP(localIP) && isPrivateIP(remoteIP);
              route = { isLan: isLanConnection, isRelay: isRelayConnection, protocol };

              peerIsLAN.current.set(conn.peer, isLanConnection);

              if (activeConnections.current.size === 1) {
                  const networkType = isRelayConnection ? 'RELAY' : isLanConnection ? 'LAN' : 'P2P-WAN';
                  setConnectionStatus(`已连接 | ${protocol.toUpperCase()} | ${networkType}`);
              } else {
                  setConnectionStatus(`已连接 ${activeConnections.current.size} 个设备`);
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
    setIndividualStats([]);

    setState(TransferState.GENERATING_CODE);
    setConnectionStatus('');
    let expiresAt: number | undefined;
    const now = Date.now();
    if (expiryOption === '10m') expiresAt = now + 10 * 60 * 1000;
    if (expiryOption === '1h') expiresAt = now + 60 * 60 * 1000;
    if (expiryOption === '1d') expiresAt = now + 24 * 60 * 60 * 1000;
    const metadataWithConstraints: FileMetadata = { ...metadata, constraints: { expiresAt } };
    setMetadata(metadataWithConstraints);
    const iceConfig = await getIceConfig();
    const finalCode = customCodeInput.length === 4 ? customCodeInput : Math.floor(1000 + Math.random() * 9000).toString();
    const customPeer = new Peer(`aerodrop-${finalCode}`, {
      debug: peerDebugLevel,
      pingInterval: 5000,
      config: {
        iceServers: iceConfig.iceServers,
        iceCandidatePoolSize: iceConfig.iceCandidatePoolSize,
        iceTransportPolicy: iceConfig.iceTransportPolicy,
      }
    });
    setupPeerListeners(customPeer, finalCode, metadataWithConstraints);
  };

  const cleanupConnectionState = (conn: DataConnection) => {
      activeConnections.current.delete(conn);
      peerProgress.current.delete(conn.peer);
      peerRealtimeSpeed.current.delete(conn.peer);
      peerAverageSpeed.current.delete(conn.peer);
      activeSendingPeersRef.current.delete(conn.peer);
      ghostCandidateSinceRef.current.delete(conn.peer);
      removePeerName(conn.peer);

      const removedSessionId = peerSessionIdsRef.current.get(conn.peer);
      if (removedSessionId && sessionToPeerRef.current.get(removedSessionId) === conn.peer) {
          sessionToPeerRef.current.delete(removedSessionId);
      }
      peerSessionIdsRef.current.delete(conn.peer);

      updateConnectionStatusUI();

      if (isDestroyingRef.current) return;
      if (activeSendingPeersRef.current.size === 0) {
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

              if (unstableByState) {
                  const firstSeen = ghostCandidateSinceRef.current.get(conn.peer) ?? now;
                  ghostCandidateSinceRef.current.set(conn.peer, firstSeen);
                  if (now - firstSeen >= GHOST_GRACE_MS) {
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
      if (activeSendingPeersRef.current.has(conn.peer)) {
          return;
      }

      activeSendingPeersRef.current.add(conn.peer);
      setTimeout(() => {
          sendFileSequence(conn, startFileIndex, startByteOffset);
      }, 100);
  };

  const setupPeerListeners = (peer: Peer, code: string, sessionMetadata: FileMetadata) => {
      peerRef.current = peer;
      peer.on('open', () => {
          markConnectionSuccess(shareTelemetryRef.current, { code });
          setTransferCode(code);
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
              peerProgress.current.set(conn.peer, peerProgress.current.get(conn.peer) || 0);
              peerRealtimeSpeed.current.set(conn.peer, peerRealtimeSpeed.current.get(conn.peer) || 0);
              peerAverageSpeed.current.set(conn.peer, peerAverageSpeed.current.get(conn.peer) || 0);
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
                  onNotification(`检测到断点，正在从第 ${payload.fileIndex + 1} 个文件恢复...`, 'info');
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

  const sendFileSequence = async (conn: DataConnection, startFileIndex: number = 0, startByteOffset: number = 0) => {
    const files = fileListRef.current;
    if (!files.length) return;

    const currentSessionId = transferSessionId.current;
    activeTransfersCount.current += 1;

    const route = await updateConnectionStats(conn);

    const CHUNK_SIZE = route.isLan
      ? TRANSFER_CONFIG.CHUNK_SIZE_LAN
      : route.isRelay
        ? TRANSFER_CONFIG.CHUNK_SIZE_RELAY
        : TRANSFER_CONFIG.CHUNK_SIZE_WAN;
    const READ_BUFFER_SIZE = TRANSFER_CONFIG.READ_BUFFER_SIZE;

    const HIGH_WATER_MARK = route.isLan
      ? FLOW_CONTROL.HIGH_WATER_MARK_LAN
      : route.isRelay
        ? FLOW_CONTROL.HIGH_WATER_MARK_RELAY
        : FLOW_CONTROL.HIGH_WATER_MARK_WAN;
    const LOW_WATER_MARK = route.isLan
      ? FLOW_CONTROL.LOW_WATER_MARK_LAN
      : route.isRelay
        ? FLOW_CONTROL.LOW_WATER_MARK_RELAY
        : FLOW_CONTROL.LOW_WATER_MARK_WAN;

    let totalBytesSent = 0;
    let transferSucceeded = false;
    let lastBufferedAmount = 0;
    let lastUpdateTime = Date.now();
    let bytesInLastPeriod = 0;
    const startTime = Date.now();

    const peerId = conn.peer;
    peerProgress.current.set(peerId, 0);

    for(let i = 0; i < startFileIndex; i++) {
        totalBytesSent += files[i].size;
    }
    if (startByteOffset > 0) {
        totalBytesSent += startByteOffset;
    }

    const totalSize = metadata?.totalSize || 0;

    const dataChannel = (conn as any).dataChannel as RTCDataChannel | undefined;

    try {
        let fileStartByteOffset = startByteOffset;

        for (let i = startFileIndex; i < files.length; i++) {
            if (transferSessionId.current !== currentSessionId) return;
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

            while (fileOffset < file.size) {
                if (transferSessionId.current !== currentSessionId) return;
                if (!conn.open) throw new Error("Connection closed during transfer");

                const readSize = Math.min(READ_BUFFER_SIZE, file.size - fileOffset);
                const blobSlice = file.slice(fileOffset, fileOffset + readSize);
                const largeBuffer = await blobSlice.arrayBuffer();

                let bufferOffset = 0;
                while (bufferOffset < readSize) {
                    if (!conn.open) throw new Error("Connection closed");

                    if (dataChannel && dataChannel.bufferedAmount > HIGH_WATER_MARK) {
                        dataChannel.bufferedAmountLowThreshold = LOW_WATER_MARK;

                        await new Promise<void>((resolve, reject) => {
                            let settled = false;

                            const done = (err?: Error) => {
                                if (settled) return;
                                settled = true;
                                clearTimeout(timeoutId);
                                dataChannel.removeEventListener('bufferedamountlow', onLow);
                                dataChannel.removeEventListener('close', onClose);
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

                            const timeoutId = setTimeout(() => {
                                if (dataChannel.readyState !== 'open') {
                                    done(new Error("Data channel closed while waiting for buffer drain"));
                                    return;
                                }

                                if (dataChannel.bufferedAmount <= LOW_WATER_MARK) {
                                    done();
                                    return;
                                }

                                // 在极端网络下 bufferedamountlow 可能不会触发，超时后继续发送，避免死等。
                                done();
                            }, 5000);

                            if (dataChannel.readyState !== 'open') {
                                done(new Error("Data channel is not open"));
                                return;
                            }

                            if (dataChannel.bufferedAmount <= LOW_WATER_MARK) {
                                done();
                                return;
                            }

                            dataChannel.addEventListener('bufferedamountlow', onLow);
                            dataChannel.addEventListener('close', onClose);
                        });
                    }

                    const chunkEnd = Math.min(bufferOffset + CHUNK_SIZE, readSize);
                    const chunk = largeBuffer.slice(bufferOffset, chunkEnd);

                    try {
                        conn.send(chunk);
                    } catch (e) {
                         if (!conn.open) throw new Error("Connection closed during send");
                         await new Promise(r => setTimeout(r, 50));
                         try { conn.send(chunk); } catch(err) { throw err; }
                    }

                    const currentChunkSize = chunk.byteLength;
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
                            
                            peerRealtimeSpeed.current.set(peerId, effectiveSpeed);
                            peerAverageSpeed.current.set(peerId, realTotal / totalDuration);
                            if (totalSize > 0) {
                                const p = Math.min(100, Math.floor((realTotal / totalSize) * 100));
                                peerProgress.current.set(peerId, p);
                            }
                        }
                        
                        lastUpdateTime = now;
                        lastBufferedAmount = currentBuffered;
                        bytesInLastPeriod = 0;
                    }
                }
                fileOffset += readSize;
            }

            const completePayload: FileCompletePayload = { fileIndex: i };
            try { conn.send({ type: 'FILE_COMPLETE', payload: completePayload }); } catch(e) {}
        }

        try { conn.send({ type: 'ALL_FILES_COMPLETE' }); } catch(e) {}
        
        transferSucceeded = true;
        peerProgress.current.set(peerId, 100);
        peerRealtimeSpeed.current.set(peerId, 0);

        if (activeConnections.current.size === 1) {
            onNotification("文件发送完成！", 'success');
        }

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
        activeSendingPeersRef.current.delete(peerId);
        if (transferSessionId.current === currentSessionId) {
            activeTransfersCount.current -= 1;
            if (transferSucceeded && activeTransfersCount.current === 0) {
                setTotalProgress(100);
                setCurrentFileIndex(0);
            }
        }
    }
  };

  const stopSharing = () => {
    isDestroyingRef.current = true;
    transferSessionId.current += 1; 
    
    activeConnections.current.forEach(conn => {
        if (conn.open) {
            try { conn.send({ type: 'TRANSFER_CANCELLED' }); } catch(e) { console.error(e); }
            conn.close();
        }
    });
    activeConnections.current.clear();
    activeSendingPeersRef.current.clear();
    peerSessionIdsRef.current.clear();
    sessionToPeerRef.current.clear();
    ghostCandidateSinceRef.current.clear();

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
  const parseSpeedToBytesPerSec = (speedLabel: string): number => {
      const normalized = speedLabel.trim().toLowerCase();
      if (!normalized || normalized === '--' || normalized === '完成') return 0;
      const numeric = parseFloat(normalized);
      if (!Number.isFinite(numeric) || numeric <= 0) return 0;
      if (normalized.includes('gb')) return numeric * 1024 * 1024 * 1024;
      if (normalized.includes('mb')) return numeric * 1024 * 1024;
      if (normalized.includes('kb')) return numeric * 1024;
      if (normalized.includes('byte') || normalized.endsWith('b')) return numeric;
      return 0;
  };
  const totalBytes = metadata?.totalSize ?? 0;
  const transferredBytes = totalBytes > 0
    ? Math.floor((Math.max(0, Math.min(100, totalProgress)) / 100) * totalBytes)
    : 0;
  const remainingBytes = Math.max(0, totalBytes - transferredBytes);
  const peerRealtimeSpeeds = individualStats
    .filter((s) => s.status === 'transferring')
    .map((s) => parseSpeedToBytesPerSec(s.speed))
    .filter((n) => Number.isFinite(n) && n > 0);
  const slowestSpeedBytes = peerRealtimeSpeeds.length > 0 ? Math.min(...peerRealtimeSpeeds) : 0;
  const etaSpeedBytes = activeConnections.current.size > 1
    ? slowestSpeedBytes
    : (currentSpeedBytes > 0 ? currentSpeedBytes : avgSpeedBytes);
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
    <div className="w-full max-w-xl mx-auto p-4 md:p-6 bg-white dark:bg-slate-800 rounded-3xl shadow-xl border border-slate-100 dark:border-slate-700 transition-colors">
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-slate-800 dark:text-white">发送文件</h2>
        <p className="text-slate-500 dark:text-slate-400">点对点加密传输 (支持文件夹/多文件)</p>
      </div>

      {state === TransferState.IDLE && (
        <div
          className={`relative border-2 border-dashed rounded-3xl p-8 md:p-10 flex flex-col items-center justify-center cursor-pointer transition-all duration-300 group ${
            isDragOver
              ? 'border-brand-500 bg-brand-50 dark:bg-slate-700 scale-[1.02] shadow-xl'
              : 'border-slate-300 dark:border-slate-600 hover:border-brand-400 hover:bg-slate-50 dark:hover:bg-slate-800/50'
          }`}
        >
          <input type="file" id="file-upload" className="hidden" multiple onChange={handleFileSelect} />
          <input type="file" id="folder-upload" className="hidden" 
                 
                 webkitdirectory="" directory="" onChange={handleFolderSelect} 
          />
          
          <div className={`w-16 h-16 bg-brand-50 dark:bg-slate-700 text-brand-600 dark:text-brand-400 rounded-full flex items-center justify-center mb-4 transition-transform duration-300 ${isDragOver ? 'scale-110 rotate-12' : 'group-hover:scale-110'}`}>
            <Upload size={32} className={isDragOver ? 'animate-float text-brand-600 dark:text-brand-400' : 'text-brand-500 dark:text-brand-400'} />
          </div>
          <p className="text-lg font-medium text-slate-700 dark:text-slate-200">{isDragOver ? '松开添加' : '点击上传或拖拽'}</p>
          <p className="text-sm text-slate-400 mt-2 mb-4">支持多文件、文件夹</p>

          <label 
              htmlFor="folder-upload" 
              className="z-10 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-600 px-4 py-2 rounded-full text-sm hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-brand-600 transition-colors flex items-center gap-2 cursor-pointer shadow-sm"
              onClick={(e) => e.stopPropagation()}
          >
              <Folder size={14} /> 选择文件夹
          </label>
          <label htmlFor="file-upload" className="absolute inset-0 cursor-pointer"></label>
        </div>
      )}

      {state === TransferState.CONFIGURING && metadata && (
         <div className="space-y-6">
            <div className="bg-slate-50 dark:bg-slate-900 p-4 rounded-xl flex items-center gap-4 border border-slate-100 dark:border-slate-800 animate-slide-up">
               <div className="flex-1 min-w-0">
                  <h4 className="font-bold text-slate-800 dark:text-white">已选择 {metadata.files.length} 个文件</h4>
                  <p className="text-xs text-slate-500 dark:text-slate-400">总大小: {formatFileSize(metadata.totalSize)}</p>
               </div>
               <button onClick={stopSharing} className="text-slate-400 hover:text-red-500 transition-colors"><X size={20} /></button>
            </div>
            
            {metadata.files.length > 1 && (
            <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden animate-slide-up">
                <button onClick={() => setShowFileList(!showFileList)} className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 flex justify-between text-sm hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-slate-700 dark:text-slate-300">
                    <span>文件列表 ({metadata.files.length})</span>
                    {showFileList ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
                {showFileList && (
                    <div className="max-h-48 overflow-y-auto bg-white dark:bg-slate-800 border-t border-slate-100 dark:border-slate-700 p-1">
                        {metadata.files.map((f, i) => (
                            <div key={i} className="flex justify-between text-xs py-1.5 px-3 hover:bg-slate-50 dark:hover:bg-slate-700 rounded">
                                <span className="truncate flex-1 mr-4 text-slate-600 dark:text-slate-300">{f.name}</span>
                                <span className="text-slate-400 font-mono">{formatFileSize(f.size)}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
            )}

            <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                    <div>
                         <label className="text-xs text-slate-500 dark:text-slate-400 mb-1 block">有效期</label>
                         <select value={expiryOption} onChange={(e) => setExpiryOption(e.target.value)} className="w-full p-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm outline-none text-slate-800 dark:text-slate-100">
                            <option value="10m">10 分钟</option>
                            <option value="1h">1 小时</option>
                            <option value="1d">1 天</option>
                            <option value="never">永久</option>
                         </select>
                    </div>
                    <div>
                         <label className="text-xs text-slate-500 dark:text-slate-400 mb-1 block">自定义口令</label>
                         <input type="text" inputMode="numeric" placeholder="随机" value={customCodeInput} onChange={(e) => setCustomCodeInput(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))} className="w-full p-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm outline-none text-slate-800 dark:text-slate-100" />
                    </div>
                </div>
                {errorMsg && <div className="text-red-500 text-sm flex items-center gap-2 bg-red-50 dark:bg-red-900/20 p-2 rounded"><AlertCircle size={14} /> {errorMsg}</div>}
                <button onClick={startSharing} className="w-full bg-brand-600 text-white font-bold py-3.5 rounded-full hover:bg-brand-700 shadow-lg shadow-brand-600/25 transition-all duration-200 hover:shadow-xl hover:shadow-brand-600/30 hover:-translate-y-0.5">创建分享</button>
            </div>
         </div>
      )}

      {state === TransferState.GENERATING_CODE && (
          <div className="py-12 flex flex-col items-center justify-center text-center animate-pop-in">
              <Loader2 size={48} className="animate-spin text-brand-500 mb-4" />
              <h3 className="text-lg font-bold text-slate-800 dark:text-white">正在准备传输节点...</h3>
          </div>
      )}

      {(state === TransferState.WAITING_FOR_PEER || state === TransferState.PEER_CONNECTED || state === TransferState.TRANSFERRING) && (
        <div className="text-center space-y-6 animate-pop-in">
           <div className="relative inline-block" onClick={handleCopyCode}>
              <div className={`text-4xl md:text-6xl font-mono font-bold tracking-widest px-8 py-4 rounded-2xl border-2 cursor-pointer transition-all duration-300 ${copied ? 'bg-green-100 border-green-300 text-green-700' : 'bg-brand-50 border-brand-100 text-brand-600 dark:bg-slate-900 dark:border-slate-700 dark:text-brand-400'}`}>
                  {transferCode}
              </div>
           </div>

           <div className={`max-w-xs mx-auto bg-slate-50 dark:bg-slate-900 p-3 rounded-lg border flex items-center gap-2 ${linkCopied ? 'border-green-200 bg-green-50' : 'border-slate-200 dark:border-slate-700'}`}>
              <div className="flex-1 min-w-0 text-left">
                  <div className="text-xs text-slate-400">分享链接</div>
                  <div className="text-sm font-mono text-slate-600 dark:text-slate-300 truncate select-all">{shareLink}</div>
              </div>
              <button onClick={handleCopyLink} className="p-2"><LinkIcon size={18} /></button>
           </div>

           <div className="flex justify-center gap-6 text-sm text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-900 py-3 rounded-lg">
               <span>有效期: {remainingTime}</span>
               <span>状态: <span className="font-bold text-brand-600">{connectionStatus || (state === TransferState.TRANSFERRING ? '传输中' : '等待连接')}</span></span>
           </div>

           {individualStats.length > 0 && (
              <div className="bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-100 dark:border-slate-700 overflow-hidden mt-2 animate-slide-up text-left">
                <div className="px-4 py-2 bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-500 dark:text-slate-400 flex justify-between items-center">
                    <span>设备传输列表 ({individualStats.length})</span>
                    <Monitor size={14} />
                </div>
                <div className="divide-y divide-slate-100 dark:divide-slate-700 max-h-52 overflow-y-auto">
                    {individualStats.map((stat) => (
                        <div key={stat.peerId} className="px-4 py-2.5">
                            <div className="flex items-center justify-between text-xs">
                                <div className="flex items-center gap-2 min-w-0">
                                    <div className={`w-2 h-2 rounded-full ${stat.status === 'completed' ? 'bg-green-500' : stat.status === 'transferring' ? 'bg-brand-500 animate-pulse' : 'bg-slate-400'}`}></div>
                                    <span className="text-slate-700 dark:text-slate-200 truncate" title={stat.peerId}>{stat.deviceName}</span>
                                </div>
                                <div className="flex items-center gap-3">
                                    <span className={`font-medium ${stat.status === 'completed' ? 'text-green-600' : stat.status === 'transferring' ? 'text-brand-600' : 'text-slate-500'}`}>
                                        {stat.status === 'completed' ? '已完成' : stat.status === 'transferring' ? `${stat.progress}%` : '等待接收'}
                                    </span>
                                    <span className="text-slate-700 dark:text-slate-300 font-mono w-16 text-right tabular-nums">{stat.speed}</span>
                                </div>
                            </div>
                            <div className="mt-2 w-full bg-slate-200 dark:bg-slate-700 rounded-full h-1.5 overflow-hidden">
                                <div className={`h-full transition-all duration-300 ${stat.status === 'completed' ? 'bg-green-500' : 'bg-brand-500'}`} style={{ width: `${Math.max(0, Math.min(100, stat.progress))}%` }} />
                            </div>
                        </div>
                    ))}
                </div>
              </div>
           )}

           {state === TransferState.TRANSFERRING && (
               <div className="w-full space-y-5">
                   <div className="flex flex-col items-center gap-2">
                       {totalProgress === 100 && activeTransfersCount.current === 0 ? (
                           <Check size={32} className="text-green-500" />
                       ) : (
                           <Loader2 size={32} className="animate-spin text-brand-500" />
                       )}
                       <div className="text-center">
                           <p className="text-lg font-bold text-slate-700 dark:text-slate-200">
                               {totalProgress === 100 && activeTransfersCount.current === 0 ? '传输完成' : '正在发送...'}
                           </p>
                           {activeConnections.current.size > 1 ? (
                               <p className="text-sm text-slate-500 dark:text-slate-400 font-medium flex items-center gap-1 justify-center mt-1">
                                  <Users size={14} /> 正在向 {activeConnections.current.size} 个设备传输
                               </p>
                           ) : (
                               <p className="text-sm text-slate-500 dark:text-slate-400 font-medium">
                                   {currentFileIndex + 1}/{metadata?.files.length}: {fileList[currentFileIndex]?.name}
                               </p>
                           )}
                       </div>
                   </div>

                   <div className="space-y-2">
                       <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400 px-1">
                           <span>{activeConnections.current.size > 1 ? '总进度 (平均)' : '总进度'}</span>
                           <span>{totalProgress}%</span>
                       </div>
                       <div className="w-full bg-slate-100 dark:bg-slate-700 rounded-full h-3 overflow-hidden">
                           <div 
                               className={`h-full transition-all duration-300 relative ${totalProgress === 100 ? 'bg-green-500' : 'bg-brand-500'}`}
                               style={{ width: `${totalProgress}%` }}
                           >
                               <div className="absolute inset-0 bg-white/20 animate-[shimmer_2s_infinite]"></div>
                           </div>
                       </div>
                       <div className="flex justify-between text-[11px] text-slate-500 dark:text-slate-400 px-1">
                           <span>{formatFileSize(transferredBytes)} / {formatFileSize(totalBytes)}</span>
                           <span>预计剩余 {overallEta}</span>
                       </div>
                   </div>

                   <div className="grid grid-cols-2 gap-3">
                       <div className="bg-slate-50 dark:bg-slate-900 p-3 rounded-xl border border-slate-100 dark:border-slate-700 text-center">
                           <p className="text-[10px] text-slate-400 uppercase tracking-wider mb-0.5">总实时速度</p>
                           <p className="text-brand-600 dark:text-brand-400 font-bold font-mono">{currentSpeed}</p>
                       </div>
                       <div className="bg-slate-50 dark:bg-slate-900 p-3 rounded-xl border border-slate-100 dark:border-slate-700 text-center">
                           <p className="text-[10px] text-slate-400 uppercase tracking-wider mb-0.5">总平均速度</p>
                           <p className="text-blue-600 dark:text-blue-400 font-bold font-mono">{avgSpeed}</p>
                       </div>
                   </div>

                </div>
            )}

           <button onClick={stopSharing} className="w-full bg-red-50 text-red-600 font-bold py-3.5 rounded-full hover:bg-red-100 transition-colors border border-red-100 flex items-center justify-center gap-2">
             <X size={18} /> 停止分享
           </button>
        </div>
      )}

      {state === TransferState.ERROR && (
          <div className="text-center py-8 animate-pop-in">
              <div className="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4"><AlertCircle size={32} /></div>
              <h3 className="text-lg font-bold">发生错误</h3>
              <p className="text-slate-500 mt-2 mb-6">{errorMsg}</p>
              <button onClick={stopSharing} className="px-6 py-2 bg-slate-200 rounded-full">返回</button>
          </div>
      )}
    </div>
  );
};
