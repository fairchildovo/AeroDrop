import React, { useState, useEffect, useRef } from 'react';
import { Sender } from './components/Sender';
import { Receiver } from './components/Receiver';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Share, DownloadCloud, Bell, Monitor, Package, ShieldAlert, X } from 'lucide-react';
import { ScreenShare } from './components/ScreenShare';
import { GradientText } from './components/GradientText';
import { AppNotification } from './types';
import { PWAInstallPrompt } from './components/PWAInstallPrompt';
import { getInitialDeviceName } from './services/deviceName';
import { appendNetworkProfileQuery, getBrowserNetworkProfile } from './services/networkProfile';
import { logDebug } from './services/diagnostics';

type Mode = 'send' | 'receive' | 'screen';

type InitialRouteState = {
  code: string;
  hadDeepLink: boolean;
  mode: Mode;
  viewId: string;
};

const getInitialRouteState = (): InitialRouteState => {
  if (typeof window === 'undefined') {
    return { mode: 'send', code: '', viewId: '', hadDeepLink: false };
  }

  const params = new URLSearchParams(window.location.search);
  const code = params.get('code') ?? '';
  const viewId = params.get('view') ?? '';

  if (code) {
    return { mode: 'receive', code, viewId: '', hadDeepLink: true };
  }

  if (viewId) {
    return { mode: 'screen', code: '', viewId, hadDeepLink: true };
  }

  return { mode: 'send', code: '', viewId: '', hadDeepLink: false };
};

type IdleCapableWindow = Window & {
  cancelIdleCallback?: (handle: number) => void;
  requestIdleCallback?: (
    callback: IdleRequestCallback,
    options?: IdleRequestOptions
  ) => number;
};

const scheduleIdleTask = (callback: () => void, timeout = 2000): (() => void) => {
  if (typeof window === 'undefined') {
    callback();
    return () => {};
  }

  const idleWindow = window as IdleCapableWindow;
  if (typeof idleWindow.requestIdleCallback === 'function') {
    const handle = idleWindow.requestIdleCallback(() => callback(), { timeout });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }

  const handle = window.setTimeout(callback, Math.min(timeout, 1500));
  return () => window.clearTimeout(handle);
};

interface NetworkCheckResponse {
  isRisk: boolean;
  reason: 'isp' | 'score' | 'location' | 'network' | null;
  details: string;
  isp: string;
  country: string;
}

const RISK_BANNER_DISMISS_UNTIL_KEY = 'aerodrop-risk-banner-dismiss-until';

