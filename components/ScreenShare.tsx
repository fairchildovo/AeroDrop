import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Monitor, StopCircle, Play, AlertCircle, Copy, Check, ExternalLink, Eye, Loader2, RefreshCw, X, MonitorUp } from 'lucide-react';
import Peer, { MediaConnection, DataConnection } from 'peerjs';
import { getIceConfig } from '../services/stunService';

interface ScreenShareProps {
  onNotification: (message: string, type: 'success' | 'info' | 'error') => void;
  initialViewId?: string;
}

export const ScreenShare: React.FC<ScreenShareProps> = ({ onNotification, initialViewId }) => {
  const [isSharing, setIsSharing] = useState(false);
  const [isViewing, setIsViewing] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
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
  const MAX_RECONNECT_ATTEMPTS = 5;


  const audioContextRef = useRef<AudioContext | null>(null);

  
  const bandwidthMonitorRef = useRef<NodeJS.Timeout | null>(null);

  
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
    medium: { min: 500000, max: 4000000 },     // 高清：提升至 4Mbps
    low: { min: 100000, max: 1000000 },        // 流畅：保持 1Mbps
  }), []);

  
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
        params.encodings[0].scaleResolutionDownBy = 1;

        // 尝试设置编码优先级
        if ('networkPriority' in params.encodings[0]) {
          (params.encodings[0] as any).networkPriority = 'high';
        }
      } else {
        const limits = bitrateLimits[level];
        params.encodings[0].maxBitrate = limits.max;

        if (level === 'low') {
          params.encodings[0].scaleResolutionDownBy = 2;
        } else if (level === 'medium') {
          params.encodings[0].scaleResolutionDownBy = 1.5;
        }
      }

      try {
        await videoSender.setParameters(params);
        console.log(`Applied ${level} quality bitrate: ${bitrateLimits[level].max / 1000000}Mbps`);
      } catch (err) {
        console.error('Failed to set bitrate parameters:', err);
      }
    }
  }, [bitrateLimits]);


  useEffect(() => {
    qualityLevelRef.current = qualityLevel;

    // 当画质改变时，广播给所有连接的观看者
    activeDataConnectionsRef.current.forEach(conn => {
      if (conn.open) {
        conn.send({ type: 'quality', value: qualityLevel });
      }
    });
  }, [qualityLevel]);


  const startBandwidthMonitoring = useCallback((call: MediaConnection) => {
    const pc = call.peerConnection;
    if (!pc) return;

    let lastBytesSent = 0;
    let lastTimestamp = Date.now();
    let consecutiveLowBandwidth = 0;
    let consecutiveHighBandwidth = 0;

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
        const packetLossRate = packetsSent > 0 ? packetsLost / packetsSent : 0;

        lastBytesSent = currentBytesSent;
        lastTimestamp = now;

        
        const currentQuality = qualityLevelRef.current;
        const limits = bitrateLimits[currentQuality];



        // 优化带宽检测逻辑：
        // 1. 丢包率 > 5% 直接降级
        // 2. 只有在有丢包发生（> 0.5%）且码率过低时才认为是带宽不足（避免静止画面低码率误判）
        if (packetLossRate > 0.05 || (packetLossRate > 0.005 && currentBitrate < limits.min * 0.7)) {
          consecutiveLowBandwidth++;
          consecutiveHighBandwidth = 0;

          if (consecutiveLowBandwidth >= 3) {
            if (currentQuality === 'high') {
              setQualityLevel('medium');
              await applyBitrateConstraints(pc, 'medium');
              onNotification('网络较差，已自动调整为高清画质', 'info');
            } else if (currentQuality === 'medium') {
              setQualityLevel('low');
              await applyBitrateConstraints(pc, 'low');
              onNotification('网络拥堵，已切换到流畅模式', 'info');
            }
            consecutiveLowBandwidth = 0;
          }
        }

        else if (packetLossRate < 0.005) { // 只有丢包率极低时才考虑升级
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

    
    bandwidthMonitorRef.current = setInterval(monitor, 2000);
  }, [bitrateLimits, applyBitrateConstraints, onNotification]);

  
  const stopBandwidthMonitoring = useCallback(() => {
    if (bandwidthMonitorRef.current) {
      clearInterval(bandwidthMonitorRef.current);
      bandwidthMonitorRef.current = null;
    }
  }, []);

  
  const generatePeerId = useCallback(() => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let id = '';
    for (let i = 0; i < 6; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `AERO-${id}`;
  }, []);

  
  const initializePeer = useCallback(async () => {
    if (peerRef.current) {
      peerRef.current.destroy();
    }

    const iceConfig = await getIceConfig();
    const id = generatePeerId();
    const peer = new Peer(id, {
      debug: 0,
      secure: iceConfig.secure,
      config: {
        iceServers: iceConfig.iceServers,
        iceCandidatePoolSize: iceConfig.iceCandidatePoolSize,
        iceTransportPolicy: 'all', // 强制使用所有可能的传输路径，包括 VPN 虚拟网卡
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
        activeCallsRef.current.push(call);
        setViewerCount(prev => prev + 1);
        onNotification('有观看者加入', 'info');

        
        if (call.peerConnection) {
          applyBitrateConstraints(call.peerConnection, qualityLevel);
          startBandwidthMonitoring(call);
        }

        call.on('close', () => {
          activeCallsRef.current = activeCallsRef.current.filter(c => c !== call);
          setViewerCount(prev => Math.max(0, prev - 1));
          if (activeCallsRef.current.length === 0) {
            stopBandwidthMonitoring();
          }
        });

        call.on('error', (err) => {
          console.error('Call error:', err);
          activeCallsRef.current = activeCallsRef.current.filter(c => c !== call);
          setViewerCount(prev => Math.max(0, prev - 1));
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
  }, [generatePeerId, onNotification, applyBitrateConstraints, startBandwidthMonitoring, stopBandwidthMonitoring]);


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

        // 注意：call.close() 会触发 'close' 事件监听器，那里会更新 viewerCount
        // 但为了保险起见，我们也可以在这里做一次清理（虽然事件监听器应该处理了）
      }
    }, 5000); // 每5秒检查一次

    return () => clearInterval(checkInterval);
  }, [isSharing]);



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

  
  const stopViewing = useCallback((isManual = true) => {
    // 标记是否为手动停止
    isManualStopRef.current = isManual;

    // 清除重连定时器
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

    // 只有手动停止时才清除目标ID，方便重连
    if (isManual) {
      setTargetSharerId(null);
      setError(null);
      reconnectAttemptsRef.current = 0;
    }
  }, []);

  
  const connectToSharer = useCallback(async (sharerId: string, isRetry = false) => {

    // 如果是新的连接请求（非重连），重置重连计数
    if (!isRetry) {
      reconnectAttemptsRef.current = 0;
      isManualStopRef.current = false;
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
    setTargetSharerId(sharerId);

    // 如果是重连尝试，显示正在重连的状态
    if (isRetry) {
      onNotification(`正在尝试重连 (${reconnectAttemptsRef.current + 1}/${MAX_RECONNECT_ATTEMPTS})...`, 'info');
    }

    const iceConfig = await getIceConfig();
    const peer = new Peer({
      debug: 0,
      secure: iceConfig.secure,
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

      
      const connectionTimeout = setTimeout(() => {
        if (!streamRef.current) {
          setError('连接超时，请检查分享者是否仍在共享');
          setIsConnecting(false);
          if (call) {
            call.close();
          }
        }
      }, 15000);

      
      let hasReceivedStream = false;

      call.on('stream', (remoteStream) => {
        clearTimeout(connectionTimeout);

        
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
        clearTimeout(connectionTimeout);
        console.log('Call closed');

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

            setError(`连接断开，${delay/1000}秒后尝试重连...`);
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
        clearTimeout(connectionTimeout);
        console.error('Call error:', err);

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
  }, [onNotification, createDummyStream, stopViewing]);

  
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
    const baseUrl = window.location.origin;
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
      
      if (bandwidthMonitorRef.current) {
        clearInterval(bandwidthMonitorRef.current);
      }

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
      
      if (peerRef.current) {
        peerRef.current.destroy();
      }
      
      if (mediaConnectionRef.current) {
        mediaConnectionRef.current.close();
      }
    };
  }, []);

  
  const startScreenShare = async () => {
    setError(null);

    
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      setError('您的浏览器不支持屏幕共享，请使用桌面端浏览器:Chrome、Edge 或 Firefox');
      onNotification('屏幕共享不可用', 'error');
      return;
    }

    try {

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          displaySurface: 'monitor',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60 }
        } as MediaTrackConstraints,
        audio: true,
      });

      // 关键优化：设置 contentHint 为 'motion' 以减少卡顿
      // 虽然 'detail' 清晰度高，但在跨网传输时容易因重传导致累积延迟（"弹动"现象）
      // 改为 'motion' 或 'text' 并配合 playoutDelayHint 可以缓解
      // 这里我们保留 'detail' 但通过接收端控制延迟
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack && 'contentHint' in videoTrack) {
        (videoTrack as any).contentHint = 'motion'; // 权衡：motion 会更流畅，但静态文字可能略有压缩
      }



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
        setError(errorMessage);
        onNotification('屏幕共享启动失败', 'error');
      }
    }
  };

  
  const changeScreenSource = async () => {
    try {

      const newStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          displaySurface: 'monitor',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60 }
        } as MediaTrackConstraints,
        audio: true,
      });

      const videoTrack = newStream.getVideoTracks()[0];
      if (videoTrack && 'contentHint' in videoTrack) {
        (videoTrack as any).contentHint = 'motion';
      }


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

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    // 关闭所有数据连接
    activeDataConnectionsRef.current.forEach(conn => conn.close());
    activeDataConnectionsRef.current = [];
    viewerHeartbeatsRef.current = {};


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
    <div className="w-full max-w-xl mx-auto">
      <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-xl border border-slate-100 dark:border-slate-700 p-6 md:p-8 transition-colors duration-300">
        {}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-brand-100 dark:bg-brand-900/30 rounded-3xl mb-4">
            {isViewing || isConnecting ? (
              <Eye size={32} className="text-brand-600" />
            ) : (
              <Monitor size={32} className="text-brand-600" />
            )}
          </div>
          <h2 className="text-xl md:text-2xl font-bold text-slate-900 dark:text-white mb-2">
            {isViewing ? '正在观看屏幕' : isConnecting ? '正在连接...' : '屏幕共享'}
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {isViewing || isConnecting ? '实时观看对方共享的屏幕内容' : '与其他设备实时共享您的屏幕内容'}
          </p>
        </div>

        {}
        {error && !(targetSharerId && !isConnecting && !isViewing && !isSharing) && (
          <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-2xl flex items-center gap-3">
            <AlertCircle size={20} className="text-red-500 flex-shrink-0" />
            <span className="text-sm text-red-700 dark:text-red-300">{error}</span>
          </div>
        )}

        {}
        {isConnecting && (
          <div className="mb-6 flex flex-col items-center justify-center py-12">
            <Loader2 size={48} className="text-brand-600 animate-spin mb-4" />
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
              正在连接到屏幕共享...
            </p>
            <button
              onClick={cancelConnecting}
              className="flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 border border-slate-300 dark:border-slate-600 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <X size={16} />
              取消连接
            </button>
          </div>
        )}

        {}
        {error && !isConnecting && !isViewing && !isSharing && targetSharerId && (
          <div className="mb-6">
            <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-2xl flex items-center gap-3 mb-4">
              <AlertCircle size={20} className="text-red-500 flex-shrink-0" />
              <span className="text-sm text-red-700 dark:text-red-300">{error}</span>
            </div>
            <div className="flex justify-center gap-3">
              <button
                onClick={retryConnection}
                className="flex items-center justify-center gap-2 px-5 py-2.5 bg-brand-600 hover:bg-brand-700 text-white font-medium rounded-full transition-colors"
              >
                <RefreshCw size={16} />
                重试连接
              </button>
              <button
                onClick={() => {
                  setTargetSharerId(null);
                  setError(null);
                }}
                className="flex items-center justify-center gap-2 px-5 py-2.5 text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 border border-slate-300 dark:border-slate-600 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                <X size={16} />
                取消
              </button>
            </div>
          </div>
        )}

        {}
        {isViewing && (
          <>
            <div className="mb-4 relative overflow-hidden rounded-2xl">
              <div className="bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl overflow-hidden">
                <video
                  ref={viewerVideoRef}
                  autoPlay
                  playsInline
                  controls
                  className="w-full aspect-video object-contain"
                />
              </div>

              {}
              {needsPlayClick && (
                <div
                  className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 cursor-pointer"
                  onClick={() => {
                    if (videoRef.current) {
                      videoRef.current.muted = true;
                      videoRef.current.play()
                        .then(() => {
                          setNeedsPlayClick(false);
                        })
                        .catch(console.error);
                    }
                  }}
                >
                  <div className="w-16 h-16 rounded-full bg-white/20 flex items-center justify-center mb-3">
                    <Play size={32} className="text-white ml-1" fill="white" />
                  </div>
                  <p className="text-white text-sm">点击开始观看</p>
                </div>
              )}
            </div>

            <div className="flex justify-center">
              <button
                onClick={stopViewing.bind(null, true)}
                className="flex items-center justify-center gap-3 w-full max-w-xs bg-red-500 hover:bg-red-600 text-white font-bold py-3.5 px-6 rounded-xl shadow-lg shadow-red-500/25 transition-all duration-200 hover:shadow-xl hover:shadow-red-500/30 hover:-translate-y-0.5"
              >
                <StopCircle size={20} />
                停止观看
              </button>
            </div>
            <div className="mt-6 flex items-center justify-center gap-2">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
              </span>
              <span className="text-sm font-medium text-green-600 dark:text-green-400">
                正在观看屏幕共享 | 画质: {qualityLabels[remoteQuality]}
              </span>
            </div>
          </>
        )}

        {}
        {!isViewing && !isConnecting && (
          <>
            {}
            {isSharing && shareLink && (
              <div className="mb-6 p-4 bg-brand-50 dark:bg-brand-900/20 border border-brand-200 dark:border-brand-800 rounded-2xl">
                <p className="text-xs text-slate-500 dark:text-slate-400 mb-2 text-center">
                  将此链接分享给观看者
                </p>
                <div className="flex items-center justify-center gap-2">
                  <a
                    href={shareLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-mono text-brand-600 dark:text-brand-400 hover:underline truncate max-w-[280px]"
                    title={shareLink}
                  >
                    {shareLink}
                  </a>
                  <button
                    onClick={copyShareLink}
                    className="p-2 rounded-lg bg-brand-100 dark:bg-brand-800/50 hover:bg-brand-200 dark:hover:bg-brand-700/50 transition-colors flex-shrink-0"
                    title="复制分享链接"
                  >
                    {copied ? (
                      <Check size={18} className="text-green-500" />
                    ) : (
                      <Copy size={18} className="text-brand-600 dark:text-brand-400" />
                    )}
                  </button>
                  <a
                    href={shareLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-2 rounded-lg bg-brand-100 dark:bg-brand-800/50 hover:bg-brand-200 dark:hover:bg-brand-700/50 transition-colors flex-shrink-0"
                    title="在新窗口打开"
                  >
                    <ExternalLink size={18} className="text-brand-600 dark:text-brand-400" />
                  </a>
                </div>
                {!isPeerReady && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-2 text-center">
                    正在连接服务器...
                  </p>
                )}
                {viewerCount > 0 && (
                  <p className="text-xs text-green-600 dark:text-green-400 mt-2 text-center">
                    当前观看人数: {viewerCount} | 画质: {qualityLabels[qualityLevel]}
                  </p>
                )}
              </div>
            )}

            {}
            {isSharing && (
              <div className="mb-6 relative group">
                <div className="rounded-2xl overflow-hidden bg-slate-900 border border-slate-200 dark:border-slate-700">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full aspect-video object-contain"
                  />
                </div>
                {}
                <button
                  onClick={changeScreenSource}
                  className="absolute top-3 right-3 p-2 rounded-lg bg-black/50 hover:bg-black/70 text-white opacity-0 group-hover:opacity-100 transition-opacity duration-200"
                  title="切换共享窗口"
                >
                  <MonitorUp size={18} />
                </button>
              </div>
            )}

            {}
            <div className="flex justify-center">
              {!isSharing ? (
                <button
                  onClick={startScreenShare}
                  className="flex items-center justify-center gap-3 w-full max-w-xs bg-brand-600 hover:bg-brand-700 text-white font-bold py-3.5 px-6 rounded-full shadow-lg shadow-brand-600/25 transition-all duration-200 hover:shadow-xl hover:shadow-brand-600/30 hover:-translate-y-0.5"
                >
                  <Play size={20} fill="currentColor" />
                  开始共享屏幕
                </button>
              ) : (
                <button
                  onClick={stopScreenShare}
                  className="flex items-center justify-center gap-3 w-full max-w-xs bg-red-500 hover:bg-red-600 text-white font-bold py-3.5 px-6 rounded-full shadow-lg shadow-red-500/25 transition-all duration-200 hover:shadow-xl hover:shadow-red-500/30 hover:-translate-y-0.5"
                >
                  <StopCircle size={20} />
                  停止共享
                </button>
              )}
            </div>

            {}
            {isSharing && (
              <div className="mt-6 flex items-center justify-center gap-2">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
                </span>
                <span className="text-sm font-medium text-green-600 dark:text-green-400">
                  正在共享屏幕...
                </span>
              </div>
            )}

            {}
            <div className="mt-6 pt-6 border-t border-slate-100 dark:border-slate-800">
              <p className="text-xs text-slate-400 dark:text-slate-500 text-center">
                点击开始后，浏览器将弹出选择窗口，您可以选择共享整个屏幕、某个应用窗口或浏览器标签页。
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
