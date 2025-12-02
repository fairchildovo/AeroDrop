
import React, { useState, useEffect, useRef } from 'react';
import Peer, { DataConnection } from 'peerjs';
import { TransferState, FileMetadata, P2PMessage, ChunkPayload } from '../types';
import { formatFileSize } from '../services/fileUtils';
import { getIceConfig } from '../services/stunService'; // Import the new service
import { Download, HardDriveDownload, Loader2, AlertCircle, Eye, Delete, FileType, FileCode, FileImage, FileAudio, FileVideo, FileArchive, Package, File as FileIcon, ClipboardPaste, X, FolderOpen } from 'lucide-react';

interface ReceiverProps {
  initialCode?: string;
  onNotification?: (msg: string, type: 'success' | 'info' | 'error') => void;
}

export const Receiver: React.FC<ReceiverProps> = ({ initialCode, onNotification }) => {
  const [state, setState] = useState<TransferState>(TransferState.IDLE);
  const [code, setCode] = useState<string>('');
  const [metadata, setMetadata] = useState<FileMetadata | null>(null);
  const [progress, setProgress] = useState<number>(0);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [downloadedUrl, setDownloadedUrl] = useState<string | null>(null);
  
  // Download stats
  const [downloadSpeed, setDownloadSpeed] = useState<string>('0 KB/s');
  const [eta, setEta] = useState<string>('--');

  const peerRef = useRef<Peer | null>(null);
  const connRef = useRef<DataConnection | null>(null);
  const retryCountRef = useRef<number>(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Critical fix: Use ref for metadata to avoid stale closures in event listeners
  const metadataRef = useRef<FileMetadata | null>(null);

  // Chunking refs
  const chunksRef = useRef<ArrayBuffer[]>([]);
  const receivedChunksCountRef = useRef<number>(0);
  const receivedSizeRef = useRef<number>(0);
  const totalChunksRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const lastSpeedUpdateRef = useRef<number>(0);
  
  // Lock to prevent duplicate downloads
  const processingCompleteRef = useRef<boolean>(false);

  useEffect(() => {
    if (initialCode) {
      setCode(initialCode);
    }
  }, [initialCode]);

  // Auto-connect when code reaches 4 digits
  useEffect(() => {
    if (code.length === 4 && state === TransferState.IDLE) {
      handleConnect();
    }
  }, [code, state]);

  // Auto-read clipboard on focus
  useEffect(() => {
      const handleFocus = async () => {
          if (state === TransferState.IDLE && code.length < 4) {
              try {
                  const text = await navigator.clipboard.readText();
                  if (/^\d{4}$/.test(text)) {
                      setCode(text);
                  }
              } catch (e) {
                  console.debug("Clipboard read failed or denied", e);
              }
          }
      };

      window.addEventListener('focus', handleFocus);
      return () => window.removeEventListener('focus', handleFocus);
  }, [state, code]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
      if (connRef.current) connRef.current.close();
      if (peerRef.current) peerRef.current.destroy();
      if (downloadedUrl) URL.revokeObjectURL(downloadedUrl);
    };
  }, []);

  const updateStats = (currentBytes: number, totalBytes: number) => {
      const now = Date.now();
      const timeElapsed = now - startTimeRef.current;
      
      if (now - lastSpeedUpdateRef.current > 500 || currentBytes === totalBytes) {
          const speedBytesPerMs = timeElapsed > 0 ? currentBytes / timeElapsed : 0;
          const speedBytesPerSec = speedBytesPerMs * 1000;
          setDownloadSpeed(formatFileSize(speedBytesPerSec) + '/s');

          const remainingBytes = totalBytes - currentBytes;
          const remainingMs = speedBytesPerMs > 0 ? remainingBytes / speedBytesPerMs : 0;
          
          if (isFinite(remainingMs) && remainingMs > 0) {
             const seconds = Math.ceil(remainingMs / 1000);
             if (seconds > 60) {
                 const mins = Math.ceil(seconds / 60);
                 setEta(`${mins} 分钟`);
             } else {
                 setEta(`${seconds} 秒`);
             }
          } else {
              setEta(currentBytes === totalBytes ? '完成' : '计算中...');
          }
          
          lastSpeedUpdateRef.current = now;
      }
  };

  const setupConnListeners = (conn: DataConnection) => {
    connRef.current = conn;

    conn.on('open', () => {
      // Connection successful, clear timeout
      if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
      retryCountRef.current = 0;
    });

    conn.on('data', (data: any) => {
      const msg = data as P2PMessage;
      
      if (msg.type === 'METADATA') {
        // Update both state (for UI) and ref (for logic)
        setMetadata(msg.payload);
        metadataRef.current = msg.payload;
        setState(TransferState.PEER_CONNECTED);
      } else if (msg.type === 'FILE_CHUNK') {
        const payload = msg.payload as ChunkPayload;
        
        if (totalChunksRef.current === 0) {
            totalChunksRef.current = payload.total;
            chunksRef.current = new Array(payload.total);
            if (startTimeRef.current === 0) startTimeRef.current = Date.now();
        }

        if (!chunksRef.current[payload.index]) {
            chunksRef.current[payload.index] = payload.data;
            receivedChunksCountRef.current++;
            receivedSizeRef.current += payload.data.byteLength;
        }

        const currentMetadata = metadataRef.current;
        const totalSize = currentMetadata?.size || 0;
        
        if (totalSize > 0) {
            const pct = Math.min(100, Math.round((receivedSizeRef.current / totalSize) * 100));
            setProgress(pct);
            updateStats(receivedSizeRef.current, totalSize);
        }

        if (receivedChunksCountRef.current === totalChunksRef.current) {
            handleFileReassembly();
        }

      } else if (msg.type === 'FILE_COMPLETE') {
         if (receivedChunksCountRef.current === totalChunksRef.current) {
             handleFileReassembly();
         }
      } else if (msg.type === 'REJECT_TRANSFER') {
         setErrorMsg(msg.payload?.reason || "发送方拒绝了请求。");
         setState(TransferState.ERROR);
         conn.close();
      }
    });
    
    conn.on('close', () => {
       if (state !== TransferState.COMPLETED && state !== TransferState.ERROR && state !== TransferState.IDLE) {
           // Handle close
       }
    });
  };

  const handleCancelConnecting = () => {
    if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
    if (peerRef.current) peerRef.current.destroy();
    if (connRef.current) connRef.current.close();
    
    // Remove last digit to prevent auto-reconnect loop upon returning to IDLE state
    setCode(prev => prev.slice(0, -1));
    setState(TransferState.IDLE);
  };

  const handleConnect = async () => {
    if (!code || code.length !== 4) return;
    
    setState(TransferState.WAITING_FOR_PEER);
    setErrorMsg('');
    retryCountRef.current = 0;
    processingCompleteRef.current = false;

    if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);

    // Hard timeout after 8 seconds
    connectionTimeoutRef.current = setTimeout(() => {
        if (peerRef.current) peerRef.current.destroy();
        setErrorMsg("连接超时。请检查口令是否正确，或检查双方网络是否通畅。");
        setState(TransferState.ERROR);
    }, 8000);

    if (peerRef.current) peerRef.current.destroy();

    // Get Dynamic STUN config
    const iceConfig = await getIceConfig();

    const peer = new Peer({ 
      debug: 1,
      config: iceConfig // Use dynamic ICE servers
    });

    peer.on('open', () => {
      const destId = `aerodrop-${code}`;
      const conn = peer.connect(destId, { reliable: true });
      setupConnListeners(conn);
    });

    peer.on('error', (err) => {
      // If manually cancelled or timed out (peer destroyed), ignore errors
      if (!peerRef.current || peerRef.current.destroyed) return;

      if (err.type === 'peer-unavailable') {
        if (retryCountRef.current < 3) {
          retryCountRef.current++;
          setTimeout(async () => {
             if (peerRef.current && !peerRef.current.destroyed) {
                const destId = `aerodrop-${code}`;
                // Reconnect attempts also use the same peer (which already has config)
                const conn = peerRef.current.connect(destId, { reliable: true });
                setupConnListeners(conn);
             }
          }, 2000);
          return;
        }
        // Don't set error here immediately, wait for global timeout or user cancel
      } else {
        console.error(err);
      }
    });

    peerRef.current = peer;
  };

  const acceptTransfer = () => {
    if (connRef.current) {
      chunksRef.current = [];
      receivedSizeRef.current = 0;
      receivedChunksCountRef.current = 0;
      totalChunksRef.current = 0;
      startTimeRef.current = Date.now();
      lastSpeedUpdateRef.current = Date.now();
      processingCompleteRef.current = false;
      
      connRef.current.send({ type: 'ACCEPT_TRANSFER' });
      setState(TransferState.TRANSFERRING);
    }
  };

  const handleFileReassembly = () => {
    if (processingCompleteRef.current) return;
    if (state === TransferState.COMPLETED) return;
    
    let hasGaps = false;
    for(let i=0; i<totalChunksRef.current; i++) {
        if(!chunksRef.current[i]) {
            hasGaps = true;
            break;
        }
    }

    if (hasGaps) return;

    processingCompleteRef.current = true;

    // Use metadataRef.current to get the correct type even if state is stale in this closure context
    const currentMetadata = metadataRef.current;
    const blob = new Blob(chunksRef.current, { type: currentMetadata?.type || 'application/octet-stream' });
    handleFileReceived(blob);
  };

  const handleFileReceived = (fileBlob: Blob) => {
    setProgress(100);
    setState(TransferState.COMPLETED);
    
    const url = URL.createObjectURL(fileBlob);
    setDownloadedUrl(url); // Save URL for "Open File" button

    const a = document.createElement('a');
    a.href = url;
    // Use metadataRef.current for correct name
    a.download = metadataRef.current?.name || 'downloaded-file';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Note: Do not revoke URL immediately if we want to use the "Open" button
  };

  const reset = () => {
    if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
    if (peerRef.current) {
      peerRef.current.destroy();
      peerRef.current = null;
    }
    setMetadata(null);
    metadataRef.current = null; // Clear ref
    setCode('');
    setState(TransferState.IDLE);
    setErrorMsg('');
    setProgress(0);
    chunksRef.current = [];
    receivedSizeRef.current = 0;
    processingCompleteRef.current = false;
    if (downloadedUrl) {
        URL.revokeObjectURL(downloadedUrl);
        setDownloadedUrl(null);
    }
    
    const url = new URL(window.location.href);
    if (url.searchParams.has('code')) {
      url.searchParams.delete('code');
      window.history.pushState({}, '', url);
    }
  };

  const handleRetry = () => {
      if (code.length === 4) {
          // If code is complete, try connecting again
          setState(TransferState.IDLE);
          // Trigger effect will handle logic
      } else {
          reset();
      }
  };

  const handleDigitClick = (digit: string) => {
    if (code.length < 4) {
      setCode(prev => prev + digit);
    }
  };

  const handleBackspace = () => {
    setCode(prev => prev.slice(0, -1));
  };

  const handleClear = () => {
    setCode('');
  };

  const handlePaste = async () => {
      try {
          // Attempt to focus input first to satisfy browser interaction requirements
          if (inputRef.current) {
            inputRef.current.focus();
          }

          const text = await navigator.clipboard.readText();
          const digits = text.replace(/[^0-9]/g, '').slice(0, 4);
          
          if (digits) {
            setCode(digits);
            if (onNotification) onNotification("已从剪贴板粘贴", 'success');
          } else {
            if (onNotification) onNotification("剪贴板中未发现有效数字口令", 'info');
          }
      } catch (err) {
          console.error("Paste failed", err);
          // Graceful fallback suggestion
          if (onNotification) onNotification("请点击输入框并按 Ctrl+V 粘贴", 'info');
          // Focus anyway to allow Ctrl+V immediately
          if (inputRef.current) {
            inputRef.current.focus();
          }
      }
  };

  const getFileIcon = (name: string, type: string) => {
      const ext = name.split('.').pop()?.toLowerCase();
      
      if (type.startsWith('image/')) return <FileImage size={24} className="text-purple-500" />;
      if (type.startsWith('video/')) return <FileVideo size={24} className="text-red-500" />;
      if (type.startsWith('audio/')) return <FileAudio size={24} className="text-yellow-500" />;
      if (type.startsWith('text/') || ['js','ts','tsx','json','html','css'].includes(ext || '')) return <FileCode size={24} className="text-blue-500" />;
      if (['zip','rar','7z','tar','gz'].includes(ext || '')) return <FileArchive size={24} className="text-orange-500" />;
      if (['exe','msi','bat','sh','bin'].includes(ext || '')) return <Package size={24} className="text-slate-600 dark:text-slate-400" />;
      
      return <FileIcon size={24} className="text-slate-400" />;
  };

  return (
    <div className="max-w-xl mx-auto p-6 bg-white dark:bg-slate-800 rounded-2xl shadow-xl border border-slate-100 dark:border-slate-700 transition-colors">
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-slate-800 dark:text-white">接收文件</h2>
        <p className="text-slate-500 dark:text-slate-400">输入 4 位口令</p>
      </div>

      {state === TransferState.IDLE && (
        <div className="flex flex-col items-center">
           <div className="relative mb-8 max-w-[280px] mx-auto group">
             <div className="flex gap-4 justify-center pointer-events-none">
               {[0, 1, 2, 3].map((i) => (
                 <div 
                   key={i} 
                   className={`w-14 h-16 border-2 rounded-xl flex items-center justify-center text-3xl font-bold font-mono transition-all duration-200 ${
                      code[i] 
                        ? 'border-brand-500 text-brand-600 dark:text-brand-400 shadow-sm bg-white dark:bg-slate-700' 
                        : 'border-slate-200 dark:border-slate-600 text-slate-300 dark:text-slate-600 bg-white dark:bg-slate-700'
                   }`}
                 >
                   {code[i] || ''}
                 </div>
               ))}
             </div>
             <input
                ref={inputRef}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={4}
                value={code}
                onChange={(e) => {
                  const val = e.target.value.replace(/[^0-9]/g, '').slice(0, 4);
                  setCode(val);
                }}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer text-transparent bg-transparent"
                autoFocus
                autoComplete="off"
             />
           </div>

           <div className="grid grid-cols-3 gap-3 w-full max-w-[280px] mb-8">
             {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
               <button
                 key={num}
                 onClick={() => handleDigitClick(num.toString())}
                 className="h-16 rounded-xl bg-slate-50 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-2xl font-semibold hover:bg-slate-100 dark:hover:bg-slate-600 active:bg-slate-200 dark:active:bg-slate-500 transition-colors shadow-sm border border-slate-100 dark:border-slate-600"
               >
                 {num}
               </button>
             ))}
             <button
               onClick={handlePaste}
               title="粘贴"
               className="h-16 rounded-xl bg-blue-50 dark:bg-blue-900/20 text-brand-600 dark:text-brand-400 flex items-center justify-center hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors shadow-sm border border-blue-100 dark:border-blue-900/30"
             >
                <ClipboardPaste size={20} />
             </button>
             <button
               onClick={() => handleDigitClick('0')}
               className="h-16 rounded-xl bg-slate-50 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-2xl font-semibold hover:bg-slate-100 dark:hover:bg-slate-600 active:bg-slate-200 dark:active:bg-slate-500 transition-colors shadow-sm border border-slate-100 dark:border-slate-600"
             >
               0
             </button>
             <button
               onClick={handleBackspace}
               onContextMenu={(e) => { e.preventDefault(); handleClear(); }}
               className="h-16 rounded-xl bg-slate-50 dark:bg-slate-700 text-slate-600 dark:text-slate-400 flex items-center justify-center hover:bg-slate-100 dark:hover:bg-slate-600 transition-colors shadow-sm border border-slate-100 dark:border-slate-600"
             >
               <Delete size={24} />
             </button>
           </div>
        </div>
      )}

      {state === TransferState.WAITING_FOR_PEER && (
         <div className="flex flex-col items-center py-10 animate-pop-in">
           <Loader2 size={40} className="animate-spin text-brand-500 mb-4" />
           <p className="text-slate-600 dark:text-slate-300 font-medium">正在连接发送方...</p>
           {retryCountRef.current > 0 && (
             <p className="text-xs text-slate-400 mt-2">尝试连接中 ({retryCountRef.current}/3)...</p>
           )}
           <button 
             onClick={handleCancelConnecting}
             className="mt-8 px-6 py-2 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 rounded-full text-sm hover:bg-slate-50 dark:hover:bg-slate-600 hover:text-red-500 dark:hover:text-red-400 transition-colors shadow-sm active:scale-95"
           >
             取消
           </button>
         </div>
      )}

      {(state === TransferState.PEER_CONNECTED || state === TransferState.TRANSFERRING) && metadata && (
        <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-6 animate-slide-up">
           <div className="flex items-start gap-4 mb-6">
              <div className="w-12 h-12 bg-white dark:bg-slate-800 rounded-lg shadow-sm border border-slate-100 dark:border-slate-700 flex items-center justify-center text-slate-500 shrink-0">
                 {metadata.preview && metadata.type.startsWith('image/') ? (
                      <img src={metadata.preview} alt="Preview" className="w-full h-full object-cover rounded-lg" />
                  ) : (
                      getFileIcon(metadata.name, metadata.type)
                  )}
              </div>
              <div className="flex-1">
                 <h4 className="font-bold text-slate-800 dark:text-white text-lg leading-tight mb-1">{metadata.name}</h4>
                 <p className="text-slate-500 dark:text-slate-400 text-sm">{formatFileSize(metadata.size)} • {metadata.type || '未知类型'}</p>
               </div>
           </div>

           {metadata.preview && (
             <div className="mb-4 bg-white dark:bg-slate-800 p-3 rounded-lg border border-slate-200 dark:border-slate-700">
               <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300 font-bold text-sm mb-2">
                   <Eye size={16} />
                   <span>内容预览</span>
               </div>
               {metadata.type.startsWith('image/') ? (
                 <img src={metadata.preview} alt="Preview" className="max-h-48 rounded mx-auto border border-slate-100 dark:border-slate-700" />
               ) : (
                 <p className="text-xs text-slate-600 dark:text-slate-300 font-mono bg-slate-50 dark:bg-slate-900 p-2 rounded border border-slate-100 dark:border-slate-700 max-h-32 overflow-y-auto whitespace-pre-wrap">
                   {metadata.preview}
                 </p>
               )}
             </div>
           )}

           {state === TransferState.PEER_CONNECTED && (
             <button
               onClick={acceptTransfer}
               className="w-full bg-slate-900 dark:bg-brand-600 text-white font-bold py-3 rounded-lg hover:bg-slate-800 dark:hover:bg-brand-700 transition-all flex items-center justify-center gap-2"
             >
               <Download size={18} />
               确认并下载
             </button>
           )}

           {state === TransferState.TRANSFERRING && (
             <div className="space-y-3">
               <div className="flex justify-between text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                  <span>下载中</span>
                  <span>{progress}%</span>
               </div>
               <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-3 overflow-hidden shadow-inner relative">
                 <div 
                   className="bg-brand-500 h-full rounded-full transition-all duration-300 relative overflow-hidden" 
                   style={{ width: `${progress}%` }}
                 >
                     {/* Shimmer effect overlay */}
                     <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer" style={{ backgroundSize: '200% 100%' }}></div>
                 </div>
               </div>
               
               <div className="flex justify-between items-center text-xs text-slate-500 dark:text-slate-400 pt-1">
                  <div className="flex flex-col">
                    <span className="font-medium text-slate-700 dark:text-slate-300">{downloadSpeed}</span>
                    <span>下载速度</span>
                  </div>
                  <div className="flex flex-col items-end">
                    <span className="font-medium text-slate-700 dark:text-slate-300">{eta}</span>
                    <span>预计剩余</span>
                  </div>
               </div>
             </div>
           )}
        </div>
      )}

      {state === TransferState.COMPLETED && (
        <div className="text-center py-8 animate-pop-in">
          <div className="w-20 h-20 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-6 dark:bg-green-900/30 dark:text-green-400">
            <HardDriveDownload size={36} />
          </div>
          <h3 className="text-2xl font-bold text-slate-800 dark:text-white">下载完成</h3>
          <p className="text-slate-500 dark:text-slate-400 mt-2">文件已保存到您的设备。</p>
          
          <div className="flex flex-col gap-3 mt-8">
            <button 
                onClick={reset}
                className="px-6 py-2 bg-slate-100 text-slate-700 font-medium rounded-lg hover:bg-slate-200 transition-colors dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
            >
                接收下一个文件
            </button>
          </div>
        </div>
      )}

      {state === TransferState.ERROR && (
        <div className="text-center py-8 animate-pop-in">
           <div className="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4 dark:bg-red-900/30 dark:text-red-400">
             <AlertCircle size={32} />
           </div>
           <h3 className="text-lg font-bold text-slate-800 dark:text-white">传输失败</h3>
           <p className="text-slate-500 dark:text-slate-400 mt-2 px-4 mb-6">{errorMsg}</p>
           <div className="flex gap-4 justify-center">
               <button 
                 onClick={reset}
                 className="px-6 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 font-medium shadow-sm dark:bg-slate-700 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-600"
               >
                 取消
               </button>
               <button 
                 onClick={handleRetry}
                 className="px-6 py-2 bg-slate-200 text-slate-700 rounded-lg hover:bg-slate-300 font-medium dark:bg-slate-600 dark:text-white dark:hover:bg-slate-500"
               >
                 重试
               </button>
           </div>
        </div>
      )}
    </div>
  );
};
