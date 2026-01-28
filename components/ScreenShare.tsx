import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Monitor, StopCircle, Play, AlertCircle, Copy, Check, ExternalLink, Eye, Loader2, RefreshCw, X, MonitorUp } from 'lucide-react';
import Peer, { MediaConnection } from 'peerjs';

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

  // Track if playback needs user interaction to start
  const [needsPlayClick, setNeedsPlayClick] = useState(false);

  // Track if we've already tried to connect with initialViewId
  const hasInitialConnectedRef = useRef(false);

  // Video element ref for displaying the screen share preview
  const videoRef = useRef<HTMLVideoElement>(null);

  // MediaStream ref to keep track of the current stream
  const streamRef = useRef<MediaStream | null>(null);

  // PeerJS instance ref
  const peerRef = useRef<Peer | null>(null);

  // Media connection refs (for viewer mode)
  const mediaConnectionRef = useRef<MediaConnection | null>(null);

  // Active calls ref (for sharer mode - track viewers)
  const activeCallsRef = useRef<MediaConnection[]>([]);

  // AudioContext ref for cleanup (used in dummy stream creation)
  const audioContextRef = useRef<AudioContext | null>(null);

  // Generate a random peer ID
  const generatePeerId = useCallback(() => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let id = '';
    for (let i = 0; i < 6; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `AERO-${id}`;
  }, []);

  // Initialize PeerJS connection (for sharer mode)
  const initializePeer = useCallback(() => {
    if (peerRef.current) {
      peerRef.current.destroy();
    }

    const id = generatePeerId();
    const peer = new Peer(id, {
      debug: 0,
    });

    peer.on('open', (openedId) => {
      console.log('Peer ID:', openedId);
      setPeerId(openedId);
      setIsPeerReady(true);
      onNotification(`连接 ID: ${openedId}`, 'info');
    });

    peer.on('call', (call) => {
      // Answer incoming call with our screen stream
      if (streamRef.current) {
        call.answer(streamRef.current);
        activeCallsRef.current.push(call);
        setViewerCount(prev => prev + 1);
        onNotification('有观看者加入', 'info');

        call.on('close', () => {
          activeCallsRef.current = activeCallsRef.current.filter(c => c !== call);
          setViewerCount(prev => Math.max(0, prev - 1));
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
  }, [generatePeerId, onNotification]);

  // Create a dummy stream for viewer (required by PeerJS to establish call)
  // 必须同时包含视频和音频轨道，否则 WebRTC SDP 协商时不会包含音频能力
  const createDummyStream = useCallback(() => {
    // Cleanup previous AudioContext if any
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(console.error);
      audioContextRef.current = null;
    }

    // 1. 创建 dummy 视频轨道
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = 'black';
      ctx.fillRect(0, 0, 1, 1);
    }
    const videoStream = canvas.captureStream(1);

    // 2. 创建 dummy 音频轨道（静音）
    // 使用 AudioContext 创建一个静音的音频源
    const audioContext = new AudioContext();
    audioContextRef.current = audioContext; // Store for cleanup

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    // 设置增益为 0，确保完全静音
    gainNode.gain.value = 0;

    // 连接节点：振荡器 -> 增益节点 -> 媒体流目标
    const destination = audioContext.createMediaStreamDestination();
    oscillator.connect(gainNode);
    gainNode.connect(destination);

    // 启动振荡器（必须启动才能产生轨道）
    oscillator.start();

    // 3. 合并视频和音频轨道到一个流中
    const combinedStream = new MediaStream();

    // 添加视频轨道
    videoStream.getVideoTracks().forEach(track => {
      combinedStream.addTrack(track);
    });

    // 添加音频轨道
    destination.stream.getAudioTracks().forEach(track => {
      combinedStream.addTrack(track);
    });

    console.log('Created dummy stream with tracks:', {
      video: combinedStream.getVideoTracks().length,
      audio: combinedStream.getAudioTracks().length
    });

    return combinedStream;
  }, []);

  // Connect to sharer as viewer
  const connectToSharer = useCallback((sharerId: string) => {
    // Cleanup previous connection if any
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

    const peer = new Peer({
      debug: 0,
    });

    peerRef.current = peer;

    peer.on('open', () => {
      console.log('Viewer peer opened, calling:', sharerId);

      // Create a dummy stream for the call (PeerJS requires a stream to establish connection)
      const dummyStream = createDummyStream();

      // Call the sharer with dummy stream
      const call = peer.call(sharerId, dummyStream);

      if (!call) {
        setError('无法发起连接，请检查连接 ID');
        setIsConnecting(false);
        return;
      }

      // Set a timeout for connection
      const connectionTimeout = setTimeout(() => {
        if (!streamRef.current) {
          setError('连接超时，请检查分享者是否仍在共享');
          setIsConnecting(false);
          if (call) {
            call.close();
          }
        }
      }, 15000);

      call.on('stream', (remoteStream) => {
        clearTimeout(connectionTimeout);

        // Check audio tracks
        const audioTracks = remoteStream.getAudioTracks();
        const videoTracks = remoteStream.getVideoTracks();
        console.log('Received remote stream:', {
          audioTracks: audioTracks.length,
          videoTracks: videoTracks.length,
          audioDetails: audioTracks.map(t => ({ label: t.label, enabled: t.enabled, muted: t.muted })),
          videoDetails: videoTracks.map(t => ({ label: t.label, enabled: t.enabled }))
        });

        // Store stream reference
        streamRef.current = remoteStream;

        setIsViewing(true);
        setIsConnecting(false);
        setNeedsPlayClick(false);
        onNotification('已连接到屏幕共享', 'success');
      });

      call.on('close', () => {
        clearTimeout(connectionTimeout);
        console.log('Call closed');
        stopViewing();
        onNotification('屏幕共享已结束', 'info');
      });

      call.on('error', (err) => {
        clearTimeout(connectionTimeout);
        console.error('Call error:', err);
        setError(`连接失败: ${err.message}`);
        setIsConnecting(false);
      });

      mediaConnectionRef.current = call;
    });

    peer.on('error', (err) => {
      console.error('Peer error:', err);
      if (err.type === 'peer-unavailable') {
        setError('找不到该分享者，请确认连接 ID 是否正确或分享者仍在共享');
      } else {
        setError(`连接错误: ${err.message}`);
      }
      setIsConnecting(false);
    });
  }, [onNotification, createDummyStream]);

  // Stop viewing
  const stopViewing = useCallback(() => {
    if (mediaConnectionRef.current) {
      mediaConnectionRef.current.close();
      mediaConnectionRef.current = null;
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
    setTargetSharerId(null);
    setError(null);
  }, []);

  // Cancel connecting
  const cancelConnecting = useCallback(() => {
    stopViewing();
    onNotification('已取消连接', 'info');
  }, [stopViewing, onNotification]);

  // Retry connection
  const retryConnection = useCallback(() => {
    if (targetSharerId) {
      connectToSharer(targetSharerId);
    }
  }, [targetSharerId, connectToSharer]);

  // Auto-connect if initialViewId is provided (only once)
  useEffect(() => {
    if (initialViewId && !hasInitialConnectedRef.current) {
      hasInitialConnectedRef.current = true;
      connectToSharer(initialViewId);
    }
  }, [initialViewId, connectToSharer]);

  // Generate shareable link
  const shareLink = useMemo(() => {
    if (!peerId) return null;
    const baseUrl = window.location.origin;
    return `${baseUrl}?view=${peerId}`;
  }, [peerId]);

  // Copy share link to clipboard
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

  // Set video srcObject when stream and video element are both ready (for both sharer and viewer modes)
  useEffect(() => {
    if ((isSharing || isViewing) && streamRef.current && videoRef.current) {
      const video = videoRef.current;
      const stream = streamRef.current;

      // Always update srcObject when in sharing/viewing mode
      if (video.srcObject !== stream) {
        video.srcObject = stream;
      }

      // For sharer mode, just play muted preview
      if (isSharing && !isViewing) {
        video.muted = true;
        video.play().catch(console.error);
      }
    }
  }, [isSharing, isViewing]);

  // 使用 callback ref：当 video 元素挂载时立即设置流并播放
  const viewerVideoRef = useCallback((video: HTMLVideoElement | null) => {
    if (!video) return;

    // 保存引用
    videoRef.current = video;

    const stream = streamRef.current;
    if (!stream) {
      console.log('No stream available yet');
      return;
    }

    // 防止重复赋值
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
  }, [isViewing]); // 依赖 isViewing，确保 stream 变化后重新执行

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Stop all media tracks
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      // Close AudioContext
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(console.error);
      }
      // Close all active calls
      activeCallsRef.current.forEach(call => call.close());
      activeCallsRef.current = [];
      // Destroy peer connection
      if (peerRef.current) {
        peerRef.current.destroy();
      }
      // Close media connection
      if (mediaConnectionRef.current) {
        mediaConnectionRef.current.close();
      }
    };
  }, []);

  // Start screen sharing
  const startScreenShare = async () => {
    setError(null);

    // 检查是否支持屏幕共享（需要 HTTPS 或 localhost）
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      setError('您的浏览器不支持屏幕共享，或需要使用 HTTPS 连接');
      onNotification('屏幕共享不可用', 'error');
      return;
    }

    try {
      // Request screen capture - browser will show audio checkbox in the dialog
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          displaySurface: 'monitor',
        } as MediaTrackConstraints,
        audio: true, // This enables the "Share audio" checkbox in browser dialog
      });

      // Store the stream reference BEFORE initializing peer
      // This ensures stream is available when peer.on('call') triggers
      streamRef.current = stream;

      // Display preview in video element
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        // Ensure video plays
        videoRef.current.play().catch(console.error);
      }

      // Handle stream end (user clicks "Stop Sharing" in browser UI)
      stream.getVideoTracks()[0].onended = () => {
        stopScreenShare();
      };

      setIsSharing(true);

      // Initialize PeerJS AFTER stream is ready
      // This ensures streamRef.current is available when peer receives calls
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

  // Change screen share source
  const changeScreenSource = async () => {
    try {
      // Request new screen capture with audio support (same as initial share)
      const newStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'always',
          displaySurface: 'monitor',
        } as MediaTrackConstraints,
        audio: true,
      });

      // Stop old stream tracks
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }

      // Update stream reference
      streamRef.current = newStream;

      // Update video preview
      if (videoRef.current) {
        videoRef.current.srcObject = newStream;
        videoRef.current.play().catch(console.error);
      }

      // Handle new stream end
      newStream.getVideoTracks()[0].onended = () => {
        stopScreenShare();
      };

      // Update active calls with new stream (both video and audio tracks)
      activeCallsRef.current.forEach((call) => {
        const senders = call.peerConnection?.getSenders();
        if (!senders) return;

        // Replace video track
        const videoTrack = newStream.getVideoTracks()[0];
        const videoSender = senders.find(s => s.track?.kind === 'video');
        if (videoSender && videoTrack) {
          videoSender.replaceTrack(videoTrack);
        }

        // Replace audio track if available
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

  // Stop screen sharing
  const stopScreenShare = () => {
    // Stop all tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    // Destroy PeerJS instance
    if (peerRef.current) {
      peerRef.current.destroy();
      peerRef.current = null;
    }

    // Clear video element
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
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-xl border border-slate-100 dark:border-slate-700 p-6 md:p-8 transition-colors duration-300">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-brand-100 dark:bg-brand-900/30 rounded-2xl mb-4">
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

        {/* Error Message */}
        {error && !(targetSharerId && !isConnecting && !isViewing && !isSharing) && (
          <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl flex items-center gap-3">
            <AlertCircle size={20} className="text-red-500 flex-shrink-0" />
            <span className="text-sm text-red-700 dark:text-red-300">{error}</span>
          </div>
        )}

        {/* Connecting Status */}
        {isConnecting && (
          <div className="mb-6 flex flex-col items-center justify-center py-12">
            <Loader2 size={48} className="text-brand-600 animate-spin mb-4" />
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
              正在连接到屏幕共享...
            </p>
            <button
              onClick={cancelConnecting}
              className="flex items-center justify-center gap-2 px-4 py-2 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 border border-slate-300 dark:border-slate-600 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <X size={16} />
              取消连接
            </button>
          </div>
        )}

        {/* Connection Error with Retry */}
        {error && !isConnecting && !isViewing && !isSharing && targetSharerId && (
          <div className="mb-6">
            <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl flex items-center gap-3 mb-4">
              <AlertCircle size={20} className="text-red-500 flex-shrink-0" />
              <span className="text-sm text-red-700 dark:text-red-300">{error}</span>
            </div>
            <div className="flex justify-center gap-3">
              <button
                onClick={retryConnection}
                className="flex items-center justify-center gap-2 px-4 py-2.5 bg-brand-600 hover:bg-brand-700 text-white font-medium rounded-lg transition-colors"
              >
                <RefreshCw size={16} />
                重试连接
              </button>
              <button
                onClick={() => {
                  setTargetSharerId(null);
                  setError(null);
                }}
                className="flex items-center justify-center gap-2 px-4 py-2.5 text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 border border-slate-300 dark:border-slate-600 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                <X size={16} />
                取消
              </button>
            </div>
          </div>
        )}

        {/* Viewer Video Display */}
        {isViewing && (
          <>
            <div className="mb-4 relative overflow-hidden rounded-xl">
              <div className="bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
                <video
                  ref={viewerVideoRef}
                  autoPlay
                  playsInline
                  controls
                  className="w-full aspect-video object-contain"
                />
              </div>

              {/* Click to play overlay - shown when autoplay is blocked */}
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
                onClick={stopViewing}
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
                正在观看屏幕共享...
              </span>
            </div>
          </>
        )}

        {/* Sharer Mode UI */}
        {!isViewing && !isConnecting && (
          <>
            {/* Share Link Display */}
            {isSharing && shareLink && (
              <div className="mb-6 p-4 bg-brand-50 dark:bg-brand-900/20 border border-brand-200 dark:border-brand-800 rounded-xl">
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
                    当前观看人数: {viewerCount}
                  </p>
                )}
              </div>
            )}

            {/* Video Preview */}
            {isSharing && (
              <div className="mb-6 relative group">
                <div className="rounded-xl overflow-hidden bg-slate-900 border border-slate-200 dark:border-slate-700">
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full aspect-video object-contain"
                  />
                </div>
                {/* Change Screen Source Button */}
                <button
                  onClick={changeScreenSource}
                  className="absolute top-3 right-3 p-2 rounded-lg bg-black/50 hover:bg-black/70 text-white opacity-0 group-hover:opacity-100 transition-opacity duration-200"
                  title="切换共享窗口"
                >
                  <MonitorUp size={18} />
                </button>
              </div>
            )}

            {/* Action Button */}
            <div className="flex justify-center">
              {!isSharing ? (
                <button
                  onClick={startScreenShare}
                  className="flex items-center justify-center gap-3 w-full max-w-xs bg-brand-600 hover:bg-brand-700 text-white font-bold py-3.5 px-6 rounded-xl shadow-lg shadow-brand-600/25 transition-all duration-200 hover:shadow-xl hover:shadow-brand-600/30 hover:-translate-y-0.5"
                >
                  <Play size={20} fill="currentColor" />
                  开始共享屏幕
                </button>
              ) : (
                <button
                  onClick={stopScreenShare}
                  className="flex items-center justify-center gap-3 w-full max-w-xs bg-red-500 hover:bg-red-600 text-white font-bold py-3.5 px-6 rounded-xl shadow-lg shadow-red-500/25 transition-all duration-200 hover:shadow-xl hover:shadow-red-500/30 hover:-translate-y-0.5"
                >
                  <StopCircle size={20} />
                  停止共享
                </button>
              )}
            </div>

            {/* Status Indicator */}
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

            {/* Info Section */}
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
