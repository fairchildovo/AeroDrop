import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import Peer, { MediaConnection, DataConnection } from 'peerjs';
import { getIceConfig } from '../services/stunService';
import { ScreenShareUI, ScreenShareViewerConnectingStage } from './screen-share/ScreenShareUI';

interface ScreenShareProps {
  onNotification: (message: string, type: 'success' | 'info' | 'error') => void;
  initialViewId?: string;
}

export const ScreenShare: React.FC<ScreenShareProps> = ({ onNotification, initialViewId }) => {
  const [isSharing, setIsSharing] = useState(false);
  const [isViewing, setIsViewing] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [viewerConnectingStage, setViewerConnectingStage] = useState<ScreenShareViewerConnectingStage>('');
  const [error, setError] = useState<string | null>(null);
  const [peerId, setPeerId] = useState<string | null>(null);
  const [isPeerReady, setIsPeerReady] = useState(false);
  const [copied, setCopied] = useState(false);
  const [viewerCount, setViewerCount] = useState(0);
  const [targetSharerId, setTargetSharerId] = useState<string | null>(null);


  const [needsPlayClick, setNeedsPlayClick] = useState(false);


  const hasInitialConnectedRef = useRef(false);


  const videoRef = useRef<HTMLVideoElement>(null);


  const streamRef = useRef<MediaStream | null>(null);


  const peerRef = useRef<Peer | null>(null);


  const mediaConnectionRef = useRef<MediaConnection | null>(null);


  const activeCallsRef = useRef<MediaConnection[]>([]);

  // 存储所有连接的观看者的数据通道（用于广播画质状态）
  const activeDataConnectionsRef = useRef<DataConnection[]>([]);
  // 观看者端：存储与分享者的数据通道
  const dataConnectionRef = useRef<DataConnection | null>(null);

  // 存储观看者的心跳时间戳 { peerId: timestamp }
  const viewerHeartbeatsRef = useRef<Record<string, number>>({});
  // 观看者端：心跳定时器
  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // 自动重连相关
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isManualStopRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const remoteShareEndedRef = useRef(false);
  const remoteShareEndHandledRef = useRef(false);
  const MAX_RECONNECT_ATTEMPTS = 5;
  // 观看者端：连接过程的全局超时定时器
  const connectingTimeoutRef = useRef<NodeJS.Timeout | null>(null);


  const audioContextRef = useRef<AudioContext | null>(null);


  const bandwidthMonitorsRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());


  const [qualityLevel, setQualityLevel] = useState<'high' | 'medium' | 'low'>('high');
  // 观看者端：当前的画质状态
  const [remoteQuality, setRemoteQuality] = useState<'high' | 'medium' | 'low'>('high');


  const qualityLevelRef = useRef<'high' | 'medium' | 'low'>('high');


  const qualityLabels = useMemo(() => ({
    high: '原画',
    medium: '高清',
    low: '流畅',
  }), []);


  const bitrateLimits = useMemo(() => ({
    high: { min: 2000000, max: 100000000 },    // 原画：最大 100Mbps，起步 2Mbps
    medium: { min: 500000, max: 8000000 },     // 高清：提升至 8Mbps，减少文字边缘糊化
    low: { min: 100000, max: 2500000 },        // 流畅：仍保留可读性，减少过度压缩
  }), []);

  const qualityCaptureConstraints = useMemo(() => ({
    high: { maxFrameRate: 60, scaleResolutionDownBy: 1 },
    medium: { maxFrameRate: 45, scaleResolutionDownBy: 1 },
    low: { maxFrameRate: 24, scaleResolutionDownBy: 1.25 },
  }), []);

  const buildDisplayMediaConstraints = useCallback((): DisplayMediaStreamOptions => {
    const dpr = window.devicePixelRatio || 1;
    const baseWidth = Math.floor(window.screen.width * dpr);
    const baseHeight = Math.floor(window.screen.height * dpr);
    const idealWidth = Math.min(3840, Math.max(1280, baseWidth || 1920));
    const idealHeight = Math.min(2160, Math.max(720, baseHeight || 1080));

    return {
      video: {
        cursor: 'always',
        displaySurface: 'monitor',
        width: { ideal: idealWidth },
        height: { ideal: idealHeight },
        frameRate: { ideal: 60, max: 60 },
      } as MediaTrackConstraints,
      audio: true,
    };
  }, []);

  const applyLocalTrackConstraints = useCallback(async (
    stream: MediaStream | null,
    level: 'high' | 'medium' | 'low',
  ) => {
    if (!stream) return;
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack || !videoTrack.applyConstraints) return;
    const preset = qualityCaptureConstraints[level];
    try {
      await videoTrack.applyConstraints({
        frameRate: { ideal: preset.maxFrameRate, max: preset.maxFrameRate },
      });
    } catch (err) {
      console.warn('Failed to apply local track constraints:', err);
    }
  }, [qualityCaptureConstraints]);


  const applyBitrateConstraints = useCallback(async (
    peerConnection: RTCPeerConnection,
    level: 'high' | 'medium' | 'low'
  ) => {
    const senders = peerConnection.getSenders();
    const videoSender = senders.find(s => s.track?.kind === 'video');

    if (videoSender) {
      // 1. 尝试强制使用 VP9 编码（效率更高，同码率画质更好）
      // 注意：这需要浏览器支持，Chrome/Edge 默认支持
      const codecs = RTCRtpReceiver.getCapabilities('video')?.codecs;
      const vp9Codec = codecs?.find(c => c.mimeType === 'video/VP9');

      if (vp9Codec) {
        // 如果支持 VP9，尝试将其设置为首选
        // 注意：setParameters 不支持直接切换 codec，这里主要是为了后续 SDP 协商
        // 实际 codec 选择主要由 SDP 决定，但我们可以尝试在参数中寻找相关设置
        // 目前标准 API 中 setParameters 主要用于调整编码参数（码率、分辨率等）
      }

      const params = videoSender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }


      if (level === 'high') {
        // 原画模式：显式设置极高码率 (100Mbps)
        // 提升至 100Mbps 以彻底消除 1080p60fps 下的动态画面涂抹，跑满局域网带宽
        params.encodings[0].maxBitrate = 100000000;
        params.encodings[0].maxFramerate = qualityCaptureConstraints.high.maxFrameRate;
        params.encodings[0].scaleResolutionDownBy = qualityCaptureConstraints.high.scaleResolutionDownBy;

        // 尝试设置编码优先级
        if ('networkPriority' in params.encodings[0]) {
          (params.encodings[0] as any).networkPriority = 'high';
        }
      } else {
        const limits = bitrateLimits[level];
        params.encodings[0].maxBitrate = limits.max;
        params.encodings[0].maxFramerate = qualityCaptureConstraints[level].maxFrameRate;
        params.encodings[0].scaleResolutionDownBy = qualityCaptureConstraints[level].scaleResolutionDownBy;
      }

      // 共享场景优先可读性：在带宽波动时尽量保分辨率而不是先降清晰度
      if ('degradationPreference' in (params as any)) {
        (params as any).degradationPreference = level === 'low' ? 'balanced' : 'maintain-resolution';
      }

      try {
        await videoSender.setParameters(params);
        console.log(`Applied ${level} quality bitrate: ${bitrateLimits[level].max / 1000000}Mbps`);
      } catch (err) {
        console.error('Failed to set bitrate parameters:', err);
      }
    }
  }, [bitrateLimits, qualityCaptureConstraints]);


  useEffect(() => {
    qualityLevelRef.current = qualityLevel;

    // 当画质改变时，广播给所有连接的观看者
    activeDataConnectionsRef.current.forEach(conn => {
      if (conn.open) {
        conn.send({ type: 'quality', value: qualityLevel });
      }
    });

    // 画质档位切换后，立即对本地采集轨道和所有已连接观看者应用新参数，减少“切档后还模糊几秒”的体感
    applyLocalTrackConstraints(streamRef.current, qualityLevel);
    activeCallsRef.current.forEach((call) => {
      if (call.peerConnection) {
        applyBitrateConstraints(call.peerConnection, qualityLevel);
      }
    });
  }, [qualityLevel, applyBitrateConstraints, applyLocalTrackConstraints]);


  // 监听连接状态，一旦结束连接过程（无论是成功还是失败），就清除超时定时器
  useEffect(() => {
    if (!isConnecting && connectingTimeoutRef.current) {
      clearTimeout(connectingTimeoutRef.current);
      connectingTimeoutRef.current = null;
    }
  }, [isConnecting]);


  const startBandwidthMonitoring = useCallback((call: MediaConnection) => {
    const pc = call.peerConnection;
    if (!pc) return;
    if (bandwidthMonitorsRef.current.has(call.peer)) return;

    let lastBytesSent = 0;
    let lastPacketsSent = 0;
    let lastPacketsLost = 0;
    let lastTimestamp = Date.now();
    let consecutiveLowBandwidth = 0;
    let consecutiveHighBandwidth = 0;
    const monitorStartedAt = Date.now();
    const BANDWIDTH_WARMUP_MS = 8000;

    const monitor = async () => {
      try {
        const stats = await pc.getStats();
        let currentBytesSent = 0;
        let packetsLost = 0;
        let packetsSent = 0;

        stats.forEach((report) => {
          if (report.type === 'outbound-rtp' && report.kind === 'video') {
            currentBytesSent = report.bytesSent || 0;
            packetsSent = report.packetsSent || 0;
          }
          if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
            packetsLost = report.packetsLost || 0;
          }
        });

        const now = Date.now();
        const timeDiff = (now - lastTimestamp) / 1000;
        const bytesDiff = currentBytesSent - lastBytesSent;
        const currentBitrate = (bytesDiff * 8) / timeDiff;
        const sentDiff = Math.max(0, packetsSent - lastPacketsSent);
        const lostDiff = Math.max(0, packetsLost - lastPacketsLost);
        const packetLossRate = (sentDiff + lostDiff) > 0 ? (lostDiff / (sentDiff + lostDiff)) : 0;

        lastBytesSent = currentBytesSent;
        lastPacketsSent = packetsSent;
        lastPacketsLost = packetsLost;
        lastTimestamp = now;


        const currentQuality = qualityLevelRef.current;
        const limits = bitrateLimits[currentQuality];

        // 连接初期带宽估计和丢包统计波动很大，先预热避免误降档导致“刚连上先糊”
        if (now - monitorStartedAt < BANDWIDTH_WARMUP_MS) {
          return;
        }



        // 清晰优先策略：
        // 默认保持高清/原画，只有在“持续且明显卡顿”时才降档。
        const severeForHigh =
          packetLossRate > 0.12 || (packetLossRate > 0.03 && currentBitrate < limits.min * 0.45);
        const severeForMedium =
          packetLossRate > 0.18 || (packetLossRate > 0.05 && currentBitrate < limits.min * 0.35);

        const shouldDowngrade =
          currentQuality === 'high' ? severeForHigh : currentQuality === 'medium' ? severeForMedium : false;

        if (shouldDowngrade) {
          consecutiveLowBandwidth++;
          consecutiveHighBandwidth = 0;

          // 每 2 秒检测一次：
          // high -> medium 需要连续 12 秒严重卡顿；
          // medium -> low 需要连续 16 秒严重卡顿。
          const lowThreshold = currentQuality === 'high' ? 6 : 8;
          if (consecutiveLowBandwidth >= lowThreshold) {
            if (currentQuality === 'high') {
              setQualityLevel('medium');
              await applyBitrateConstraints(pc, 'medium');
              onNotification('检测到持续严重卡顿，已降至高清模式', 'info');
            } else if (currentQuality === 'medium') {
              setQualityLevel('low');
              await applyBitrateConstraints(pc, 'low');
              onNotification('网络极不稳定，已切换到流畅模式', 'info');
            }
            consecutiveLowBandwidth = 0;
          }
        } else if (packetLossRate < 0.005) { // 只有丢包率极低时才考虑升级
          consecutiveHighBandwidth++;
          consecutiveLowBandwidth = 0;

          if (consecutiveHighBandwidth >= 5) {
            if (currentQuality === 'low') {
              setQualityLevel('medium');
              await applyBitrateConstraints(pc, 'medium');
              onNotification('网络好转，已恢复高清画质', 'info');
            } else if (currentQuality === 'medium') {
              setQualityLevel('high');
              await applyBitrateConstraints(pc, 'high');
              onNotification('网络良好，已切换回原画模式', 'info');
            }
            consecutiveHighBandwidth = 0;
          }
        } else {
          consecutiveLowBandwidth = 0;
          consecutiveHighBandwidth = 0;
        }
      } catch (err) {
        console.error('Bandwidth monitoring error:', err);
      }
    };


    const timer = setInterval(monitor, 2000);
    bandwidthMonitorsRef.current.set(call.peer, timer);
  }, [bitrateLimits, applyBitrateConstraints, onNotification]);


  const stopBandwidthMonitoring = useCallback((peerId?: string) => {
    if (peerId) {
      const timer = bandwidthMonitorsRef.current.get(peerId);
      if (timer) {
        clearInterval(timer);
        bandwidthMonitorsRef.current.delete(peerId);
      }
      return;
    }

    bandwidthMonitorsRef.current.forEach((timer) => clearInterval(timer));
    bandwidthMonitorsRef.current.clear();
  }, []);

  const getUniqueViewerCount = useCallback(() => {
    return new Set(activeCallsRef.current.map((c) => c.peer)).size;
  }, []);

  const syncViewerCount = useCallback(() => {
    setViewerCount(getUniqueViewerCount());
  }, [getUniqueViewerCount]);

  const addActiveCall = useCallback((call: MediaConnection) => {
    if (activeCallsRef.current.includes(call)) {
      return false;
    }
    const before = getUniqueViewerCount();
    activeCallsRef.current.push(call);
    const after = getUniqueViewerCount();
    setViewerCount(after);
    return after > before;
  }, [getUniqueViewerCount]);

  const removeActiveCall = useCallback((call: MediaConnection) => {
    const beforeLength = activeCallsRef.current.length;
    activeCallsRef.current = activeCallsRef.current.filter(c => c !== call);

    if (beforeLength !== activeCallsRef.current.length) {
      syncViewerCount();
      stopBandwidthMonitoring(call.peer);
    }

    if (activeCallsRef.current.length === 0) {
      stopBandwidthMonitoring();
    }
  }, [syncViewerCount, stopBandwidthMonitoring]);


  const generatePeerId = useCallback(() => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const randomValues = new Uint32Array(6);
    crypto.getRandomValues(randomValues);
    let id = '';
    for (let i = 0; i < 6; i++) {
      id += chars.charAt(randomValues[i] % chars.length);
    }
    return `AERO-${id}`;
  }, []);


  const initializePeer = useCallback(async () => {
    if (peerRef.current) {
      peerRef.current.destroy();
    }

    const iceConfig = await getIceConfig();
    const id = generatePeerId();
    const useSecurePeerServer = window.location.protocol === 'https:';
    const peer = new Peer(id, {
      debug: 0,
      secure: useSecurePeerServer,
      pingInterval: 5000, // 缩短心跳间隔以保持 VPN 隧道活跃
      config: {
        iceServers: iceConfig.iceServers,
        iceCandidatePoolSize: iceConfig.iceCandidatePoolSize,
        iceTransportPolicy: 'all',
      }
    });

    peer.on('open', (openedId) => {
      console.log('Peer ID:', openedId);
      setPeerId(openedId);
      setIsPeerReady(true);
      onNotification(`连接 ID: ${openedId}`, 'info');
    });

    // 监听传入的数据连接（用于发送画质状态给观看者）
    peer.on('connection', (conn) => {
      console.log('Data connection received from:', conn.peer);
      activeDataConnectionsRef.current.push(conn);

      // 初始化该观看者的心跳时间
      viewerHeartbeatsRef.current[conn.peer] = Date.now();

      conn.on('open', () => {
        // 连接建立后立即发送当前画质
        conn.send({ type: 'quality', value: qualityLevelRef.current });
      });

      conn.on('data', (data: any) => {
        if (data && data.type === 'heartbeat') {
          // 更新心跳时间戳
          viewerHeartbeatsRef.current[conn.peer] = Date.now();
        }
      });

      conn.on('close', () => {
        activeDataConnectionsRef.current = activeDataConnectionsRef.current.filter(c => c !== conn);
        delete viewerHeartbeatsRef.current[conn.peer];
      });

      conn.on('error', (err) => {
        console.error('Data connection error:', err);
        activeDataConnectionsRef.current = activeDataConnectionsRef.current.filter(c => c !== conn);
        delete viewerHeartbeatsRef.current[conn.peer];
      });
    });

    peer.on('call', (call) => {

      if (streamRef.current) {
        call.answer(streamRef.current);
        const hasNewViewer = addActiveCall(call);
        if (hasNewViewer) {
          onNotification('有观看者加入', 'info');
        }


        if (call.peerConnection) {
          const currentQuality = qualityLevelRef.current;
          applyBitrateConstraints(call.peerConnection, currentQuality);
          // 某些浏览器在初始协商后才完全挂载 sender 参数，短延迟重复应用可减少前几秒模糊
          setTimeout(() => {
            if (call.peerConnection && call.open) {
              applyBitrateConstraints(call.peerConnection, qualityLevelRef.current);
            }
          }, 1200);
          startBandwidthMonitoring(call);
        }

        call.on('close', () => {
          removeActiveCall(call);
        });

        call.on('error', (err) => {
          console.error('Call error:', err);
          removeActiveCall(call);
        });
      }
    });

    peer.on('error', (err) => {
      console.error('Peer error:', err);
      setError(`PeerJS 错误: ${err.message}`);
      setIsPeerReady(false);
    });

    peer.on('disconnected', () => {
      console.log('Peer disconnected');
      setIsPeerReady(false);
    });

    peerRef.current = peer;
    return peer;
  }, [generatePeerId, onNotification, applyBitrateConstraints, startBandwidthMonitoring, addActiveCall, removeActiveCall]);


  // 分享者端：定期检查观看者心跳，移除断开的连接
  useEffect(() => {
    if (!isSharing) return;

    const checkInterval = setInterval(() => {
      const now = Date.now();
      const timeoutThreshold = 10000; // 10秒未收到心跳视为断开

      const deadPeers: string[] = [];

      // 检查所有活跃的数据连接
      activeDataConnectionsRef.current.forEach(conn => {
        const lastHeartbeat = viewerHeartbeatsRef.current[conn.peer];
        if (lastHeartbeat && now - lastHeartbeat > timeoutThreshold) {
          console.log(`Viewer ${conn.peer} timed out, closing connection`);
          deadPeers.push(conn.peer);
          conn.close();
        }
      });

      if (deadPeers.length > 0) {
        // 关闭对应的媒体连接
        activeCallsRef.current.forEach(call => {
          if (deadPeers.includes(call.peer)) {
            call.close();
          }
        });

        // 兜底同步，避免极端情况下 close 事件丢失导致观看人数未更新
        syncViewerCount();
      }
    }, 5000); // 每5秒检查一次

    return () => clearInterval(checkInterval);
  }, [isSharing, syncViewerCount]);



  const createDummyStream = useCallback(() => {

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(console.error);
      audioContextRef.current = null;
    }


    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = 'black';
      ctx.fillRect(0, 0, 1, 1);
    }
    const videoStream = canvas.captureStream(1);



    const audioContext = new AudioContext();
    audioContextRef.current = audioContext;

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();


    gainNode.gain.value = 0;


    const destination = audioContext.createMediaStreamDestination();
    oscillator.connect(gainNode);
    gainNode.connect(destination);


    oscillator.start();


    const combinedStream = new MediaStream();


    videoStream.getVideoTracks().forEach(track => {
      combinedStream.addTrack(track);
    });


    destination.stream.getAudioTracks().forEach(track => {
      combinedStream.addTrack(track);
    });

    console.log('Created dummy stream with tracks:', {
      video: combinedStream.getVideoTracks().length,
      audio: combinedStream.getAudioTracks().length
    });

    return combinedStream;
  }, []);

  const broadcastShareEnded = useCallback((reason: 'stopped' | 'window_closed' = 'stopped') => {
    activeDataConnectionsRef.current.forEach((conn) => {
      if (!conn.open) return;
      try {
        conn.send({ type: 'share-ended', reason });
      } catch {
        // Ignore best-effort notify errors.
      }
    });
  }, []);


  const stopViewing = useCallback((isManual = true) => {
    // 标记是否为手动停止
    isManualStopRef.current = isManual;

    if (connectingTimeoutRef.current) {
      clearTimeout(connectingTimeoutRef.current);
      connectingTimeoutRef.current = null;
    }

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }

    if (mediaConnectionRef.current) {
      mediaConnectionRef.current.close();
      mediaConnectionRef.current = null;
    }

    if (dataConnectionRef.current) {
      dataConnectionRef.current.close();
      dataConnectionRef.current = null;
    }

    if (peerRef.current) {
      peerRef.current.destroy();
      peerRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    streamRef.current = null;
    setIsViewing(false);
    setIsConnecting(false);
    setViewerConnectingStage('');

    // 只有手动停止时才清除目标ID，方便重连
    if (isManual) {
      setTargetSharerId(null);
      setError(null);
      reconnectAttemptsRef.current = 0;
      remoteShareEndedRef.current = false;
      remoteShareEndHandledRef.current = false;
    }
  }, []);

  const handleRemoteShareEnded = useCallback((reason = '共享已结束') => {
    if (remoteShareEndHandledRef.current) return;
    remoteShareEndHandledRef.current = true;
    remoteShareEndedRef.current = true;
    stopViewing(false);
    setError(reason);
    onNotification(reason, 'info');
  }, [onNotification, stopViewing]);


  const connectToSharer = useCallback(async (sharerId: string, isRetry = false) => {

    // 如果是新的连接请求（非重连），重置重连计数
    if (!isRetry) {
      reconnectAttemptsRef.current = 0;
      isManualStopRef.current = false;
      remoteShareEndedRef.current = false;
      remoteShareEndHandledRef.current = false;
    }

    if (peerRef.current) {
      peerRef.current.destroy();
      peerRef.current = null;
    }
    if (mediaConnectionRef.current) {
      mediaConnectionRef.current.close();
      mediaConnectionRef.current = null;
    }

    setError(null);
    setIsConnecting(true);
    setViewerConnectingStage('fetching_ice');
    setTargetSharerId(sharerId);

    // 设置全局连接超时（弱网场景下放宽）
    // 如果超时内没有建立连接（没有进入 isViewing 状态），则判定失败
    if (connectingTimeoutRef.current) clearTimeout(connectingTimeoutRef.current);
    connectingTimeoutRef.current = setTimeout(() => {
      // 检查是否还在连接中（如果没有成功进入 viewing，且没有被手动取消）
      // 注意：这里无法直接访问最新的 state，但可以通过清理函数触发
      console.log('Global connection timed out');
      setError('连接超时，无法建立 P2P 通道，请检查网络或防火墙');
      setIsConnecting(false);
      // 触发一次清理，但不标记为手动停止，以便允许用户重试
      stopViewing(false);
    }, 20000);

    // 如果是重连尝试，显示正在重连的状态
    if (isRetry) {
      onNotification(`正在尝试重连 (${reconnectAttemptsRef.current + 1}/${MAX_RECONNECT_ATTEMPTS})...`, 'info');
    }

    const iceConfig = await getIceConfig();
    setViewerConnectingStage('connecting_signaling');
    const useSecurePeerServer = window.location.protocol === 'https:';
    const peer = new Peer({
      debug: 0,
      secure: useSecurePeerServer,
      pingInterval: 5000,
      config: {
        iceServers: iceConfig.iceServers,
        iceCandidatePoolSize: iceConfig.iceCandidatePoolSize,
        iceTransportPolicy: 'all',
      }
    });

    peerRef.current = peer;

    peer.on('open', () => {
      console.log('Viewer peer opened, calling:', sharerId);
      // 连接成功，重置重连计数
      reconnectAttemptsRef.current = 0;
      setViewerConnectingStage('connecting_media');

      // 1. 建立数据连接（用于接收画质信息 和 发送心跳）
      const dataConn = peer.connect(sharerId);

      dataConn.on('open', () => {
        console.log('Data connection opened');

        // 启动心跳发送（每3秒一次）
        if (heartbeatIntervalRef.current) clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = setInterval(() => {
          if (dataConn.open) {
            dataConn.send({ type: 'heartbeat' });
          }
        }, 3000);
      });

      dataConn.on('data', (data: any) => {
        console.log('Received data:', data);
        if (data && data.type === 'quality' && data.value) {
          setRemoteQuality(data.value as 'high' | 'medium' | 'low');
          return;
        }
        if (data && data.type === 'share-ended') {
          const reasonLabel = data.reason === 'window_closed' ? '共享方已离开页面，屏幕共享已结束' : '共享方已停止共享';
          handleRemoteShareEnded(reasonLabel);
        }
      });

      dataConn.on('error', (err) => {
        console.error('Data connection error:', err);
      });

      dataConnectionRef.current = dataConn;


      // 2. 建立媒体连接
      const dummyStream = createDummyStream();


      const call = peer.call(sharerId, dummyStream);

      if (!call) {
        setError('无法发起连接，请检查连接 ID');
        setIsConnecting(false);
        return;
      }

      setViewerConnectingStage('waiting_stream');
      let hasReceivedStream = false;

      call.on('stream', (remoteStream) => {
        if (hasReceivedStream) {
          console.log('Stream event fired again, skipping duplicate handling');
          return;
        }
        hasReceivedStream = true;


        const audioTracks = remoteStream.getAudioTracks();
        const videoTracks = remoteStream.getVideoTracks();

        // 关键优化：移除播放缓冲延迟 (Jitter Buffer)
        // 跨网络时，浏览器默认会有较大的抖动缓冲，导致"追赶"现象
        // 强制接收端尽可能实时播放
        if (typeof (window as any).RTCRtpReceiver !== 'undefined' && 'playoutDelayHint' in (window as any).RTCRtpReceiver.prototype) {
          // 注意：这里我们无法直接获取 receiver 实例，只能尝试通过 track 设置
          // 但实际上 playoutDelayHint 是 receiver 的属性。
          // 对于 PeerJS，我们可以在 on('track') 时处理，但这里我们通过 hack 方式：
          // 如果浏览器支持，在 video 元素上也尽量设置低延迟属性
        }

        // 补充：直接设置接收端 receiver 的 playoutDelayHint
        // 我们需要遍历 peer connection 的 receivers
        if (peerRef.current) {
          Object.values(peerRef.current.connections).forEach((conns: any) => {
            conns.forEach((conn: any) => {
              if (conn.peerConnection) {
                const receivers = conn.peerConnection.getReceivers();
                receivers.forEach((receiver: any) => {
                  if (receiver.track?.kind === 'video' && 'playoutDelayHint' in receiver) {
                    receiver.playoutDelayHint = 0; // 0 表示尽可能实时
                    console.log('Set playoutDelayHint to 0 for real-time latency');
                  }
                });
              }
            });
          });
        }

        console.log('Received remote stream:', {
          audioTracks: audioTracks.length,
          videoTracks: videoTracks.length,
          audioDetails: audioTracks.map(t => ({ label: t.label, enabled: t.enabled, muted: t.muted })),
          videoDetails: videoTracks.map(t => ({ label: t.label, enabled: t.enabled }))
        });


        streamRef.current = remoteStream;

        setIsViewing(true);
        setIsConnecting(false);
        setNeedsPlayClick(false);
        onNotification('已连接到屏幕共享', 'success');
      });

      call.on('close', () => {
        console.log('Call closed');

        if (remoteShareEndedRef.current) {
          handleRemoteShareEnded('共享方已结束共享');
          return;
        }

        // 只有非手动停止时，才触发重连逻辑
        if (!isManualStopRef.current) {
          console.log('Unexpected disconnection, attempting reconnect...');
          stopViewing(false); // 不清除 targetId

          if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttemptsRef.current += 1;
            const delay = Math.min(2000 * reconnectAttemptsRef.current, 10000); // 指数退避

            reconnectTimerRef.current = setTimeout(() => {
              connectToSharer(sharerId, true);
            }, delay);

            setError(`连接断开，${delay / 1000}秒后尝试重连...`);
          } else {
            setError('连接断开，已达到最大重试次数，请手动重试');
            onNotification('屏幕共享连接断开', 'error');
          }
        } else {
          stopViewing(true);
          onNotification('屏幕共享已结束', 'info');
        }
      });

      call.on('error', (err) => {
        console.error('Call error:', err);

        if (remoteShareEndedRef.current) {
          handleRemoteShareEnded('共享方已结束共享');
          return;
        }

        if (!isManualStopRef.current) {
          stopViewing(false);
          // 这里也可以触发重连，逻辑同上
          setError(`连接发生错误: ${err.message}`);
        } else {
          setError(`连接失败: ${err.message}`);
          setIsConnecting(false);
        }
      });

      mediaConnectionRef.current = call;
    });

    peer.on('error', (err) => {
      console.error('Peer error:', err);

      if (remoteShareEndedRef.current) {
        handleRemoteShareEnded('共享方已结束共享');
        return;
      }

      // 处理特定的 PeerJS 错误，尝试重连
      if (!isManualStopRef.current && (err.type === 'network' || err.type === 'peer-unavailable' || err.type === 'disconnected')) {
        if (err.type === 'peer-unavailable' && reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
          // 可能是分享者暂时掉线，稍后重试
          stopViewing(false);
          reconnectAttemptsRef.current += 1;
          reconnectTimerRef.current = setTimeout(() => {
            connectToSharer(sharerId, true);
          }, 3000);
          setError('连接中断，正在尝试重新连接...');
          return;
        }
      }

      if (err.type === 'peer-unavailable') {
        setError('找不到该分享者，请确认连接 ID 是否正确或分享者仍在共享');
      } else {
        setError(`连接错误: ${err.message}`);
      }
      setIsConnecting(false);
    });
  }, [onNotification, createDummyStream, stopViewing, handleRemoteShareEnded]);


  const cancelConnecting = useCallback(() => {
    stopViewing();
    onNotification('已取消连接', 'info');
  }, [stopViewing, onNotification]);


  const retryConnection = useCallback(() => {
    if (targetSharerId) {
      connectToSharer(targetSharerId);
    }
  }, [targetSharerId, connectToSharer]);


  useEffect(() => {
    if (initialViewId && !hasInitialConnectedRef.current) {
      hasInitialConnectedRef.current = true;
      connectToSharer(initialViewId);
    }
  }, [initialViewId, connectToSharer]);


  const shareLink = useMemo(() => {
    if (!peerId) return null;
    const baseUrl = `${window.location.origin}${window.location.pathname}`;
    return `${baseUrl}?view=${peerId}`;
  }, [peerId]);


  const copyShareLink = useCallback(async () => {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      onNotification('分享链接已复制', 'success');
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      onNotification('复制失败', 'error');
    }
  }, [shareLink, onNotification]);


  useEffect(() => {
    if ((isSharing || isViewing) && streamRef.current && videoRef.current) {
      const video = videoRef.current;
      const stream = streamRef.current;


      if (video.srcObject !== stream) {
        video.srcObject = stream;
      }


      if (isSharing && !isViewing) {
        video.muted = true;
        video.play().catch(console.error);
      }
    }
  }, [isSharing, isViewing]);


  const viewerVideoRef = useCallback((video: HTMLVideoElement | null) => {
    if (!video) return;


    videoRef.current = video;

    const stream = streamRef.current;
    if (!stream) {
      console.log('No stream available yet');
      return;
    }


    if (video.srcObject === stream) return;

    console.log('Callback ref: Attaching stream to video element...');
    video.srcObject = stream;
    video.muted = true;

    video.play()
      .then(() => {
        console.log('Video playback started (muted)');
        setNeedsPlayClick(false);
      })
      .catch(error => {
        if (error.name === 'AbortError') {
          console.log('Play request was interrupted');
        } else {
          console.error('Autoplay failed:', error);
          setNeedsPlayClick(true);
        }
      });
  }, [isViewing]);


  useEffect(() => {
    return () => {

      bandwidthMonitorsRef.current.forEach((timer) => clearInterval(timer));
      bandwidthMonitorsRef.current.clear();

      // 清理数据连接
      if (dataConnectionRef.current) {
        dataConnectionRef.current.close();
      }
      activeDataConnectionsRef.current.forEach(conn => conn.close());
      activeDataConnectionsRef.current = [];
      viewerHeartbeatsRef.current = {};

      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }

      if (audioContextRef.current) {
        audioContextRef.current.close().catch(console.error);
      }

      activeCallsRef.current.forEach(call => call.close());
      activeCallsRef.current = [];
      setViewerCount(0);

      if (peerRef.current) {
        peerRef.current.destroy();
      }

      if (mediaConnectionRef.current) {
        mediaConnectionRef.current.close();
      }
    };
  }, []);

  useEffect(() => {
    const notifyShareEndOnPageExit = () => {
      if (!isSharing) return;
      broadcastShareEnded('window_closed');
    };
    window.addEventListener('pagehide', notifyShareEndOnPageExit);
    window.addEventListener('beforeunload', notifyShareEndOnPageExit);
    return () => {
      window.removeEventListener('pagehide', notifyShareEndOnPageExit);
      window.removeEventListener('beforeunload', notifyShareEndOnPageExit);
    };
  }, [isSharing, broadcastShareEnded]);


  const startScreenShare = async () => {
    setError(null);


    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      setError('您的浏览器不支持屏幕共享，请使用桌面端浏览器:Chrome、Edge 或 Firefox');
      onNotification('屏幕共享不可用', 'error');
      return;
    }

    try {

      const stream = await navigator.mediaDevices.getDisplayMedia(buildDisplayMediaConstraints());

      // 屏幕共享以文字和细节为主，优先保证清晰度
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack && 'contentHint' in videoTrack) {
        (videoTrack as any).contentHint = 'detail';
      }
      await applyLocalTrackConstraints(stream, qualityLevelRef.current);



      streamRef.current = stream;


      if (videoRef.current) {
        videoRef.current.srcObject = stream;

        videoRef.current.play().catch(console.error);
      }


      stream.getVideoTracks()[0].onended = () => {
        stopScreenShare();
      };

      setIsSharing(true);



      initializePeer();

      const audioInfo = stream.getAudioTracks().length > 0 ? '（含音频）' : '';
      onNotification(`屏幕共享已开始${audioInfo}`, 'success');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '无法启动屏幕共享';

      if (errorMessage.includes('Permission denied') || errorMessage.includes('NotAllowedError')) {
        setError('用户取消了屏幕共享');
      } else {
        setError('当前浏览器不支持启动屏幕共享，请使用Chrome、Edge等浏览器');
        onNotification('屏幕共享启动失败', 'error');
      }
    }
  };


  const changeScreenSource = async () => {
    try {

      const newStream = await navigator.mediaDevices.getDisplayMedia(buildDisplayMediaConstraints());

      const videoTrack = newStream.getVideoTracks()[0];
      if (videoTrack && 'contentHint' in videoTrack) {
        (videoTrack as any).contentHint = 'detail';
      }
      await applyLocalTrackConstraints(newStream, qualityLevelRef.current);


      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }


      streamRef.current = newStream;


      if (videoRef.current) {
        videoRef.current.srcObject = newStream;
        videoRef.current.play().catch(console.error);
      }


      newStream.getVideoTracks()[0].onended = () => {
        stopScreenShare();
      };


      activeCallsRef.current.forEach((call) => {
        const senders = call.peerConnection?.getSenders();
        if (!senders) return;


        const videoTrack = newStream.getVideoTracks()[0];
        const videoSender = senders.find(s => s.track?.kind === 'video');
        if (videoSender && videoTrack) {
          videoSender.replaceTrack(videoTrack);
        }


        const audioTrack = newStream.getAudioTracks()[0];
        const audioSender = senders.find(s => s.track?.kind === 'audio');
        if (audioSender && audioTrack) {
          audioSender.replaceTrack(audioTrack);
        }
      });

      const audioInfo = newStream.getAudioTracks().length > 0 ? '（含音频）' : '';
      onNotification(`已切换共享窗口${audioInfo}`, 'success');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '无法切换共享窗口';
      if (!errorMessage.includes('Permission denied') && !errorMessage.includes('NotAllowedError')) {
        onNotification('切换共享窗口失败', 'error');
      }
    }
  };


  const stopScreenShare = () => {
    broadcastShareEnded('stopped');

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    // 关闭所有数据连接
    activeDataConnectionsRef.current.forEach(conn => conn.close());
    activeDataConnectionsRef.current = [];
    viewerHeartbeatsRef.current = {};

    // 关闭所有媒体连接并重置人数
    activeCallsRef.current.forEach(call => call.close());
    activeCallsRef.current = [];
    setViewerCount(0);
    stopBandwidthMonitoring();


    if (peerRef.current) {
      peerRef.current.destroy();
      peerRef.current = null;
    }


    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setIsSharing(false);
    setPeerId(null);
    setIsPeerReady(false);
    onNotification('屏幕共享已停止', 'info');
  };

  return (
    <ScreenShareUI
      isSharing={isSharing}
      isViewing={isViewing}
      isConnecting={isConnecting}
      viewerConnectingStage={viewerConnectingStage}
      error={error}
      targetSharerId={targetSharerId}
      cancelConnecting={cancelConnecting}
      retryConnection={retryConnection}
      dismissConnectionError={() => {
        setTargetSharerId(null);
        setError(null);
      }}
      viewerVideoRef={viewerVideoRef}
      needsPlayClick={needsPlayClick}
      onViewerPlayClick={() => {
        if (videoRef.current) {
          videoRef.current.muted = true;
          videoRef.current.play()
            .then(() => {
              setNeedsPlayClick(false);
            })
            .catch(console.error);
        }
      }}
      stopViewing={() => stopViewing(true)}
      qualityLabels={qualityLabels}
      remoteQuality={remoteQuality}
      shareLink={shareLink}
      copyShareLink={copyShareLink}
      copied={copied}
      isPeerReady={isPeerReady}
      viewerCount={viewerCount}
      qualityLevel={qualityLevel}
      sharerVideoRef={videoRef}
      changeScreenSource={changeScreenSource}
      startScreenShare={startScreenShare}
      stopScreenShare={stopScreenShare}
    />
  );
};
