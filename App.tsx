import React, { useState, useEffect } from 'react';
import { Sender } from './components/Sender';
import { Receiver } from './components/Receiver';
import { Share, DownloadCloud, Zap, Bell } from 'lucide-react';
import { AppNotification } from './types';

const App: React.FC = () => {
  const [mode, setMode] = useState<'send' | 'receive'>('send');
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [initialCode, setInitialCode] = useState<string>('');

  useEffect(() => {
    // Check for code in URL (e.g., ?code=123456)
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (code) {
      setMode('receive');
      setInitialCode(code);
    }
  }, []);

  const addNotification = (message: string, type: 'success' | 'info' | 'error') => {
    const id = Date.now().toString();
    setNotifications(prev => [...prev, { id, message, type, timestamp: Date.now() }]);
    
    // Auto remove
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, 4000);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Toast Notifications */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {notifications.map(n => (
          <div key={n.id} className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg border animate-slide-in ${
            n.type === 'success' ? 'bg-white border-green-200 text-slate-800' : 
            n.type === 'error' ? 'bg-red-50 border-red-200 text-red-800' : 
            'bg-white border-slate-200 text-slate-800'
          }`}>
            <Bell size={16} className={n.type === 'success' ? 'text-green-500' : n.type === 'error' ? 'text-red-500' : 'text-blue-500'} />
            <span className="text-sm font-medium">{n.message}</span>
          </div>
        ))}
      </div>

      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 cursor-pointer" onClick={() => setMode('send')}>
            <div className="bg-brand-600 p-2 rounded-lg text-white">
              <Zap size={20} fill="currentColor" />
            </div>
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">AeroDrop</h1>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-start pt-8 pb-12 px-4">
        
        {/* Toggle Switch */}
        <div className="bg-white p-1.5 rounded-2xl border border-slate-200 shadow-sm mb-8 flex relative">
          <button
            onClick={() => setMode('send')}
            className={`flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-bold transition-all duration-200 ${
              mode === 'send' 
                ? 'bg-brand-600 text-white shadow-md' 
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Share size={18} />
            发送文件
          </button>
          <button
            onClick={() => setMode('receive')}
            className={`flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-bold transition-all duration-200 ${
              mode === 'receive' 
                ? 'bg-brand-600 text-white shadow-md' 
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
            }`}
          >
            <DownloadCloud size={18} />
            接收文件
          </button>
        </div>

        {/* Component View */}
        <div className="w-full animate-fade-in-up">
          {/* 
            关键修改：使用 CSS 类 (hidden/block) 控制显示，而不是条件渲染 ({mode === ... && ...})。
            这样即使切换到 Receive 界面，Sender 组件仍然挂载在 DOM 中，PeerJS 连接保持活跃。
          */}
          <div className={mode === 'send' ? 'block' : 'hidden'}>
            <Sender onNotification={addNotification} />
          </div>
          <div className={mode === 'receive' ? 'block' : 'hidden'}>
            <Receiver initialCode={initialCode} onNotification={addNotification} />
          </div>
        </div>
        
        <div className="mt-12 text-center max-w-md mx-auto space-y-2">
          <p className="text-xs text-slate-400">
            Powered by WebRTC. 文件直接在设备间点对点传输，不经过云端存储。
          </p>
        </div>
      </main>
    </div>
  );
};

export default App;