import React, { useState, useEffect } from 'react';
import { Share, PlusSquare, X, Download } from 'lucide-react';

export const PWAInstallPrompt: React.FC = () => {
  const [showPrompt, setShowPrompt] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    // Check if already installed
    if (window.matchMedia('(display-mode: standalone)').matches) {
      return;
    }

    // Android / Desktop
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e);
      // Wait a bit before showing to not be intrusive immediately
      setTimeout(() => setShowPrompt(true), 3000);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    // iOS Detection
    const userAgent = window.navigator.userAgent.toLowerCase();
    const isIosDevice = /iphone|ipad|ipod/.test(userAgent);
    // @ts-ignore
    const isStandalone = window.navigator.standalone === true;

    if (isIosDevice && !isStandalone) {
      setIsIOS(true);
      // Show iOS prompt after a delay
      setTimeout(() => setShowPrompt(true), 3000);
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;

    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;

    if (outcome === 'accepted') {
      setShowPrompt(false);
    }
    setDeferredPrompt(null);
  };

  if (!showPrompt) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-96 z-50 animate-slide-up">
      <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 p-4 relative overflow-hidden">

        <button
          onClick={() => setShowPrompt(false)}
          className="absolute top-2 right-2 p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
        >
          <X size={16} />
        </button>

        <div className="flex gap-4">
          <div className="bg-brand-100 dark:bg-brand-900/30 rounded-xl p-3 h-fit shrink-0">
            <Download size={24} className="text-brand-600 dark:text-brand-400" />
          </div>

          <div className="flex-1">
            <h3 className="font-bold text-slate-900 dark:text-white mb-1">
              安装 AeroDrop
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-3 leading-relaxed">
              像原生应用一样使用，支持离线访问和全屏体验。
            </p>

            {isIOS ? (
              <div className="bg-slate-50 dark:bg-slate-900/50 rounded-lg p-3 text-xs text-slate-600 dark:text-slate-300 border border-slate-100 dark:border-slate-700/50">
                <div className="flex items-center gap-2 mb-2">
                  1. 点击浏览器底部的 <Share size={14} className="inline text-blue-500" /> 分享按钮
                </div>
                <div className="flex items-center gap-2">
                  2. 选择 <PlusSquare size={14} className="inline text-slate-500" /> "添加到主屏幕"
                </div>
              </div>
            ) : (
              <button
                onClick={handleInstallClick}
                className="w-full bg-brand-600 hover:bg-brand-700 text-white text-sm font-bold py-2 rounded-lg transition-colors shadow-sm active:scale-[0.98]"
              >
                立即安装
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
