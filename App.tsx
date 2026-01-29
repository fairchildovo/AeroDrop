import React, { useState, useEffect } from 'react';
import { Sender } from './components/Sender';
import { Receiver } from './components/Receiver';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Share, DownloadCloud, Zap, Bell, Monitor } from 'lucide-react';
import { ScreenShare } from './components/ScreenShare';
import { AppNotification } from './types';

const App: React.FC = () => {
  const [mode, setMode] = useState<'send' | 'receive' | 'screen'>('send');
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [initialCode, setInitialCode] = useState<string>('');
  const [initialViewId, setInitialViewId] = useState<string>('');

  useEffect(() => {
    // Check for code in URL (e.g., ?code=123456 or ?view=AERO-XXXX)
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
  }, []);

  // Mouse tracking for interactive background
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      document.documentElement.style.setProperty('--mouse-x', `${e.clientX}px`);
      document.documentElement.style.setProperty('--mouse-y', `${e.clientY}px`);
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  const addNotification = (message: string, type: 'success' | 'info' | 'error') => {
    const id = Date.now().toString();
    setNotifications(prev => [...prev, { id, message, type, timestamp: Date.now() }]);
    
    // Auto remove
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
      {/* Apple-style Interactive Background */}
      <div
        className="fixed inset-0 pointer-events-none z-0 transition-opacity duration-700"
        style={{
          background: `radial-gradient(circle 600px at var(--mouse-x, 50%) var(--mouse-y, 50%), rgba(100, 150, 255, 0.15), transparent 80%)`,
          filter: 'blur(80px)',
        }}
      />

      {/* Toast Notifications */}
      <div className="fixed top-4 left-4 right-4 md:left-auto md:right-4 z-50 flex flex-col gap-2 pointer-events-none">
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

      {/* Header */}
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-20 transition-colors duration-300">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 h-14 md:h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 cursor-pointer" onClick={() => setMode('send')}>
            <div className="bg-brand-600 p-1.5 md:p-2 rounded-[22.5%] text-white shadow-sm">
              <Zap size={18} fill="currentColor" className="md:w-5 md:h-5" />
            </div>
            <h1 className="text-lg md:text-xl font-bold text-slate-900 dark:text-white tracking-tight">AeroDrop</h1>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-start pt-4 md:pt-8 pb-8 px-3 md:px-4 w-full max-w-5xl mx-auto overflow-hidden">
        
        {/* Navigation Tabs - Floating Capsule with Sliding Active State */}
        <div className="w-full max-w-xl mb-8 relative z-10">
            <div className="bg-white dark:bg-slate-900 p-1.5 rounded-full grid grid-cols-3 relative transition-all duration-300 shadow-[0_12px_30px_rgba(0,0,0,0.08)] border border-slate-50 dark:border-slate-800">
              {/* Sliding Background */}
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

        {/* Component View with 3D Flip Effect */}
        <div className="w-full flex-1 flex flex-col perspective-[2000px]">
          {/* We use hidden/block instead of conditional rendering to keep PeerJS connections alive (Send mode) */}
          <ErrorBoundary>
            <div className={`${mode === 'send' ? 'block animate-flip-in' : 'hidden'} h-full transform-style-3d`}>
              <Sender onNotification={addNotification} />
            </div>
          </ErrorBoundary>
          <ErrorBoundary>
            <div className={`${mode === 'receive' ? 'block animate-flip-in' : 'hidden'} h-full transform-style-3d`}>
              <Receiver initialCode={initialCode} onNotification={addNotification} />
            </div>
          </ErrorBoundary>
          <ErrorBoundary>
            <div className={`${mode === 'screen' ? 'block animate-flip-in' : 'hidden'} h-full transform-style-3d`}>
              <ScreenShare initialViewId={initialViewId} onNotification={addNotification} />
            </div>
          </ErrorBoundary>
        </div>
        
        <div className="mt-8 text-center max-w-md mx-auto space-y-2 pb-4 md:pb-0">
          <p className="text-[10px] md:text-xs text-slate-400 dark:text-slate-600">
            Powered by WebRTC. 数据直接在设备间点对点传输，不经过云端存储。 @Tianzora
          </p>
        </div>
      </main>
    </div>
  );
};

export default App;