const App: React.FC = () => {
  const [initialRoute] = useState<InitialRouteState>(() => getInitialRouteState());
  const [mode, setMode] = useState<Mode>(initialRoute.mode);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [showRiskBanner, setShowRiskBanner] = useState(false);
  const [isRiskBannerExpanded, setIsRiskBannerExpanded] = useState(false);
  const [swUpdateReady, setSwUpdateReady] = useState(false);
  const [isApplyingSwUpdate, setIsApplyingSwUpdate] = useState(false);
  const [deviceName] = useState<string>(() => getInitialDeviceName());
  const swUpdateReloadTimerRef = useRef<number | null>(null);
  const initialCode = initialRoute.code;
  const initialViewId = initialRoute.viewId;

  const isRiskBannerDismissed = () => {
    try {
      const raw = window.localStorage.getItem(RISK_BANNER_DISMISS_UNTIL_KEY);
      if (!raw) return false;
      const dismissUntil = Number(raw);
      return Number.isFinite(dismissUntil) && dismissUntil > Date.now();
    } catch {
      return false;
    }
  };

  const dismissRiskBanner = () => {
    setShowRiskBanner(false);
    setIsRiskBannerExpanded(false);
    try {
      const dismissUntil = Date.now() + 24 * 60 * 60 * 1000;
      window.localStorage.setItem(RISK_BANNER_DISMISS_UNTIL_KEY, String(dismissUntil));
    } catch {
      // Ignore persistence errors and still hide for current session.
    }
  };

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let cancelled = false;
    let registrationRef: ServiceWorkerRegistration | null = null;
    let installingWorkerRef: ServiceWorker | null = null;

    const markUpdateReady = () => {
      if (cancelled) return;
      setSwUpdateReady(true);
    };

    const onInstallingStateChange = () => {
      if (!installingWorkerRef) return;
      if (installingWorkerRef.state === 'installed' && navigator.serviceWorker.controller) {
        markUpdateReady();
      }
    };

    const onUpdateFound = () => {
      if (!registrationRef) return;
      installingWorkerRef = registrationRef.installing;
      if (!installingWorkerRef) return;
      installingWorkerRef.addEventListener('statechange', onInstallingStateChange);
    };

    navigator.serviceWorker.getRegistration()
      .then((registration) => {
        if (cancelled || !registration) return;
        registrationRef = registration;
        if (registration.waiting) {
          markUpdateReady();
        }
        registration.addEventListener('updatefound', onUpdateFound);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (registrationRef) {
        registrationRef.removeEventListener('updatefound', onUpdateFound);
      }
      if (installingWorkerRef) {
        installingWorkerRef.removeEventListener('statechange', onInstallingStateChange);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (swUpdateReloadTimerRef.current !== null) {
        window.clearTimeout(swUpdateReloadTimerRef.current);
        swUpdateReloadTimerRef.current = null;
      }
    };
  }, []);

  const applySwUpdate = () => {
    if (isApplyingSwUpdate) return;
    setIsApplyingSwUpdate(true);

    const forceReload = () => {
      if (swUpdateReloadTimerRef.current !== null) {
        window.clearTimeout(swUpdateReloadTimerRef.current);
        swUpdateReloadTimerRef.current = null;
      }
      window.location.reload();
    };

    if (!('serviceWorker' in navigator)) {
      forceReload();
      return;
    }

    navigator.serviceWorker.getRegistration()
      .then((registration) => {
        const waiting = registration?.waiting;
        if (!waiting) {
          forceReload();
          return;
        }

        const onControllerChange = () => {
          navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
          forceReload();
        };
        navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

        swUpdateReloadTimerRef.current = window.setTimeout(() => {
          navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
          forceReload();
        }, 2000);

        waiting.postMessage({ type: 'SKIP_WAITING' });
      })
      .catch(() => {
        forceReload();
      });
  };

  useEffect(() => {
    const checkNetwork = async () => {
      try {
        const url = new URL('/api/network-check', window.location.origin);
        appendNetworkProfileQuery(url.searchParams, getBrowserNetworkProfile());
        const res = await fetch(url.toString());

        // Check if the response is JSON (Cloudflare Functions return JSON)
        // In local Vite dev without wrangler, this returns index.html (text/html)
        const contentType = res.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            return;
        }

        const data = await res.json() as NetworkCheckResponse;
        if (data.isRisk && !isRiskBannerDismissed()) {
          setShowRiskBanner(true);
        }
      } catch (error) {
        logDebug('warn', 'Failed to check network status:', error);
      }
    };

    const cancelIdleTask = scheduleIdleTask(() => {
      void checkNetwork();
    }, 2500);

    return cancelIdleTask;
  }, []);

  useEffect(() => {
    let isUnmounted = false;
    let timer: number | null = null;

    const sendHeartbeat = async () => {
      try {
        const res = await fetch('/api/ping', {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain;charset=UTF-8',
          },
          body: 'ping',
          cache: 'no-store',
          keepalive: true,
        });

        if (!isUnmounted && res.ok) {
          const text = await res.text();
          if (text !== 'pong') {
            logDebug('warn', 'Unexpected heartbeat response:', text);
          }
        }
      } catch {
        // Keep heartbeat silent to avoid noisy user-facing errors.
      }
    };

    const cancelIdleTask = scheduleIdleTask(() => {
      if (isUnmounted) return;
      void sendHeartbeat();
      timer = window.setInterval(sendHeartbeat, 30_000);
    }, 4000);

    return () => {
      isUnmounted = true;
      cancelIdleTask();
      if (timer !== null) {
        window.clearInterval(timer);
      }
    };
  }, []);

  useEffect(() => {
    if (initialRoute.hadDeepLink) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [initialRoute.hadDeepLink]);

  useEffect(() => {
    // Touch/coarse-pointer devices don't benefit from mouse glow tracking.
    if (
      window.matchMedia('(any-hover: none)').matches ||
      window.matchMedia('(pointer: coarse)').matches
    ) {
      return;
    }

    const docEl = document.documentElement;
    let rafId: number | null = null;
    let pendingX = 0;
    let pendingY = 0;

    const flushMousePosition = () => {
      docEl.style.setProperty('--mouse-x', `${pendingX}px`);
      docEl.style.setProperty('--mouse-y', `${pendingY}px`);
      rafId = null;
    };

    const handleMouseMove = (e: MouseEvent) => {
      pendingX = e.clientX;
      pendingY = e.clientY;
      if (rafId === null) {
        rafId = window.requestAnimationFrame(flushMousePosition);
      }
    };
    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, []);

  const addNotification = (message: string, type: 'success' | 'info' | 'error') => {
    const id = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    setNotifications(prev => [...prev, { id, message, type, timestamp: Date.now() }]);

    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, 4000);
  };

  return (
    <div className="min-h-[100dvh] bg-slate-50 dark:bg-slate-950 flex flex-col transition-colors duration-300 relative overflow-hidden">
      {swUpdateReady && (
        <div className="fixed top-4 left-4 right-4 md:left-auto md:right-4 z-50 pointer-events-auto">
          <div className="flex items-center justify-between gap-3 rounded-xl border border-blue-200 bg-blue-50/95 px-4 py-3 text-blue-900 shadow-lg backdrop-blur dark:border-blue-900 dark:bg-slate-900/95 dark:text-blue-200">
            <p className="text-sm font-medium">发现新版本，建议刷新以避免新旧版本混用导致连接异常。</p>
            <button
              onClick={applySwUpdate}
              className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-70"
              disabled={isApplyingSwUpdate}
            >
              {isApplyingSwUpdate ? '更新中...' : '立即刷新'}
            </button>
          </div>
        </div>
      )}

      <div
        className="fixed inset-0 pointer-events-none z-0 transition-opacity duration-700"
        style={{
          background: `radial-gradient(circle 600px at var(--mouse-x, 50%) var(--mouse-y, 50%), rgba(100, 150, 255, 0.15), transparent 80%)`,
          filter: 'blur(80px)',
        }}
      />

      <div className="fixed top-20 left-4 right-4 md:left-auto md:right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {notifications.map(n => (
          <div key={n.id} className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border animate-pop-in ${
            n.type === 'success' ? 'bg-white dark:bg-slate-800 border-green-200 dark:border-green-900 text-slate-800 dark:text-slate-100' : 
            n.type === 'error' ? 'bg-red-50 dark:bg-slate-800 border-red-200 dark:border-red-900 text-red-800 dark:text-red-300' : 
            'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100'
          }`}>
            <Bell size={16} className={n.type === 'success' ? 'text-green-500' : n.type === 'error' ? 'text-red-500' : 'text-blue-500'} />
            <span className="text-sm font-medium">{n.message}</span>
          </div>
        ))}
      </div>

      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-20 transition-colors duration-300">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 h-14 md:h-16 flex items-center justify-between">
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => setMode('send')}>
            <div className="bg-brand-600 p-1.5 md:p-2 rounded-[26.5%] text-white shadow-sm">
              <Package size={20} className="md:w-6 md:h-6" />
            </div>
            <div className="flex items-baseline gap-2">
              <h1 className="text-xl md:text-2xl font-bold text-slate-900 dark:text-white tracking-tighter">AeroDrop</h1>
              <GradientText
                colors={["#2563eb", "#60a5fa", "#4f46e5", "#2563eb"]}
                animationSpeed={8}
                className="text-[10px] md:text-xs font-bold tracking-tight opacity-90 pb-0.5"
              >
                @Tianzora
              </GradientText>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {showRiskBanner && (
              <>
                {/* Desktop Badge */}
                <div className="hidden sm:flex items-center gap-2 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-full px-3 py-1.5 animate-slide-up">
                  <ShieldAlert className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                  <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
                    检测到代理网络,点对点传输和屏幕共享可能失效,建议关闭代理
                  </span>
                  <button
                    onClick={dismissRiskBanner}
                    className="ml-1 p-0.5 rounded-full hover:bg-amber-100 dark:hover:bg-amber-800/50 text-amber-500 dark:text-amber-400 transition-colors"
                    aria-label="关闭警告"
                  >
                    <X size={14} />
                  </button>
                </div>

                {/* Mobile Icon Button */}
                <button
                  className={`sm:hidden p-2 rounded-full transition-colors relative ${
                    isRiskBannerExpanded
                      ? 'bg-amber-100 dark:bg-amber-800/50 text-amber-600 dark:text-amber-400'
                      : 'text-amber-500 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/30'
                  }`}
                  onClick={() => setIsRiskBannerExpanded(!isRiskBannerExpanded)}
                  aria-label="查看网络警告"
                >
                  <ShieldAlert className="w-5 h-5" />
                  {!isRiskBannerExpanded && (
                    <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full ring-2 ring-white dark:ring-slate-900"></span>
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Mobile only banner - Expandable */}
      {showRiskBanner && isRiskBannerExpanded && (
        <div className="sm:hidden bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-800 px-4 py-3 flex items-start gap-3 animate-slide-down relative z-10 shadow-sm">
          <ShieldAlert className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1">
             <p className="text-xs font-medium text-amber-800 dark:text-amber-200 mb-1">
                网络环境受限
             </p>
              <p className="text-xs text-amber-700/80 dark:text-amber-300/80 leading-relaxed">
                 检测到当前网络可能限制 P2P 打洞（如代理、移动网络或跨境链路），系统会优先尝试更稳的连接方式。
              </p>
           </div>
          <button
            onClick={() => {
              dismissRiskBanner();
            }}
            className="p-1 -mr-1 -mt-1 rounded-full hover:bg-amber-100 dark:hover:bg-amber-800/50 text-amber-500 dark:text-amber-400"
          >
            <X size={16} />
          </button>
        </div>
      )}

      <main className="flex-1 flex flex-col items-center justify-start pt-4 md:pt-8 pb-8 px-3 md:px-4 w-full max-w-5xl mx-auto overflow-hidden">

        <div className="w-full max-w-xl mb-8 relative z-10">
            <div className="bg-white dark:bg-slate-900 p-1.5 rounded-full grid grid-cols-3 relative transition-all duration-300 shadow-[0_12px_30px_rgba(0,0,0,0.08)] border border-slate-50 dark:border-slate-800">
              <div
                  className="absolute top-1.5 left-1.5 bottom-1.5 w-[calc((100%-0.75rem)/3)] bg-brand-600 dark:bg-brand-500 rounded-full shadow-[inset_2px_2px_6px_rgba(0,0,0,0.2)]"
                  style={{
                    transform: `translateX(${mode === 'send' ? '0%' : mode === 'receive' ? '100%' : '200%'})`,
                    transition: 'transform 300ms cubic-bezier(0.25, 0.8, 0.25, 1)'
                  }}
              ></div>

              <button
                onClick={() => setMode('send')}
                className={`relative z-10 flex items-center justify-center gap-2 px-3 py-3 rounded-full text-sm font-bold transition-all duration-300 whitespace-nowrap ${
                  mode === 'send'
                    ? 'text-white'
                    : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:scale-105'
                }`}
              >
                <Share size={18} className={`transition-transform duration-300 ${mode === 'send' ? 'scale-110' : ''}`} />
                发送
              </button>
              <button
                onClick={() => setMode('receive')}
                className={`relative z-10 flex items-center justify-center gap-2 px-3 py-3 rounded-full text-sm font-bold transition-all duration-300 whitespace-nowrap ${
                  mode === 'receive'
                    ? 'text-white'
                    : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:scale-105'
                }`}
              >
                <DownloadCloud size={18} className={`transition-transform duration-300 ${mode === 'receive' ? 'scale-110' : ''}`} />
                接收
              </button>
              <button
                onClick={() => setMode('screen')}
                className={`relative z-10 flex items-center justify-center gap-2 px-3 py-3 rounded-full text-sm font-bold transition-all duration-300 whitespace-nowrap ${
                  mode === 'screen'
                    ? 'text-white'
                    : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:scale-105'
                }`}
              >
                <Monitor size={18} className={`transition-transform duration-300 ${mode === 'screen' ? 'scale-110' : ''}`} />
                共享
              </button>
            </div>
        </div>

        <div className="w-full flex-1 flex flex-col perspective-[2000px]">
          <ErrorBoundary>
            {mode === 'send' && (
              <div className="block animate-flip-in h-full transform-style-3d">
                <Sender onNotification={addNotification} deviceName={deviceName} />
              </div>
            )}
            {mode === 'receive' && (
              <div className="block animate-flip-in h-full transform-style-3d">
                <Receiver initialCode={initialCode} onNotification={addNotification} deviceName={deviceName} />
              </div>
            )}
            {mode === 'screen' && (
              <div className="block animate-flip-in h-full transform-style-3d">
                <ScreenShare initialViewId={initialViewId} onNotification={addNotification} />
              </div>
            )}
          </ErrorBoundary>
        </div>
        
        <div className="mt-8 text-center max-w-md mx-auto space-y-2 pb-4 md:pb-0">
          <p className="text-[10px] md:text-xs text-slate-400 dark:text-slate-600">
            Powered by WebRTC. 数据直接在设备间点对点传输，不经过云端存储。
          </p>
        </div>
      </main>
      <PWAInstallPrompt />
    </div>
  );
};

export default App;
