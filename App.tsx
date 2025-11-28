import React, { useState, useEffect } from 'react';
import { Sender } from './components/Sender';
import { Receiver } from './components/Receiver';
import { ChatRoom } from './components/ChatRoom';
import { Share, DownloadCloud, Zap, Bell, MessageCircle } from 'lucide-react';
import { AppNotification } from './types';

const App: React.FC = () => {
  const [mode, setMode] = useState<'send' | 'receive' | 'chat'>('send');
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

  const getNavBackgroundStyle = () => {
      switch(mode) {
          case 'send': return 'translate-x-0';
          case 'receive': return 'translate-x-[100%]';
          case 'chat': return 'translate-x-[200%]';
      }
  };

  return (
    <div className="min-h-[100dvh] bg-slate-50 flex flex-col">
      {/* Toast Notifications */}
      <div className="fixed top-4 left-4 right-4 md:left-auto md:right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {notifications.map(n => (
          <div key={n.id} className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border animate-pop-in ${
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
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 h-14 md:h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 cursor-pointer" onClick={() => setMode('send')}>
            <div className="bg-brand-600 p-1.5 md:p-2 rounded-lg text-white">
              <Zap size={18} fill="currentColor" className="md:w-5 md:h-5" />
            </div>
            <h1 className="text-lg md:text-xl font-bold text-slate-900 tracking-tight">AeroDrop</h1>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-start pt-4 md:pt-8 pb-8 px-3 md:px-4 w-full max-w-5xl mx-auto overflow-hidden">
        
        {/* Navigation Tabs - Sliding Animation */}
        <div className="w-full max-w-xl mb-6 relative z-10">
            <div className="bg-white p-1 rounded-xl border border-slate-200 shadow-sm grid grid-cols-3 relative">
              {/* Sliding Background */}
              <div 
                  className={`absolute top-1 left-1 bottom-1 w-[calc((100%-0.5rem)/3)] bg-brand-600 rounded-lg shadow-md transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] ${getNavBackgroundStyle()}`}
              ></div>

              <button
                onClick={() => setMode('send')}
                className={`relative z-10 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-bold transition-colors duration-200 whitespace-nowrap ${
                  mode === 'send' ? 'text-white' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                <Share size={16} />
                发送
              </button>
              <button
                onClick={() => setMode('receive')}
                className={`relative z-10 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-bold transition-colors duration-200 whitespace-nowrap ${
                  mode === 'receive' ? 'text-white' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                <DownloadCloud size={16} />
                接收
              </button>
              <button
                onClick={() => setMode('chat')}
                className={`relative z-10 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-bold transition-colors duration-200 whitespace-nowrap ${
                  mode === 'chat' ? 'text-white' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                <MessageCircle size={16} />
                聊天
              </button>
            </div>
        </div>

        {/* Component View with 3D Flip Effect */}
        <div className="w-full flex-1 flex flex-col perspective-[2000px]">
          {/* We use hidden/block instead of conditional rendering to keep PeerJS connections alive (Send mode) */}
          <div className={`${mode === 'send' ? 'block animate-flip-in' : 'hidden'} h-full transform-style-3d`}>
            <Sender onNotification={addNotification} />
          </div>
          <div className={`${mode === 'receive' ? 'block animate-flip-in' : 'hidden'} h-full transform-style-3d`}>
            <Receiver initialCode={initialCode} onNotification={addNotification} />
          </div>
          <div className={`${mode === 'chat' ? 'block animate-flip-in' : 'hidden'} h-full transform-style-3d`}>
            <ChatRoom onNotification={addNotification} />
          </div>
        </div>
        
        <div className="mt-8 text-center max-w-md mx-auto space-y-2 pb-4 md:pb-0">
          <p className="text-[10px] md:text-xs text-slate-400">
            Powered by WebRTC. 数据直接在设备间点对点传输，不经过云端存储。 @Tianzora
          </p>
        </div>
      </main>
    </div>
  );
};

export default App;