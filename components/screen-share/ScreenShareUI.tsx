import React from 'react';
import { Monitor, StopCircle, Play, AlertCircle, Copy, Check, ExternalLink, Eye, Loader2, RefreshCw, X, MonitorUp } from 'lucide-react';

export type ScreenShareViewerConnectingStage = 'fetching_ice' | 'connecting_signaling' | 'connecting_media' | 'waiting_stream' | '';

interface ScreenShareUIProps {
  isSharing: boolean;
  isViewing: boolean;
  isConnecting: boolean;
  viewerConnectingStage: ScreenShareViewerConnectingStage;
  error: string | null;
  targetSharerId: string | null;
  cancelConnecting: () => void;
  retryConnection: () => void;
  dismissConnectionError: () => void;
  viewerVideoRef: (video: HTMLVideoElement | null) => void;
  needsPlayClick: boolean;
  onViewerPlayClick: () => void;
  stopViewing: () => void;
  qualityLabels: Record<'high' | 'medium' | 'low', string>;
  remoteQuality: 'high' | 'medium' | 'low';
  shareLink: string | null;
  copyShareLink: () => void;
  copied: boolean;
  isPeerReady: boolean;
  viewerCount: number;
  qualityLevel: 'high' | 'medium' | 'low';
  sharerVideoRef: React.RefObject<HTMLVideoElement | null>;
  changeScreenSource: () => void;
  startScreenShare: () => void;
  stopScreenShare: () => void;
}

export const ScreenShareUI: React.FC<ScreenShareUIProps> = ({
  isSharing,
  isViewing,
  isConnecting,
  viewerConnectingStage,
  error,
  targetSharerId,
  cancelConnecting,
  retryConnection,
  dismissConnectionError,
  viewerVideoRef,
  needsPlayClick,
  onViewerPlayClick,
  stopViewing,
  qualityLabels,
  remoteQuality,
  shareLink,
  copyShareLink,
  copied,
  isPeerReady,
  viewerCount,
  qualityLevel,
  sharerVideoRef,
  changeScreenSource,
  startScreenShare,
  stopScreenShare,
}) => {
  return (
    <div className="w-full max-w-xl mx-auto">
      <div className="bg-white dark:bg-slate-800 rounded-3xl shadow-xl border border-slate-100 dark:border-slate-700 p-6 md:p-8 transition-colors duration-300">
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

        {error && !(targetSharerId && !isConnecting && !isViewing && !isSharing) && (
          <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-2xl flex items-center gap-3">
            <AlertCircle size={20} className="text-red-500 flex-shrink-0" />
            <span className="text-sm text-red-700 dark:text-red-300">{error}</span>
          </div>
        )}

        {isConnecting && (
          <div className="mb-6 flex flex-col items-center justify-center py-12">
            <Loader2 size={48} className="text-brand-600 animate-spin mb-4" />
            <p className="text-sm text-slate-600 dark:text-slate-300 font-medium mb-1">
              {viewerConnectingStage === 'fetching_ice' && '正在获取网络配置...'}
              {viewerConnectingStage === 'connecting_signaling' && '正在连接信号服务器...'}
              {viewerConnectingStage === 'connecting_media' && '正在建立媒体通道...'}
              {viewerConnectingStage === 'waiting_stream' && '正在等待屏幕画面...'}
              {!viewerConnectingStage && '正在连接到屏幕共享...'}
            </p>
            <p className="text-xs text-slate-400 dark:text-slate-500 mb-4">
              {viewerConnectingStage === 'fetching_ice' && '获取 STUN/TURN 服务器信息'}
              {viewerConnectingStage === 'connecting_signaling' && '连接 PeerJS 信令服务'}
              {viewerConnectingStage === 'connecting_media' && '通过 WebRTC 建立音视频连接'}
              {viewerConnectingStage === 'waiting_stream' && '已连接，等待对方屏幕画面传输'}
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
                onClick={dismissConnectionError}
                className="flex items-center justify-center gap-2 px-5 py-2.5 text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 border border-slate-300 dark:border-slate-600 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                <X size={16} />
                取消
              </button>
            </div>
          </div>
        )}

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

              {needsPlayClick && (
                <div
                  className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 cursor-pointer"
                  onClick={onViewerPlayClick}
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
                正在观看屏幕共享 | 画质: {qualityLabels[remoteQuality]}
              </span>
            </div>
          </>
        )}

        {!isViewing && !isConnecting && (
          <>
            {isSharing && shareLink && (
              <div className="mb-6 p-4 bg-brand-50 dark:bg-brand-900/20 border border-slate-200 dark:border-slate-700 rounded-2xl">
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

            {isSharing && (
              <div className="mb-6 relative group">
                <div className="rounded-2xl overflow-hidden bg-slate-900 border border-slate-200 dark:border-slate-700">
                  <video
                    ref={sharerVideoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full aspect-video object-contain"
                  />
                </div>
                <button
                  onClick={changeScreenSource}
                  className="absolute top-3 right-3 p-2 rounded-lg bg-black/50 hover:bg-black/70 text-white opacity-0 group-hover:opacity-100 transition-opacity duration-200"
                  title="切换共享窗口"
                >
                  <MonitorUp size={18} />
                </button>
              </div>
            )}

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
