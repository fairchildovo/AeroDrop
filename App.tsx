import React, { useState, useEffect, lazy, Suspense } from 'react';
// import { Sender } from './components/Sender';
// import { Receiver } from './components/Receiver';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Share, DownloadCloud, Bell, Monitor, Package, Loader2 } from 'lucide-react';
// import { ScreenShare } from './components/ScreenShare';
import { GradientText } from './components/GradientText';
import { AppNotification } from './types';
import { PWAInstallPrompt } from './components/PWAInstallPrompt';

// Lazy load components with named exports
const Sender = lazy(() => import('./components/Sender').then(module => ({ default: module.Sender })));
const Receiver = lazy(() => import('./components/Receiver').then(module => ({ default: module.Receiver })));
const ScreenShare = lazy(() => import('./components/ScreenShare').then(module => ({ default: module.ScreenShare })));

const App: React.FC = () => {
  const [mode, setMode] = useState<'send' | 'receive' | 'screen'>('send');
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [initialCode, setInitialCode] = useState<string>('');
  const [initialViewId, setInitialViewId] = useState<string>('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const viewId = params.get('view');

    if (code) {
      setMode('receive');
      setInitialCode(code);
    } else if (viewId) {
      setMode('screen');
      setInitialViewId(viewId);
    }

    if (code || viewId) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      document.documentElement.style.setProperty('--mouse-x', `${e.clientX}px`);
      document.documentElement.style.setProperty('--mouse-y', `${e.clientY}px`);
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  const addNotification = (message: string, type: 'success' | 'info' | 'error') => {
    const id = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    setNotifications(prev => [...prev, { id, message, type, timestamp: Date.now() }]);

    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, 4000);
  };

  const getNavBackgroundStyle = () => {
      if (mode === 'send') return 'translate-x-0';
      if (mode === 'receive') return 'translate-x-[100%]';
      return 'translate-x-[200%]';
  };

  return (
    <div className="min-h-[100dvh] bg-slate-50 dark:bg-slate-950 flex flex-col transition-colors duration-300 relative overflow-hidden">
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
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-start pt-4 md:pt-8 pb-8 px-3 md:px-4 w-full max-w-5xl mx-auto overflow-hidden">

        <div className="w-full max-w-xl mb-8 relative z-10">
            <div className="bg-white dark:bg-slate-900 p-1.5 rounded-full grid grid-cols-3 relative transition-all duration-300 shadow-[0_12px_30px_rgba(0,0,0,0.08)] border border-slate-50 dark:border-slate-800">
              <div
                  className={`absolute top-1.5 left-1.5 bottom-1.5 w-[calc((100%-0.75rem)/3)] bg-brand-600 dark:bg-brand-500 rounded-full shadow-[inset_2px_2px_6px_rgba(0,0,0,0.2)] transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] ${getNavBackgroundStyle()}`}
              ></div>

              <button
                onClick={() => setMode('send')}
                className={`relative z-10 flex items-center justify-center gap-2 px-3 py-3 rounded-full text-sm font-bold transition-colors duration-200 whitespace-nowrap ${
                  mode === 'send'
                    ? 'text-white'
                    : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
              >
                <Share size={18} />
                发送
              </button>
              <button
                onClick={() => setMode('receive')}
                className={`relative z-10 flex items-center justify-center gap-2 px-3 py-3 rounded-full text-sm font-bold transition-colors duration-200 whitespace-nowrap ${
                  mode === 'receive'
                    ? 'text-white'
                    : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
              >
                <DownloadCloud size={18} />
                接收
              </button>
              <button
                onClick={() => setMode('screen')}
                className={`relative z-10 flex items-center justify-center gap-2 px-3 py-3 rounded-full text-sm font-bold transition-colors duration-200 whitespace-nowrap ${
                  mode === 'screen'
                    ? 'text-white'
                    : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
              >
                <Monitor size={18} />
                共享
              </button>
            </div>
        </div>

        <div className="w-full flex-1 flex flex-col perspective-[2000px]">
          <ErrorBoundary>
            <Suspense fallback={null}>
              <div className={`${mode === 'send' ? 'block animate-flip-in' : 'hidden'} h-full transform-style-3d`}>
                <Sender onNotification={addNotification} />
              </div>
            </Suspense>
          </ErrorBoundary>
          <ErrorBoundary>
            <Suspense fallback={null}>
              <div className={`${mode === 'receive' ? 'block animate-flip-in' : 'hidden'} h-full transform-style-3d`}>
                <Receiver initialCode={initialCode} onNotification={addNotification} />
              </div>
            </Suspense>
          </ErrorBoundary>
          <ErrorBoundary>
            <Suspense fallback={null}>
              <div className={`${mode === 'screen' ? 'block animate-flip-in' : 'hidden'} h-full transform-style-3d`}>
                <ScreenShare initialViewId={initialViewId} onNotification={addNotification} />
              </div>
            </Suspense>
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