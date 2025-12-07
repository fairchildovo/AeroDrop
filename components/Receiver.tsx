import React, { useState, useEffect, useRef } from 'react';
import Peer, { DataConnection } from 'peerjs';
// @ts-ignore
import streamSaver from 'streamsaver';
import { TransferState, FileMetadata, P2PMessage } from '../types';
import { formatFileSize } from '../services/fileUtils';
import { getIceConfig } from '../services/stunService';
import { Download, HardDriveDownload, Loader2, AlertCircle, Eye, Delete, FileCode, FileImage, FileAudio, FileVideo, FileArchive, File as FileIcon, ClipboardPaste, Layers, PlayCircle, X } from 'lucide-react';

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
  const [canResume, setCanResume] = useState(false);
  
  const [currentFileName, setCurrentFileName] = useState<string>('');
  const [currentFileIndex, setCurrentFileIndex] = useState<number>(0);
  const [totalFiles, setTotalFiles] = useState<number>(0);

  const [downloadSpeed, setDownloadSpeed] = useState<string>('0 KB/s');
  const [eta, setEta] = useState<string>('--');

  const peerRef = useRef<Peer | null>(null);
  const connRef = useRef<DataConnection | null>(null);
  const retryCountRef = useRef<number>(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const metadataRef = useRef<FileMetadata | null>(null);
  const currentFileIndexRef = useRef<number>(0); 
  const completedFileIndicesRef = useRef<Set<number>>(new Set());
  const isTransferActiveRef = useRef<boolean>(false);

  const chunksRef = useRef<ArrayBuffer[]>([]);
  const receivedChunksCountRef = useRef<number>(0);
  const receivedSizeRef = useRef<number>(0);
  const currentFileSizeRef = useRef<number>(0);
  
  const isStreamingRef = useRef<boolean>(false);
  const nativeWriterRef = useRef<FileSystemWritableFileStream | null>(null);
  const streamSaverWriterRef = useRef<WritableStreamDefaultWriter | null>(null);
  
  // 队列用于保证写入顺序
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const writeBufferRef = useRef<Uint8Array[]>([]);
  const writeBufferSizeRef = useRef<number>(0);
  const BUFFER_FLUSH_THRESHOLD = 16 * 1024 * 1024; // 16MB 缓冲区 (Sweet Spot for Performance/UI Blocking)

  const lastSpeedUpdateRef = useRef<number>(0);
  const lastSpeedBytesRef = useRef<number>(0);

  useEffect(() => { if (initialCode) setCode(initialCode); }, [initialCode]);
  useEffect(() => { if (code.length === 4 && state === TransferState.IDLE) handleConnect(); }, [code, state]);

  useEffect(() => {
      const handleFocus = async () => {
          if (state === TransferState.IDLE && code.length < 4) {
              try {
                  const text = await navigator.clipboard.readText();
                  if (/^\d{4}$/.test(text)) setCode(text);
              } catch (e) { console.debug("Clipboard read failed", e); }
          }
      };
      window.addEventListener('focus', handleFocus);
      return () => window.removeEventListener('focus', handleFocus);
  }, [state, code]);

  useEffect(() => {
    return () => {
      if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
      if (connRef.current) connRef.current.close();
      if (peerRef.current) peerRef.current.destroy();
      abortStreams(); 
    };
  }, []);

  const abortStreams = async () => {
      try {
          if (nativeWriterRef.current) { await nativeWriterRef.current.close(); nativeWriterRef.current = null; }
          if (streamSaverWriterRef.current) { await streamSaverWriterRef.current.abort(); streamSaverWriterRef.current = null; }
          isStreamingRef.current = false;
      } catch (e) { console.warn("Stream abort warning:", e); }
  };

  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;
    const requestWakeLock = async () => {
      try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (err) {}
    };
    const handleVisibilityChange = () => { if (document.visibilityState === 'visible' && state === TransferState.TRANSFERRING) requestWakeLock(); };
    if (state === TransferState.TRANSFERRING) { requestWakeLock(); document.addEventListener('visibilitychange', handleVisibilityChange); }
    return () => { if (wakeLock) wakeLock.release().catch(() => {}); document.removeEventListener('visibilitychange', handleVisibilityChange); };
  }, [state]);

  useEffect(() => {
    let interval: number;
    if (state === TransferState.TRANSFERRING) {
        interval = window.setInterval(() => {
            if (!currentFileSizeRef.current) return;
            const now = Date.now();
            const received = receivedSizeRef.current;
            const total = currentFileSizeRef.current;
            const pct = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;
            setProgress(pct);
            
            const timeDiff = now - lastSpeedUpdateRef.current;
            if (timeDiff >= 1000) {
                const bytesDiff = received - lastSpeedBytesRef.current;
                const speed = (bytesDiff / timeDiff) * 1000;
                const safeSpeed = Math.max(0, speed);
                setDownloadSpeed(formatFileSize(safeSpeed) + '/s');
                if (safeSpeed > 0 && total > received) {
                    const remainingBytes = total - received;
                    const seconds = remainingBytes / safeSpeed;
                    if (seconds > 60) setEta(`${Math.ceil(seconds / 60)} 分钟`); else setEta(`${Math.ceil(seconds)} 秒`);
                } else if (received >= total) { setEta('完成'); } else { setEta('--'); }
                lastSpeedUpdateRef.current = now;
                lastSpeedBytesRef.current = received;
            }
        }, 1000);
    }
    return () => clearInterval(interval);
  }, [state]);

  // === 核心写入逻辑：合并小块并写入磁盘 ===
  const flushSpecificBatch = async (batch: Uint8Array[], totalLen: number) => {
      // 卫语句：防止取消后继续写入 (Fix Race Condition)
      if (!isStreamingRef.current) return;
      
      try {
          // 合并 Buffer 减少系统调用
          const combined = new Uint8Array(totalLen);
          let offset = 0;
          for (const chunk of batch) {
              combined.set(chunk, offset);
              offset += chunk.byteLength;
          }

          if (nativeWriterRef.current) {
              await nativeWriterRef.current.write(combined);
          } else if (streamSaverWriterRef.current) {
              await streamSaverWriterRef.current.write(combined);
          }
      } catch (err) {
          console.error("Write Error:", err);
          setErrorMsg("写入文件失败，磁盘可能已满或权限不足。");
          setState(TransferState.ERROR);
          if (connRef.current) connRef.current.close();
      }
  };

  const setupConnListeners = (conn: DataConnection) => {
    connRef.current = conn;
    conn.on('open', () => {
      if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
      retryCountRef.current = 0;
    });

    conn.on('data', async (data: any) => {
      if (!isTransferActiveRef.current && state !== TransferState.IDLE && state !== TransferState.WAITING_FOR_PEER && state !== TransferState.PEER_CONNECTED) {
          return;
      }

      const isBinary = data instanceof ArrayBuffer || (data.constructor && data.constructor.name === 'ArrayBuffer') || ArrayBuffer.isView(data);
      
      if (isBinary) {
         if (!isTransferActiveRef.current) return;

         const chunkData = (ArrayBuffer.isView(data) ? data.buffer : data) as ArrayBuffer;
         const byteLength = chunkData.byteLength;

         if (byteLength > 0) {
             receivedChunksCountRef.current++;
             receivedSizeRef.current += byteLength;
             
             if (isStreamingRef.current) {
                 // 创建副本以防 ArrayBuffer 被复用/分离
                 writeBufferRef.current.push(new Uint8Array(chunkData));
                 writeBufferSizeRef.current += byteLength;
                 
                 // 缓冲区满，触发写入
                 if (writeBufferSizeRef.current >= BUFFER_FLUSH_THRESHOLD) {
                     const batch = writeBufferRef.current;
                     const batchSize = writeBufferSizeRef.current;
                     
                     writeBufferRef.current = [];
                     writeBufferSizeRef.current = 0;
                     
                     // 加入队列，保证顺序写入
                     writeQueueRef.current = writeQueueRef.current.then(() => flushSpecificBatch(batch, batchSize));
                 }
             } else {
                 chunksRef.current.push(chunkData);
             }
         }
         return;
      }

      // 处理信令消息
      const msg = data as P2PMessage;
      
      if (msg.type === 'METADATA') {
        const meta = msg.payload as FileMetadata;
        const previousMeta = metadataRef.current;
        // 只有文件完全一致才能续传
        let isResumable = false;
        if (previousMeta && previousMeta.totalSize === meta.totalSize && previousMeta.files.length === meta.files.length) {
            isResumable = true;
        } else {
            resetStateForNewTransfer();
        }
        
        setMetadata(meta);
        metadataRef.current = meta;
        setTotalFiles(meta.files?.length || 0);
        setState(TransferState.PEER_CONNECTED);
        setCanResume(isResumable);
        isTransferActiveRef.current = false;
        
        if (isResumable && onNotification) onNotification("发现上次未完成的传输", 'info');
      } 
      else if (msg.type === 'FILE_START') {
        isTransferActiveRef.current = true;
        const { fileName, fileSize, fileIndex } = msg.payload;
        
        // 关键修复：流式传输下 chunksRef 是空的，长度为0。
        // 如果我们请求了续传 (Resume)，Sender 会发来 index=0 (如果被重置) 或 index=N。
        // 这里必须严格判断是否真的在续传同一个文件的同一个位置
        const resumingSameFile = currentFileIndexRef.current === fileIndex && chunksRef.current.length > 0;
        
        if (!resumingSameFile) {
            // 新文件或重新开始
            await abortStreams(); // 关闭旧流
            chunksRef.current = [];
            writeBufferRef.current = [];
            writeBufferSizeRef.current = 0;
            receivedChunksCountRef.current = 0;
            receivedSizeRef.current = 0;

            // 尝试建立流式写入
            // 注意：对于 Index 0，通常在 acceptTransfer 已建立 nativeWriter。
            // 但如果是 Resume 且 nativeWriter 已失效，我们需要在此处重建 (降级为 StreamSaver)
            if (!nativeWriterRef.current) {
                if (streamSaver) {
                     try {
                         const fileStream = streamSaver.createWriteStream(fileName, { size: fileSize });
                         streamSaverWriterRef.current = fileStream.getWriter();
                         isStreamingRef.current = true;
                     } catch(e) { isStreamingRef.current = false; }
                }
            } else {
                // nativeWriter 存在，复用之
                isStreamingRef.current = true;
            }
        }
        
        currentFileSizeRef.current = fileSize;
        currentFileIndexRef.current = fileIndex;
        
        lastSpeedUpdateRef.current = Date.now();
        lastSpeedBytesRef.current = receivedSizeRef.current;
        
        setCurrentFileName(fileName);
        setCurrentFileIndex(fileIndex + 1);
        setProgress(0);
        setEta('计算中...');
        setDownloadSpeed('0 KB/s');
      }
      else if (msg.type === 'FILE_COMPLETE') {
         if (!isTransferActiveRef.current) return;

         if (isStreamingRef.current) {
             const finalBatch = writeBufferRef.current;
             const finalSize = writeBufferSizeRef.current;
             writeBufferRef.current = [];
             writeBufferSizeRef.current = 0;

             writeQueueRef.current = writeQueueRef.current.then(async () => {
                 if (finalSize > 0) await flushSpecificBatch(finalBatch, finalSize);
                 await abortStreams(); // 关闭文件句柄，完成保存
                 
                 if (isTransferActiveRef.current) {
                    completedFileIndicesRef.current.add(currentFileIndexRef.current);
                    if (onNotification) onNotification(`文件 ${currentFileName} 已保存`, 'success');
                 }
             }).catch(e => console.error("File Complete Error", e));
             
             await writeQueueRef.current;
         } else {
             saveCurrentFile();
         }
      } 
      else if (msg.type === 'ALL_FILES_COMPLETE') {
         if (!isTransferActiveRef.current) return;
         await writeQueueRef.current;
         setState(TransferState.COMPLETED);
         if (onNotification) onNotification("所有文件接收完毕", 'success');
         resetStateForNewTransfer();
         isTransferActiveRef.current = false; 
      }
      else if (msg.type === 'REJECT_TRANSFER') {
         setErrorMsg(msg.payload?.reason || "发送方拒绝了请求。");
         setState(TransferState.ERROR);
         conn.close();
      }
      else if (msg.type === 'TRANSFER_CANCELLED') {
         setErrorMsg("发送方已停止分享。");
         setState(TransferState.ERROR);
         conn.close();
      }
    });

    conn.on('close', () => {
       // 修复：断开连接时若未完成，应切换到错误状态，而不是卡在传输界面
       if (state === TransferState.TRANSFERRING || state === TransferState.WAITING_FOR_PEER) {
           setErrorMsg("连接已断开");
           setState(TransferState.ERROR);
       }
       console.log("Connection closed.");
    });
  };

  const resetStateForNewTransfer = () => {
      chunksRef.current = [];
      writeBufferRef.current = [];
      writeBufferSizeRef.current = 0;
      receivedChunksCountRef.current = 0;
      receivedSizeRef.current = 0;
      completedFileIndicesRef.current.clear();
      currentFileIndexRef.current = 0;
      setDownloadSpeed('0 KB/s');
      setEta('--');
      abortStreams();
      writeQueueRef.current = Promise.resolve();
  };

  const saveCurrentFile = () => {
      if (!isTransferActiveRef.current) return;
      if (receivedSizeRef.current === 0 && currentFileSizeRef.current > 0) return;
      
      let finalName = `file_${Date.now()}.bin`;
      let finalType = 'application/octet-stream';
      if (metadataRef.current && metadataRef.current.files[currentFileIndexRef.current]) {
          finalName = metadataRef.current.files[currentFileIndexRef.current].name;
          finalType = metadataRef.current.files[currentFileIndexRef.current].type;
      }
      try {
          const blob = new Blob(chunksRef.current, { type: finalType });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = finalName;
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          completedFileIndicesRef.current.add(currentFileIndexRef.current);
          if (onNotification) onNotification(`文件 ${finalName} 已保存`, 'success');
      } catch (e) { console.error("Save failed:", e); }
      chunksRef.current = [];
      receivedChunksCountRef.current = 0;
      receivedSizeRef.current = 0;
  };

  const handleConnect = async () => {
    if (!code || code.length !== 4) return;
    setState(TransferState.WAITING_FOR_PEER);
    setErrorMsg('');
    retryCountRef.current = 0;
    
    if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
    connectionTimeoutRef.current = setTimeout(() => {
        if (peerRef.current) peerRef.current.destroy();
        setErrorMsg("连接超时。请检查口令是否正确。");
        setState(TransferState.ERROR);
    }, 8000);

    if (peerRef.current) peerRef.current.destroy();
    
    // 使用优化后的配置 (仅 Google/Cloudflare STUN)
    const iceConfig = await getIceConfig();
    const peer = new Peer({ debug: 1, config: iceConfig }); // 移除 iceConfig.secure 类型不匹配问题
    
    peer.on('open', () => {
      const conn = peer.connect(`aerodrop-${code}`, { reliable: true });
      setupConnListeners(conn);
    });
    
    peer.on('error', (err) => {
       // ... 保持原有重试逻辑 ...
       if (err.type === 'peer-unavailable' && retryCountRef.current < 3) {
          retryCountRef.current++;
          setTimeout(() => {
             if (peerRef.current && !peerRef.current.destroyed) {
                const conn = peerRef.current.connect(`aerodrop-${code}`, { reliable: true });
                setupConnListeners(conn);
             }
          }, 2000);
       } else {
           setErrorMsg(`连接错误: ${err.type}`);
           setState(TransferState.ERROR);
       }
    });
    peerRef.current = peer;
  };

  const acceptTransfer = async () => {
    if (connRef.current) {
      resetStateForNewTransfer();
      isTransferActiveRef.current = true;
      
      // 尝试初始化第一个文件的写入器 (Native FS)
      if (metadata && metadata.files.length > 0) {
          const file = metadata.files[0];
          const isSingleFile = metadata.files.length === 1;
          
          if (isSingleFile && window.showSaveFilePicker) {
              try {
                  const handle = await window.showSaveFilePicker({ suggestedName: file.name });
                  const writable = await handle.createWritable();
                  nativeWriterRef.current = writable;
                  isStreamingRef.current = true;
                  if (onNotification) onNotification("已启用直接磁盘写入模式", 'success');
              } catch (err: any) { 
                  if (err.name !== 'AbortError') console.warn("Native Save Failed", err); 
                  // 如果取消，不强制流式，回退到内存或 StreamSaver
              }
          }
          
          // 如果 Native 失败或未启用，StreamSaver 将在 FILE_START 中按需初始化
      }
      
      connRef.current.send({ type: 'ACCEPT_TRANSFER' });
      setState(TransferState.TRANSFERRING);
    }
  };

  const resumeTransfer = () => {
      if (connRef.current) {
          isTransferActiveRef.current = true;
          const currentIdx = currentFileIndexRef.current;
          
          // 修复：如果是流式传输，chunksRef 已被清空，length 为 0。
          // 这意味着必须重新开始传输该文件，不能从中间断点恢复。
          // 我们发送 chunkIndex: 0 让发送方重置该文件。
          const nextChunkIndex = chunksRef.current.length;
          
          isStreamingRef.current = false; // FILE_START 会重新检测并开启
          
          if (completedFileIndicesRef.current.has(currentIdx)) {
              connRef.current.send({ type: 'RESUME_REQUEST', payload: { fileIndex: currentIdx + 1, chunkIndex: 0 } });
          } else {
              // 对于流式传输，nextChunkIndex 为 0，实际上是 "Restart File"
              connRef.current.send({ type: 'RESUME_REQUEST', payload: { fileIndex: currentIdx, chunkIndex: nextChunkIndex } });
          }
          setState(TransferState.TRANSFERRING);
      }
  };

  const reset = () => {
    isStreamingRef.current = false; // Fix: Immediate flag to prevent queued writes from executing
    isTransferActiveRef.current = false;
    // ... 保持原有逻辑 ...
    abortStreams().then(() => {
        if (connRef.current) connRef.current.close();
        if (peerRef.current) peerRef.current.destroy();
        setMetadata(null);
        setCode('');
        setState(TransferState.IDLE);
        setErrorMsg('');
        setProgress(0);
        resetStateForNewTransfer();
    });
  };

  // 辅助 UI 函数保持不变
  const handleRetry = () => { if (code.length === 4) handleConnect(); else reset(); };
  const handleDigitClick = (digit: string) => { if (code.length < 4) setCode(prev => prev + digit); };
  const handleBackspace = () => { setCode(prev => prev.slice(0, -1)); };
  const handleClear = () => { setCode(''); };
  const handlePaste = async () => { /* ... */ };
  const getFileIcon = (name: string, type: string) => { /* ... */ return <FileIcon size={24} className="text-slate-400" />; };

  const primaryFile = metadata?.files?.[0];
  const isMultiFile = (metadata?.files?.length || 0) > 1;

  // ... JSX 部分与之前相同，省略以节省空间 ...
  // 注意：确保 JSX 中的 onClick={handleRetry} 等绑定正确
  return (
    <div className="max-w-xl mx-auto p-6 bg-white dark:bg-slate-800 rounded-2xl shadow-xl border border-slate-100 dark:border-slate-700 transition-colors">
      {/* 头部标题 */}
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-slate-800 dark:text-white">接收文件</h2>
        <p className="text-slate-500 dark:text-slate-400">输入 4 位口令</p>
      </div>

      {/* IDLE 状态输入框 */}
      {state === TransferState.IDLE && (
         /* ... 原有数字键盘 UI ... */
         <div className="flex flex-col items-center">
             <div className="relative mb-8 max-w-[280px] mx-auto group">
                 {/* ... 显示 4 个数字框 ... */}
                 <div className="flex gap-4 justify-center pointer-events-none">
                   {[0, 1, 2, 3].map((i) => (
                     <div key={i} className={`w-14 h-16 border-2 rounded-xl flex items-center justify-center text-3xl font-bold font-mono transition-all duration-200 ${code[i] ? 'border-brand-500 text-brand-600 dark:text-brand-400 shadow-sm bg-white dark:bg-slate-700' : 'border-slate-200 dark:border-slate-600 text-slate-300 dark:text-slate-600 bg-white dark:bg-slate-700'}`}>{code[i] || ''}</div>
                   ))}
                 </div>
                 <input ref={inputRef} type="text" inputMode="numeric" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" autoFocus />
             </div>
             {/* ... 数字键盘按钮 ... */}
             <div className="grid grid-cols-3 gap-3 w-full max-w-[280px] mb-8">
                 {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
                   <button key={num} onClick={() => handleDigitClick(num.toString())} className="h-16 rounded-xl bg-slate-50 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-2xl font-semibold hover:bg-slate-100 dark:hover:bg-slate-600 transition-colors shadow-sm border border-slate-100 dark:border-slate-600">{num}</button>
                 ))}
                 <button onClick={() => { navigator.clipboard.readText().then(t => { if(/^\d{4}$/.test(t)) setCode(t) }) }} className="h-16 rounded-xl bg-blue-50 dark:bg-blue-900/20 text-brand-600 dark:text-brand-400 flex items-center justify-center hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors shadow-sm border border-blue-100 dark:border-blue-900/30"><ClipboardPaste size={20} /></button>
                 <button onClick={() => handleDigitClick('0')} className="h-16 rounded-xl bg-slate-50 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-2xl font-semibold hover:bg-slate-100 dark:hover:bg-slate-600 transition-colors shadow-sm border border-slate-100 dark:border-slate-600">0</button>
                 <button onClick={handleBackspace} onContextMenu={(e) => { e.preventDefault(); handleClear(); }} className="h-16 rounded-xl bg-slate-50 dark:bg-slate-700 text-slate-600 dark:text-slate-400 flex items-center justify-center hover:bg-slate-100 dark:hover:bg-slate-600 transition-colors shadow-sm border border-slate-100 dark:border-slate-600"><Delete size={24} /></button>
             </div>
         </div>
      )}

      {/* WAITING 状态 */}
      {state === TransferState.WAITING_FOR_PEER && (
         <div className="flex flex-col items-center py-10 animate-pop-in">
           <Loader2 size={40} className="animate-spin text-brand-500 mb-4" />
           <p className="text-slate-600 dark:text-slate-300 font-medium">正在连接发送方...</p>
           <button onClick={reset} className="mt-8 px-6 py-2 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 rounded-full text-sm hover:bg-slate-50 dark:hover:bg-slate-600 hover:text-red-500 dark:hover:text-red-400 transition-colors shadow-sm active:scale-95">取消</button>
         </div>
      )}

      {/* CONNECTED / TRANSFERRING 状态 */}
      {(state === TransferState.PEER_CONNECTED || state === TransferState.TRANSFERRING) && metadata && (
        <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-6 animate-slide-up">
           {/* ... 文件信息显示 ... */}
           <div className="flex items-start gap-4 mb-6">
               <div className="w-12 h-12 bg-white dark:bg-slate-800 rounded-lg shadow-sm border border-slate-100 dark:border-slate-700 flex items-center justify-center text-slate-500 shrink-0">
                  {isMultiFile ? <Layers size={24} className="text-brand-500" /> : <FileIcon size={24} />}
               </div>
               <div className="flex-1">
                   <h4 className="font-bold text-slate-800 dark:text-white text-lg leading-tight mb-1 truncate">{isMultiFile ? `${metadata.files.length} 个文件` : primaryFile?.name}</h4>
                   <p className="text-sm text-slate-500 dark:text-slate-400">{formatFileSize(metadata.totalSize)}</p>
               </div>
           </div>
           
           {/* ... 操作按钮 ... */}
           {state === TransferState.PEER_CONNECTED && (
             <div className="space-y-3">
                 {canResume && (
                     <button onClick={resumeTransfer} className="w-full bg-brand-600 text-white font-bold py-3 rounded-lg hover:bg-brand-700 transition-all flex items-center justify-center gap-2 shadow-md">
                         <PlayCircle size={18} /> {isStreamingRef.current ? '重新开始' : '继续下载'}
                     </button>
                 )}
                 <button onClick={acceptTransfer} className={`w-full font-bold py-3 rounded-lg transition-all flex items-center justify-center gap-2 ${canResume ? 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200' : 'bg-slate-900 dark:bg-brand-600 text-white'}`}>
                   <Download size={18} /> {canResume ? '重新下载所有' : '确认并下载'}
                 </button>
             </div>
           )}

           {state === TransferState.TRANSFERRING && (
             <div className="space-y-3">
               {/* ... 进度条 ... */}
               <div className="flex justify-between text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase">
                  <span>{progress}%</span>
               </div>
               <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-3 overflow-hidden">
                 <div className="bg-brand-500 h-full transition-all duration-300 relative" style={{ width: `${progress}%` }}></div>
               </div>
               <div className="flex justify-between items-center text-xs text-slate-500 pt-1">
                  <span>{downloadSpeed}</span>
                  <span>{eta}</span>
               </div>
               <button onClick={reset} className="w-full py-2 mt-2 bg-red-50 text-red-600 rounded-lg text-sm">取消</button>
             </div>
           )}
        </div>
      )}

      {/* ERROR 状态 */}
      {state === TransferState.ERROR && (
        <div className="text-center py-8 animate-pop-in">
           <AlertCircle size={32} className="text-red-500 mx-auto mb-4" />
           <h3 className="text-lg font-bold text-slate-800 dark:text-white">传输失败</h3>
           <p className="text-slate-500 dark:text-slate-400 mt-2 mb-6">{errorMsg}</p>
           <div className="flex gap-4 justify-center">
               <button onClick={reset} className="px-6 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg">取消</button>
               <button onClick={handleRetry} className="px-6 py-2 bg-slate-200 text-slate-700 rounded-lg hover:bg-slate-300">重试</button>
           </div>
        </div>
      )}

      {/* COMPLETED 状态 */}
      {state === TransferState.COMPLETED && (
        <div className="text-center py-8 animate-pop-in">
          <HardDriveDownload size={36} className="text-green-500 mx-auto mb-6" />
          <h3 className="text-2xl font-bold text-slate-800 dark:text-white">下载完成</h3>
          <button onClick={reset} className="mt-8 px-6 py-2 bg-slate-100 text-slate-700 font-medium rounded-lg hover:bg-slate-200">接收下一个</button>
        </div>
      )}
    </div>
  );
};