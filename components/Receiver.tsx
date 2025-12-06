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
  
  // UI 状态
  const [currentFileName, setCurrentFileName] = useState<string>('');
  const [currentFileIndex, setCurrentFileIndex] = useState<number>(0);
  const [totalFiles, setTotalFiles] = useState<number>(0);

  // Stats
  const [downloadSpeed, setDownloadSpeed] = useState<string>('0 KB/s');
  const [eta, setEta] = useState<string>('--');

  const peerRef = useRef<Peer | null>(null);
  const connRef = useRef<DataConnection | null>(null);
  const retryCountRef = useRef<number>(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // === 关键数据 Refs ===
  const metadataRef = useRef<FileMetadata | null>(null);
  const currentFileIndexRef = useRef<number>(0); 
  const completedFileIndicesRef = useRef<Set<number>>(new Set());
  
  // 分块处理 Refs (Memory Fallback)
  const chunksRef = useRef<ArrayBuffer[]>([]);
  const receivedChunksCountRef = useRef<number>(0);
  const receivedSizeRef = useRef<number>(0);
  const currentFileSizeRef = useRef<number>(0);
  
  // === Streaming & Buffering Refs for Large Files ===
  const isStreamingRef = useRef<boolean>(false);
  const nativeWriterRef = useRef<FileSystemWritableFileStream | null>(null);
  const streamSaverWriterRef = useRef<WritableStreamDefaultWriter | null>(null);
  
  // Write Queue to ensure async writes are sequential
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  
  // == WRITE BUFFER OPTIMIZATION ==
  // Accumulate small chunks in memory and write them in bulk (e.g., 50MB) to disk.
  const writeBufferRef = useRef<Uint8Array[]>([]);
  const writeBufferSizeRef = useRef<number>(0);
  const BUFFER_FLUSH_THRESHOLD = 50 * 1024 * 1024; // 50MB

  // 速度计算 Refs
  const lastSpeedUpdateRef = useRef<number>(0);
  const lastSpeedBytesRef = useRef<number>(0);

  useEffect(() => {
    if (initialCode) setCode(initialCode);
  }, [initialCode]);

  useEffect(() => {
    if (code.length === 4 && state === TransferState.IDLE) handleConnect();
  }, [code, state]);

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
      // Clean up any open streams if component unmounts
      if (nativeWriterRef.current) nativeWriterRef.current.close().catch(console.error);
      if (streamSaverWriterRef.current) streamSaverWriterRef.current.close().catch(console.error);
    };
  }, []);

  // Wake Lock Effect
  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;

    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator) {
          wakeLock = await navigator.wakeLock.request('screen');
        }
      } catch (err) {
        console.warn('Wake Lock request failed:', err);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && state === TransferState.TRANSFERRING) {
        requestWakeLock();
      }
    };

    if (state === TransferState.TRANSFERRING) {
      requestWakeLock();
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      if (wakeLock) {
        wakeLock.release().catch(() => {});
        wakeLock = null;
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [state]);

  // Dedicated loop for UI updates (Progress & Speed)
  useEffect(() => {
    let interval: number;
    if (state === TransferState.TRANSFERRING) {
        interval = window.setInterval(() => {
            if (!currentFileSizeRef.current) return;
            
            const now = Date.now();
            const received = receivedSizeRef.current;
            const total = currentFileSizeRef.current;
            
            // Progress
            const pct = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;
            setProgress(pct);
            
            // Speed (every 1000ms)
            const timeDiff = now - lastSpeedUpdateRef.current;
            const bytesDiff = received - lastSpeedBytesRef.current;
            const speed = (bytesDiff / (timeDiff / 1000)); // Bytes per sec
            
            // Prevent negative speed or weird spikes
            const safeSpeed = Math.max(0, speed);
            
            setDownloadSpeed(formatFileSize(safeSpeed) + '/s');
            
            // ETA
            if (safeSpeed > 0 && total > received) {
                const remainingBytes = total - received;
                const seconds = remainingBytes / safeSpeed;
                if (seconds > 60) setEta(`${Math.ceil(seconds / 60)} 分钟`);
                else setEta(`${Math.ceil(seconds)} 秒`);
            } else if (received >= total) {
                setEta('完成');
            } else {
                setEta('--');
            }
            
            lastSpeedUpdateRef.current = now;
            lastSpeedBytesRef.current = received;
            
        }, 1000);
    }
    return () => clearInterval(interval);
  }, [state]);

  // === BUFFER FLUSH LOGIC ===
  const flushWriteBuffer = async () => {
      if (writeBufferSizeRef.current === 0) return;

      const chunksToFlush = writeBufferRef.current;
      const totalLen = writeBufferSizeRef.current;

      // Reset Buffer immediately
      writeBufferRef.current = [];
      writeBufferSizeRef.current = 0;

      // Combine chunks
      const combined = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of chunksToFlush) {
          combined.set(chunk, offset);
          offset += chunk.byteLength;
      }

      // Write to disk
      if (nativeWriterRef.current) {
          await nativeWriterRef.current.write(combined);
      } else if (streamSaverWriterRef.current) {
          await streamSaverWriterRef.current.write(combined);
      }
  };

  const setupConnListeners = (conn: DataConnection) => {
    connRef.current = conn;

    conn.on('open', () => {
      if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
      retryCountRef.current = 0;
    });

    conn.on('data', async (data: any) => {
      // 1. 接收 Raw ArrayBuffer 数据块 (High Speed Path)
      const isBinary = data instanceof ArrayBuffer || (data.constructor && data.constructor.name === 'ArrayBuffer') || ArrayBuffer.isView(data);

      if (isBinary) {
         const chunkData = (ArrayBuffer.isView(data) ? data.buffer : data) as ArrayBuffer;
         const byteLength = chunkData.byteLength;
         
         if (byteLength > 0) {
             receivedChunksCountRef.current++;
             receivedSizeRef.current += byteLength;

             if (isStreamingRef.current) {
                 // === STREAMING MODE WITH BUFFERING ===
                 // Push to memory buffer first
                 writeBufferRef.current.push(new Uint8Array(chunkData));
                 writeBufferSizeRef.current += byteLength;

                 // Only write to disk if buffer is full
                 if (writeBufferSizeRef.current >= BUFFER_FLUSH_THRESHOLD) {
                     // Enqueue the flush to ensure order
                     writeQueueRef.current = writeQueueRef.current.then(flushWriteBuffer).catch(e => {
                         console.error("Flush Buffer Error", e);
                     });
                 }
             } else {
                 // === MEMORY BUFFER MODE (For small files/fallback) ===
                 chunksRef.current.push(chunkData);
             }
         }
         return;
      }

      // 2. Control Messages (JSON)
      const msg = data as P2PMessage;
      
      if (msg.type === 'METADATA') {
        const meta = msg.payload as FileMetadata;
        const previousMeta = metadataRef.current;
        
        // Resume Detection Logic
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
        
        if (isResumable) {
            setCanResume(true);
            if (onNotification) onNotification("发现上次未完成的传输，可继续接收", 'info');
        } else {
            setCanResume(false);
        }
      } 
      
      else if (msg.type === 'FILE_START') {
        const { fileName, fileSize, fileIndex } = msg.payload;
        
        // Check if we are resuming the SAME file
        const resumingSameFile = currentFileIndexRef.current === fileIndex && chunksRef.current.length > 0;
        
        if (!resumingSameFile) {
            // New file start
            chunksRef.current = [];
            writeBufferRef.current = [];
            writeBufferSizeRef.current = 0;
            receivedChunksCountRef.current = 0;
            receivedSizeRef.current = 0;
            
            // Handle Stream Reset for Multi-file transfer
            if (fileIndex > 0) {
                 // Close previous if exists
                 await writeQueueRef.current; // Wait for pending writes
                 if (nativeWriterRef.current) {
                     await nativeWriterRef.current.close();
                     nativeWriterRef.current = null;
                     isStreamingRef.current = false; // Fallback to memory for file > 0 if native was used (native requires gesture)
                 }
                 if (streamSaverWriterRef.current) {
                     await streamSaverWriterRef.current.close();
                     streamSaverWriterRef.current = null;
                     
                     // Start new StreamSaver stream for next file automatically
                     if (streamSaver) {
                         try {
                             const fileStream = streamSaver.createWriteStream(fileName, { size: fileSize });
                             streamSaverWriterRef.current = fileStream.getWriter();
                             isStreamingRef.current = true;
                         } catch(e) {
                             isStreamingRef.current = false;
                         }
                     }
                 }
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
         // If streaming, ensure all buffer is flushed and writes are done
         if (isStreamingRef.current) {
             // Chain final flush
             writeQueueRef.current = writeQueueRef.current.then(async () => {
                 await flushWriteBuffer(); // Flush remainder
                 
                 // Close streams
                 if (nativeWriterRef.current) {
                     await nativeWriterRef.current.close();
                     nativeWriterRef.current = null;
                 }
                 if (streamSaverWriterRef.current) {
                     await streamSaverWriterRef.current.close();
                     streamSaverWriterRef.current = null;
                 }
                 
                 // Mark completion safely inside the queue
                 completedFileIndicesRef.current.add(currentFileIndexRef.current);
                 if (onNotification) onNotification(`文件 ${currentFileName} 已保存`, 'success');

             }).catch(e => console.error("Completion Error", e));
             
             // Wait for queue to finish before proceeding mentally
             await writeQueueRef.current;
         } else {
             // Save from memory
             saveCurrentFile(); 
         }
      } 
      
      else if (msg.type === 'ALL_FILES_COMPLETE') {
         // Wait for any pending write operations
         await writeQueueRef.current;
         setState(TransferState.COMPLETED);
         if (onNotification) onNotification("所有文件接收完毕", 'success');
         resetStateForNewTransfer();
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
       if (state !== TransferState.COMPLETED && state !== TransferState.ERROR && state !== TransferState.IDLE) {
           console.log("Connection lost.");
       }
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
      isStreamingRef.current = false;
      nativeWriterRef.current = null;
      streamSaverWriterRef.current = null;
      writeQueueRef.current = Promise.resolve();
  };

  const saveCurrentFile = () => {
      // In-Memory Fallback Saver
      if (receivedSizeRef.current === 0 && currentFileSizeRef.current > 0) return;

      let finalName = `file_${Date.now()}.bin`;
      let finalType = 'application/octet-stream';

      if (metadataRef.current) {
          const index = currentFileIndexRef.current;
          if (metadataRef.current.files && metadataRef.current.files[index]) {
              const fileInfo = metadataRef.current.files[index];
              if (fileInfo.name) finalName = fileInfo.name;
              if (fileInfo.type) finalType = fileInfo.type;
          }
      }

      try {
          const blob = new Blob(chunksRef.current, { type: finalType });
          const url = URL.createObjectURL(blob);
          
          const a = document.createElement('a');
          a.href = url;
          a.download = finalName; 
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          
          setTimeout(() => URL.revokeObjectURL(url), 1000);
          
          completedFileIndicesRef.current.add(currentFileIndexRef.current);
      } catch (e) {
          console.error("保存文件失败:", e);
      }
      chunksRef.current = [];
      receivedChunksCountRef.current = 0;
      receivedSizeRef.current = 0;
  };

  const handleCancelConnecting = () => {
    if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
    if (peerRef.current) peerRef.current.destroy();
    if (connRef.current) connRef.current.close();
    setCode(prev => prev.slice(0, -1));
    setState(TransferState.IDLE);
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

    const iceConfig = await getIceConfig();
    const peer = new Peer({ debug: 1, config: iceConfig });

    peer.on('open', () => {
      const destId = `aerodrop-${code}`;
      const conn = peer.connect(destId, { reliable: true });
      setupConnListeners(conn);
    });
    
    peer.on('disconnected', () => {
        if (peer && !peer.destroyed) {
            peer.reconnect();
        }
    });

    peer.on('error', (err) => {
      if (!peerRef.current || peerRef.current.destroyed) return;
      if (err.type === 'peer-unavailable') {
        if (retryCountRef.current < 3) {
          retryCountRef.current++;
          setTimeout(async () => {
             if (peerRef.current && !peerRef.current.destroyed) {
                const destId = `aerodrop-${code}`;
                const conn = peerRef.current.connect(destId, { reliable: true });
                setupConnListeners(conn);
             }
          }, 2000);
          return;
        }
      } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
         console.warn('Network error:', err);
         return; 
      } else {
        console.error(err);
      }
    });

    peerRef.current = peer;
  };

  const acceptTransfer = async () => {
    if (connRef.current) {
      resetStateForNewTransfer();

      // === Streaming Logic Setup ===
      if (metadata && metadata.files.length > 0) {
          const file = metadata.files[0];
          const isSingleFile = metadata.files.length === 1;

          // 1. Try Native File System Access API (Preferred for Single File)
          // Requires HTTPS and User Activation (which we have here in onClick)
          if (isSingleFile && window.showSaveFilePicker) {
              try {
                  const handle = await window.showSaveFilePicker({ 
                      suggestedName: file.name 
                  });
                  const writable = await handle.createWritable();
                  nativeWriterRef.current = writable;
                  isStreamingRef.current = true;
                  if (onNotification) onNotification("已启用直接磁盘写入模式", 'success');
              } catch (err: any) {
                  // User cancelled picker, or security error
                  if (err.name !== 'AbortError') {
                      console.warn("Native Save Failed, falling back", err);
                  }
                  // If aborted or failed, proceed to try StreamSaver or Memory
              }
          }

          // 2. Try StreamSaver.js (Fallback if Native failed or not supported)
          if (!isStreamingRef.current && streamSaver) {
              try {
                 // Initialize for the first file
                 const fileStream = streamSaver.createWriteStream(file.name, { size: file.size });
                 streamSaverWriterRef.current = fileStream.getWriter();
                 isStreamingRef.current = true;
                 if (onNotification) onNotification("使用流式下载 (StreamSaver)", 'info');
              } catch (e) {
                 console.warn("StreamSaver init failed", e);
              }
          }
      }

      connRef.current.send({ type: 'ACCEPT_TRANSFER' });
      setState(TransferState.TRANSFERRING);
    }
  };

  const resumeTransfer = () => {
      if (connRef.current) {
          const currentIdx = currentFileIndexRef.current;
          const nextChunkIndex = chunksRef.current.length;

          // Resume usually implies memory mode unless we have seek capability
          isStreamingRef.current = false; 

          if (completedFileIndicesRef.current.has(currentIdx)) {
              connRef.current.send({ type: 'RESUME_REQUEST', payload: { fileIndex: currentIdx + 1, chunkIndex: 0 } });
          } else {
              connRef.current.send({ type: 'RESUME_REQUEST', payload: { fileIndex: currentIdx, chunkIndex: nextChunkIndex } });
          }
          setState(TransferState.TRANSFERRING);
      }
  };

  const reset = () => {
    // Send cancel message if active transfer
    if (state === TransferState.TRANSFERRING && connRef.current && connRef.current.open) {
        try {
            connRef.current.send({ type: 'TRANSFER_CANCELLED' });
        } catch (e) {
            console.warn("Failed to send cancel message", e);
        }
    }

    if (connectionTimeoutRef.current) clearTimeout(connectionTimeoutRef.current);
    if (peerRef.current) { peerRef.current.destroy(); peerRef.current = null; }
    
    // Cleanup Streams
    if (nativeWriterRef.current) nativeWriterRef.current.close().catch(() => {});
    if (streamSaverWriterRef.current) streamSaverWriterRef.current.close().catch(() => {});

    setMetadata(null);
    metadataRef.current = null;
    setCode('');
    setState(TransferState.IDLE);
    setErrorMsg('');
    setProgress(0);
    resetStateForNewTransfer();
    const url = new URL(window.location.href);
    if (url.searchParams.has('code')) {
      url.searchParams.delete('code');
      window.history.pushState({}, '', url);
    }
  };

  const handleRetry = () => {
      if (code.length === 4) { setState(TransferState.IDLE); } else { reset(); }
  };

  const handleDigitClick = (digit: string) => { if (code.length < 4) setCode(prev => prev + digit); };
  const handleBackspace = () => { setCode(prev => prev.slice(0, -1)); };
  const handleClear = () => { setCode(''); };
  const handlePaste = async () => {
      try {
          if (inputRef.current) inputRef.current.focus();
          const text = await navigator.clipboard.readText();
          const digits = text.replace(/[^0-9]/g, '').slice(0, 4);
          if (digits) { setCode(digits); if (onNotification) onNotification("已粘贴", 'success'); }
      } catch (err) { /* ignore */ }
  };

  const getFileIcon = (name: string, type: string) => {
      if (!name) return <FileIcon size={24} className="text-slate-400" />;
      const ext = name.split('.').pop()?.toLowerCase();
      if (type.startsWith('image/')) return <FileImage size={24} className="text-purple-500" />;
      if (type.startsWith('video/')) return <FileVideo size={24} className="text-red-500" />;
      if (type.startsWith('audio/')) return <FileAudio size={24} className="text-yellow-500" />;
      if (type.startsWith('text/') || ['js','ts','tsx','json','html','css'].includes(ext || '')) return <FileCode size={24} className="text-blue-500" />;
      if (['zip','rar','7z','tar','gz'].includes(ext || '')) return <FileArchive size={24} className="text-orange-500" />;
      return <FileIcon size={24} className="text-slate-400" />;
  };

  const primaryFile = metadata?.files?.[0];
  const isMultiFile = (metadata?.files?.length || 0) > 1;

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
                 <div key={i} className={`w-14 h-16 border-2 rounded-xl flex items-center justify-center text-3xl font-bold font-mono transition-all duration-200 ${code[i] ? 'border-brand-500 text-brand-600 dark:text-brand-400 shadow-sm bg-white dark:bg-slate-700' : 'border-slate-200 dark:border-slate-600 text-slate-300 dark:text-slate-600 bg-white dark:bg-slate-700'}`}>{code[i] || ''}</div>
               ))}
             </div>
             <input ref={inputRef} type="text" inputMode="numeric" pattern="[0-9]*" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" autoFocus autoComplete="off" />
           </div>
           <div className="grid grid-cols-3 gap-3 w-full max-w-[280px] mb-8">
             {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
               <button key={num} onClick={() => handleDigitClick(num.toString())} className="h-16 rounded-xl bg-slate-50 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-2xl font-semibold hover:bg-slate-100 dark:hover:bg-slate-600 transition-colors shadow-sm border border-slate-100 dark:border-slate-600">{num}</button>
             ))}
             <button onClick={handlePaste} className="h-16 rounded-xl bg-blue-50 dark:bg-blue-900/20 text-brand-600 dark:text-brand-400 flex items-center justify-center hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors shadow-sm border border-blue-100 dark:border-blue-900/30"><ClipboardPaste size={20} /></button>
             <button onClick={() => handleDigitClick('0')} className="h-16 rounded-xl bg-slate-50 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-2xl font-semibold hover:bg-slate-100 dark:hover:bg-slate-600 transition-colors shadow-sm border border-slate-100 dark:border-slate-600">0</button>
             <button onClick={handleBackspace} onContextMenu={(e) => { e.preventDefault(); handleClear(); }} className="h-16 rounded-xl bg-slate-50 dark:bg-slate-700 text-slate-600 dark:text-slate-400 flex items-center justify-center hover:bg-slate-100 dark:hover:bg-slate-600 transition-colors shadow-sm border border-slate-100 dark:border-slate-600"><Delete size={24} /></button>
           </div>
        </div>
      )}

      {state === TransferState.WAITING_FOR_PEER && (
         <div className="flex flex-col items-center py-10 animate-pop-in">
           <Loader2 size={40} className="animate-spin text-brand-500 mb-4" />
           <p className="text-slate-600 dark:text-slate-300 font-medium">正在连接发送方...</p>
           {retryCountRef.current > 0 && <p className="text-xs text-slate-400 mt-2">尝试连接中 ({retryCountRef.current}/3)...</p>}
           <button onClick={handleCancelConnecting} className="mt-8 px-6 py-2 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 rounded-full text-sm hover:bg-slate-50 dark:hover:bg-slate-600 hover:text-red-500 dark:hover:text-red-400 transition-colors shadow-sm active:scale-95">取消</button>
         </div>
      )}

      {(state === TransferState.PEER_CONNECTED || state === TransferState.TRANSFERRING) && metadata && (
        <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl p-6 animate-slide-up">
           <div className="flex items-start gap-4 mb-6">
              <div className="w-12 h-12 bg-white dark:bg-slate-800 rounded-lg shadow-sm border border-slate-100 dark:border-slate-700 flex items-center justify-center text-slate-500 shrink-0">
                 {isMultiFile ? (
                    <Layers size={24} className="text-brand-500" />
                 ) : (
                    primaryFile && primaryFile.preview && primaryFile.type.startsWith('image/') ? (
                      <img src={primaryFile.preview} alt="Preview" className="w-full h-full object-cover rounded-lg" />
                    ) : (
                      getFileIcon(primaryFile?.name || 'unknown', primaryFile?.type || 'application/octet-stream')
                    )
                 )}
              </div>
              <div className="flex-1">
                 <h4 className="font-bold text-slate-800 dark:text-white text-lg leading-tight mb-1 truncate" title={primaryFile?.name}>
                    {isMultiFile ? `${metadata.files.length} 个文件` : primaryFile?.name}
                 </h4>
                 <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                    <span>{formatFileSize(metadata.totalSize)}</span>
                    <span>•</span>
                    <span>{metadata.files.length} 个文件</span>
                 </div>
               </div>
           </div>

           {!isMultiFile && primaryFile?.preview && (
             <div className="mb-4 bg-white dark:bg-slate-800 p-3 rounded-lg border border-slate-200 dark:border-slate-700">
               <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300 font-bold text-sm mb-2">
                   <Eye size={16} /> <span>内容预览</span>
               </div>
               {primaryFile.type.startsWith('image/') ? (
                 <img src={primaryFile.preview} alt="Preview" className="max-h-48 rounded mx-auto border border-slate-100 dark:border-slate-700" />
               ) : (
                 <p className="text-xs text-slate-600 dark:text-slate-300 font-mono bg-slate-50 dark:bg-slate-900 p-2 rounded border border-slate-100 dark:border-slate-700 max-h-32 overflow-y-auto whitespace-pre-wrap">{primaryFile.preview}</p>
               )}
             </div>
           )}

           {isMultiFile && state === TransferState.PEER_CONNECTED && (
               <div className="mb-4 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden max-h-48 overflow-y-auto">
                   <div className="px-3 py-2 bg-slate-100 dark:bg-slate-700/50 border-b border-slate-200 dark:border-slate-700 text-xs font-semibold text-slate-500 uppercase">
                       文件列表
                   </div>
                   {metadata.files.map((f, i) => (
                       <div key={i} className="px-3 py-2 text-sm text-slate-600 dark:text-slate-300 border-b border-slate-100 dark:border-slate-700/50 last:border-0 flex justify-between">
                           <span className="truncate flex-1 mr-2">{f.name}</span>
                           <span className="text-slate-400 text-xs">
                               {completedFileIndicesRef.current.has(i) ? <span className="text-green-500">已完成</span> : formatFileSize(f.size)}
                           </span>
                       </div>
                   ))}
               </div>
           )}

           {state === TransferState.PEER_CONNECTED && (
             <div className="space-y-3">
                 {canResume ? (
                     <button onClick={resumeTransfer} className="w-full bg-brand-600 text-white font-bold py-3 rounded-lg hover:bg-brand-700 transition-all flex items-center justify-center gap-2 shadow-md">
                         <PlayCircle size={18} /> 继续下载 ({metadata.files.length - completedFileIndicesRef.current.size} 个剩余)
                     </button>
                 ) : null}
                 <button onClick={acceptTransfer} className={`w-full font-bold py-3 rounded-lg transition-all flex items-center justify-center gap-2 ${canResume ? 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600' : 'bg-slate-900 dark:bg-brand-600 text-white hover:bg-slate-800 dark:hover:bg-brand-700'}`}>
                   <Download size={18} /> {canResume ? '重新下载所有' : '确认并下载'}
                 </button>
             </div>
           )}

           {state === TransferState.TRANSFERRING && (
             <div className="space-y-3">
               <div className="flex justify-between text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                  <span className="truncate max-w-[200px]">
                      {totalFiles > 1 ? `文件 (${currentFileIndex}/${totalFiles}): ${currentFileName}` : '下载中'}
                  </span>
                  <span>{progress}%</span>
               </div>
               <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-3 overflow-hidden shadow-inner relative">
                 <div className="bg-brand-500 h-full rounded-full transition-all duration-300 relative overflow-hidden" style={{ width: `${progress}%` }}>
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

               <div className="pt-2">
                 <button onClick={reset} className="w-full py-2 bg-red-50 dark:bg-red-900/10 text-red-600 dark:text-red-400 rounded-lg text-sm hover:bg-red-100 dark:hover:bg-red-900/20 transition-colors flex items-center justify-center gap-1">
                    <X size={14} /> 取消接收
                 </button>
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
          <p className="text-slate-500 dark:text-slate-400 mt-2">
              {totalFiles > 1 ? `全部 ${totalFiles} 个文件已保存` : '文件已保存到您的设备'}
          </p>
          <div className="flex flex-col gap-3 mt-8">
            <button onClick={reset} className="px-6 py-2 bg-slate-100 text-slate-700 font-medium rounded-lg hover:bg-slate-200 transition-colors dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600">接收下一个文件</button>
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
               <button onClick={reset} className="px-6 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 font-medium shadow-sm dark:bg-slate-700 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-600">取消</button>
               <button onClick={handleRetry} className="px-6 py-2 bg-slate-200 text-slate-700 rounded-lg hover:bg-slate-300 font-medium dark:bg-slate-600 dark:text-white dark:hover:bg-slate-500">重试</button>
           </div>
        </div>
      )}
    </div>
  );
};