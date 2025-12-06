
import React, { useState, useEffect, useRef, useCallback } from 'react';
import Peer, { DataConnection } from 'peerjs';
import { TransferState, FileMetadata, P2PMessage, ChunkPayload, FileStartPayload, FileCompletePayload, ResumePayload } from '../types';
import { formatFileSize, generatePreview } from '../services/fileUtils';
import { getIceConfig } from '../services/stunService'; 
import { Upload, AlertCircle, X, Check, Loader2, Link as LinkIcon, Folder, ChevronDown, ChevronUp } from 'lucide-react';

interface SenderProps {
  onNotification: (msg: string, type: 'success' | 'info' | 'error') => void;
}

export const Sender: React.FC<SenderProps> = ({ onNotification }) => {
  const [state, setState] = useState<TransferState>(TransferState.IDLE);
  const [fileList, setFileList] = useState<File[]>([]);
  const [metadata, setMetadata] = useState<FileMetadata | null>(null);
  const [transferCode, setTransferCode] = useState<string>('');
  const [customCodeInput, setCustomCodeInput] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');
  
  // Progress states
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [totalProgress, setTotalProgress] = useState(0); // 0-100
  const [currentSpeed, setCurrentSpeed] = useState<string>('0 KB/s');
  const [avgSpeed, setAvgSpeed] = useState<string>('0 KB/s');
  
  // UI States
  const [isDragOver, setIsDragOver] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<string>('');
  const [showFileList, setShowFileList] = useState(false);

  // Constraints State
  const [expiryOption, setExpiryOption] = useState<string>('1h');
  const [remainingTime, setRemainingTime] = useState<string>('');

  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const peerRef = useRef<Peer | null>(null);
  const activeConnections = useRef<Set<DataConnection>>(new Set());
  const isDestroyingRef = useRef(false);
  
  // To handle canceling stale loops when resuming or restarting
  const transferSessionId = useRef<number>(0);
  const activeTransfersCount = useRef<number>(0);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  
  // Ref to hold current file list for async access
  const fileListRef = useRef<File[]>([]);

  // Prevent accidental tab close when hosting
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (state === TransferState.WAITING_FOR_PEER || state === TransferState.PEER_CONNECTED || state === TransferState.TRANSFERRING) {
        e.preventDefault();
        e.returnValue = ''; 
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [state]);

  // Clean up on unmount
  useEffect(() => {
    return () => stopSharing();
  }, []);

  // Countdown timer effect
  useEffect(() => {
    if (state === TransferState.WAITING_FOR_PEER || state === TransferState.PEER_CONNECTED || state === TransferState.TRANSFERRING) {
      if (metadata?.constraints?.expiresAt) {
        const updateTimer = () => {
          const now = Date.now();
          const end = metadata.constraints!.expiresAt!;
          const diff = end - now;
          
          if (diff <= 0) {
            setRemainingTime('已过期');
            stopSharing();
            setErrorMsg('分享时间已结束。');
            setState(TransferState.ERROR);
            if (timerRef.current) clearInterval(timerRef.current);
          } else {
            const h = Math.floor(diff / (1000 * 60 * 60));
            const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const s = Math.floor((diff % (1000 * 60)) / 1000);
            setRemainingTime(`${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`);
          }
        };
        updateTimer();
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = setInterval(updateTimer, 1000);
      } else {
        setRemainingTime('永久有效');
      }
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [state, metadata]);

  const processFiles = useCallback(async (files: File[]) => {
    setFileList(files);
    fileListRef.current = files;
    setState(TransferState.CONFIGURING);
    
    // Calculate total size and generate basic metadata
    let totalSize = 0;
    const filesInfo = [];

    for (const f of files) {
        totalSize += f.size;
        let preview = undefined;
        if (files.length === 1) {
            preview = await generatePreview(f);
        }
        
        // @ts-ignore
        const name = f.fullPath || f.webkitRelativePath || f.name;

        filesInfo.push({
            name: decodeURIComponent(name),
            size: f.size,
            type: f.type,
            lastModified: f.lastModified,
            preview
        });
    }

    setMetadata({
      files: filesInfo,
      totalSize: totalSize
    });
  }, []);

  // Helper: Traverse File System Entry
  const traverseFileTree = (item: any, path: string = ""): Promise<File[]> => {
    return new Promise((resolve, reject) => {
      if (item.isFile) {
        item.file((file: any) => {
          try {
            const safeFile = new File([file], file.name, { type: file.type, lastModified: file.lastModified });
            // @ts-ignore
            safeFile.fullPath = path + file.name;
            resolve([safeFile]);
          } catch (e) {
            // @ts-ignore
            file.fullPath = path + file.name;
            resolve([file]);
          }
        }, (err: any) => resolve([]));
      } else if (item.isDirectory) {
        const dirReader = item.createReader();
        const entries: any[] = [];
        const readEntries = () => {
          dirReader.readEntries(async (results: any[]) => {
            if (results.length === 0) {
               try {
                  const subPromises = entries.map(entry => traverseFileTree(entry, path + item.name + "/"));
                  const filesArrays = await Promise.all(subPromises);
                  resolve(filesArrays.flat());
               } catch (err) { reject(err); }
            } else {
               entries.push(...results);
               readEntries();
            }
          }, (err: any) => reject(err));
        };
        readEntries();
      }
    });
  };

  const handleDirectoryDrop = async (entry: any) => {
      try {
          const files = await traverseFileTree(entry, ""); 
          if (files.length === 0) throw new Error("文件夹为空");
          processFiles(files);
      } catch (err) {
          console.error("Folder processing failed", err);
          onNotification("文件夹解析失败", "error");
      }
  };

  const handleDragEvents = useCallback((e: DragEvent) => {
      e.preventDefault();
      if (e.type === 'dragover') setIsDragOver(true);
      if (e.type === 'dragleave' && e.clientX === 0 && e.clientY === 0) setIsDragOver(false);
      if (e.type === 'drop') {
          setIsDragOver(false);
          const items = e.dataTransfer?.items;
          if (items && items.length > 0) {
              const item = items[0];
              // @ts-ignore
              const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
              if (entry && entry.isDirectory) {
                  handleDirectoryDrop(entry);
                  return;
              }
          }
          if (e.dataTransfer?.files.length) {
             const files = Array.from(e.dataTransfer.files).map((f: any) => 
                new File([f], f.name, { type: f.type, lastModified: f.lastModified })
             );
             processFiles(files);
          }
      }
  }, [processFiles]);

  useEffect(() => {
    if (state !== TransferState.IDLE) return;
    window.addEventListener('dragover', handleDragEvents);
    window.addEventListener('dragleave', handleDragEvents);
    window.addEventListener('drop', handleDragEvents);
    return () => {
      window.removeEventListener('dragover', handleDragEvents);
      window.removeEventListener('dragleave', handleDragEvents);
      window.removeEventListener('drop', handleDragEvents);
    };
  }, [state, handleDragEvents]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const safeFiles = Array.from(files).map((f: any) => new File([f], f.name, { type: f.type, lastModified: f.lastModified }));
    e.target.value = '';
    processFiles(safeFiles);
  };

  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    
    // Construct full paths based on webkitRelativePath
    const safeFiles = Array.from(files).map((f: any) => {
        const safe = new File([f], f.name, { type: f.type, lastModified: f.lastModified });
        // @ts-ignore
        safe.fullPath = f.webkitRelativePath || f.name;
        return safe;
    });

    e.target.value = '';
    processFiles(safeFiles);
  };

  const startSharing = async () => {
    if (!fileList.length || !metadata) return;

    isDestroyingRef.current = false;
    setState(TransferState.GENERATING_CODE);
    setConnectionStatus('');

    // Calculate constraints
    let expiresAt: number | undefined;
    const now = Date.now();
    if (expiryOption === '10m') expiresAt = now + 10 * 60 * 1000;
    if (expiryOption === '1h') expiresAt = now + 60 * 60 * 1000;
    if (expiryOption === '1d') expiresAt = now + 24 * 60 * 60 * 1000;

    setMetadata({ ...metadata, constraints: { expiresAt } });

    const iceConfig = await getIceConfig();
    const peer = new Peer({ debug: 1, config: iceConfig });

    peer.on('open', (id) => {
      let finalCode = customCodeInput.length === 4 ? customCodeInput : Math.floor(1000 + Math.random() * 9000).toString();
      peer.destroy(); // Recreate with custom ID
      const customPeer = new Peer(`aerodrop-${finalCode}`, { debug: 1, config: iceConfig });
      setupPeerListeners(customPeer, finalCode);
    });
    
    peer.on('error', (err) => {
        // Suppress network errors from initial peer as we destroy it anyway or retry
        if (err.type === 'network' || err.type === 'server-error') return;
        setErrorMsg('网络初始化失败，请重试');
        setState(TransferState.ERROR);
    });
  };

  const setupPeerListeners = (peer: Peer, code: string) => {
      peerRef.current = peer;
      peer.on('open', () => {
          setTransferCode(code);
          setState(TransferState.WAITING_FOR_PEER);
      });
      
      peer.on('disconnected', () => {
          console.log("Connection to signaling server lost. Reconnecting...");
          if (peer && !peer.destroyed) {
              peer.reconnect();
          }
      });

      peer.on('error', (err) => {
          if (err.type === 'unavailable-id') {
              setErrorMsg('该口令已被占用，请换一个。');
              setState(TransferState.CONFIGURING);
          } else {
              // Filter out network errors that might be resolved by reconnect
              if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
                  console.warn('Network issue detected:', err);
                  return;
              }
              setErrorMsg(`连接错误: ${err.type}`);
              setState(TransferState.ERROR);
          }
      });
      peer.on('connection', (conn) => {
          if (metadata?.constraints?.expiresAt && Date.now() > metadata.constraints.expiresAt) {
             conn.on('open', () => {
                 conn.send({ type: 'REJECT_TRANSFER', payload: { reason: '分享已过期' } });
                 setTimeout(() => conn.close(), 1000);
             });
             return;
          }
          setConnectionStatus('正在建立连接...');
          activeConnections.current.add(conn);
          conn.on('open', () => {
              setConnectionStatus('已连接');
              setState(TransferState.PEER_CONNECTED);
              // Send metadata (list of files)
              conn.send({ type: 'METADATA', payload: metadata });
          });
          conn.on('data', (data: any) => {
              const msg = data as P2PMessage;
              if (msg.type === 'ACCEPT_TRANSFER') {
                  setState(TransferState.TRANSFERRING);
                  // Start fresh
                  sendFileSequence(conn, 0, 0);
              } else if (msg.type === 'RESUME_REQUEST') {
                  const payload = msg.payload as ResumePayload;
                  onNotification(`检测到断点，正在从第 ${payload.fileIndex + 1} 个文件恢复...`, 'info');
                  setState(TransferState.TRANSFERRING);
                  // Resume from specific point
                  sendFileSequence(conn, payload.fileIndex, payload.chunkIndex);
              }
          });
          conn.on('close', () => {
              activeConnections.current.delete(conn);
              if (isDestroyingRef.current) return;

              if (activeConnections.current.size === 0 && activeTransfersCount.current === 0) {
                  setConnectionStatus('');
                  setState(TransferState.WAITING_FOR_PEER);
              }
          });
      });
  };

  const sendFileSequence = async (conn: DataConnection, startFileIndex: number = 0, startChunkIndex: number = 0) => {
    const files = fileListRef.current;
    if (!files.length) return;
    
    // Increment session ID to invalidate any previous loops
    transferSessionId.current += 1;
    const currentSessionId = transferSessionId.current;

    activeTransfersCount.current += 1;
    
    // Chunk size 64KB for granular flow control
    // Reducing chunk size helps with "stop-and-wait" smoothness at the cost of slight overhead.
    const CHUNK_SIZE = 64 * 1024; 
    
    // Backpressure limit. 
    // If we buffer too much (e.g. 16MB), the Sender loop will run way ahead of the actual network speed,
    // causing the progress bar to complete while data is still queued in memory.
    // Keeping this low (e.g. 128KB or 2 chunks) ensures the Sender loop is synchronized with the Network consumption rate.
    const MAX_BUFFERED_AMOUNT = 128 * 1024; 

    // Stats Init
    let totalBytesSent = 0;
    
    // Recalculate already sent bytes for progress bar accuracy
    for(let i = 0; i < startFileIndex; i++) {
        totalBytesSent += files[i].size;
    }
    if (startChunkIndex > 0) {
        totalBytesSent += startChunkIndex * CHUNK_SIZE;
    }

    const totalSize = metadata?.totalSize || 0;
    const startTime = Date.now();
    let lastUpdateTime = startTime;
    let bytesInLastPeriod = 0;

    try {
        let chunkStartOffset = startChunkIndex;

        for (let i = startFileIndex; i < files.length; i++) {
            // Check session validity
            if (transferSessionId.current !== currentSessionId) return;
            if (!conn.open) throw new Error("Connection closed");
            
            const file = files[i];
            setCurrentFileIndex(i);
            
            // @ts-ignore
            const fName = file.fullPath || file.webkitRelativePath || file.name;

            // 1. Notify Start of File (Send every time to sync state)
            const startPayload: FileStartPayload = {
                fileIndex: i,
                fileName: decodeURIComponent(fName),
                fileSize: file.size,
                fileType: file.type
            };
            conn.send({ type: 'FILE_START', payload: startPayload });

            // 2. Send Chunks
            const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
            let offset = chunkStartOffset * CHUNK_SIZE;
            let chunkIndex = chunkStartOffset;

            // Reset for subsequent files
            chunkStartOffset = 0; 

            while (offset < file.size) {
                if (transferSessionId.current !== currentSessionId) return;
                if (!conn.open) throw new Error("Connection closed during transfer");
                
                // Backpressure check
                // @ts-ignore
                const dataChannel = conn.dataChannel;
                if (dataChannel) {
                    while (dataChannel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
                        if (transferSessionId.current !== currentSessionId || !conn.open) return;
                        // Wait for buffer to drain. 1ms polling for tight sync.
                        await new Promise(r => setTimeout(r, 1));
                    }
                }

                const slice = file.slice(offset, offset + CHUNK_SIZE);
                const chunkData = await slice.arrayBuffer();

                const payload: ChunkPayload = {
                    data: chunkData,
                    index: chunkIndex,
                    total: totalChunks,
                    fileIndex: i
                };

                conn.send({ type: 'FILE_CHUNK', payload });

                // Update metrics
                const chunkSize = chunkData.byteLength;
                totalBytesSent += chunkSize;
                bytesInLastPeriod += chunkSize;

                const now = Date.now();
                if (now - lastUpdateTime >= 200) { 
                     const duration = (now - lastUpdateTime) / 1000;
                     if (duration > 0) {
                         const speed = bytesInLastPeriod / duration;
                         setCurrentSpeed(formatFileSize(speed) + '/s');
                     }
                     
                     const totalDuration = (now - startTime) / 1000;
                     if (totalDuration > 0) {
                         const avg = totalBytesSent / totalDuration;
                         setAvgSpeed(formatFileSize(avg) + '/s');
                     }
                     
                     if (totalSize > 0) {
                         // Math.min ensures we don't show >100% due to slight calc mismatches
                         const prog = Math.min(100, Math.floor((totalBytesSent / totalSize) * 100));
                         setTotalProgress(prog);
                     }

                     lastUpdateTime = now;
                     bytesInLastPeriod = 0;
                }

                offset += CHUNK_SIZE;
                chunkIndex++;
                
                // Allow UI to breathe periodically
                if (chunkIndex % 32 === 0) await new Promise(r => setTimeout(r, 0));
            }

            // 3. Notify End of File
            const completePayload: FileCompletePayload = { fileIndex: i };
            conn.send({ type: 'FILE_COMPLETE', payload: completePayload });
            
            await new Promise(r => setTimeout(r, 10));
        }

        // 4. All Done
        setTotalProgress(100);
        conn.send({ type: 'ALL_FILES_COMPLETE' });
        onNotification("所有文件发送完成！", 'success');

    } catch (err) {
        if (transferSessionId.current === currentSessionId) {
            console.error("Transfer failed", err);
            onNotification("传输中断", 'error');
        }
    } finally {
        if (transferSessionId.current === currentSessionId) {
            activeTransfersCount.current -= 1;
            if (activeTransfersCount.current === 0) {
                setState(TransferState.PEER_CONNECTED);
                setCurrentFileIndex(0);
            }
        }
    }
  };

  const stopSharing = () => {
    isDestroyingRef.current = true;
    transferSessionId.current += 1; // Cancel any active loops
    
    // Notify connected peers
    activeConnections.current.forEach(conn => {
        if (conn.open) {
            try {
                conn.send({ type: 'TRANSFER_CANCELLED' });
            } catch(e) { console.error(e); }
        }
    });

    // Delay destruction slightly to ensure message is sent
    setTimeout(() => {
        if (peerRef.current) { peerRef.current.destroy(); peerRef.current = null; }
        activeConnections.current.forEach(conn => conn.close());
        activeConnections.current.clear();
    }, 100);

    activeTransfersCount.current = 0;
    setConnectionStatus('');
    setState(TransferState.IDLE);
    setFileList([]);
    setMetadata(null);
    setTransferCode('');
    setCustomCodeInput('');
    setTotalProgress(0);
    setCurrentSpeed('0 KB/s');
    setAvgSpeed('0 KB/s');
    fileListRef.current = [];
    if (timerRef.current) clearInterval(timerRef.current);
  };

  const handleCopyCode = async () => {
      if (!transferCode) return;
      await navigator.clipboard.writeText(transferCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      onNotification('口令已复制', 'success');
  };

  const shareLink = `${window.location.origin}${window.location.pathname}?code=${transferCode}`;
  const handleCopyLink = async () => {
      await navigator.clipboard.writeText(shareLink);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
      onNotification('链接已复制', 'success');
  };

  return (
    <div className="w-full max-w-xl mx-auto p-4 md:p-6 bg-white dark:bg-slate-800 rounded-2xl shadow-xl border border-slate-100 dark:border-slate-700 transition-colors">
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-slate-800 dark:text-white">发送文件</h2>
        <p className="text-slate-500 dark:text-slate-400">点对点加密传输 (支持文件夹/多文件)</p>
      </div>

      {state === TransferState.IDLE && (
        <div 
          className={`relative border-2 border-dashed rounded-xl p-8 md:p-10 flex flex-col items-center justify-center cursor-pointer transition-all duration-300 group ${
            isDragOver 
              ? 'border-brand-500 bg-brand-50 dark:bg-slate-700 scale-[1.02] shadow-xl' 
              : 'border-slate-300 dark:border-slate-600 hover:border-brand-400 hover:bg-slate-50 dark:hover:bg-slate-800/50'
          }`}
        >
          <input type="file" id="file-upload" className="hidden" multiple onChange={handleFileSelect} />
          <input type="file" id="folder-upload" className="hidden" 
                 // @ts-ignore
                 webkitdirectory="" directory="" onChange={handleFolderSelect} 
          />
          
          <div className={`w-16 h-16 bg-brand-50 dark:bg-slate-700 text-brand-600 dark:text-brand-400 rounded-full flex items-center justify-center mb-4 transition-transform duration-300 ${isDragOver ? 'scale-110 rotate-12' : 'group-hover:scale-110'}`}>
            <Upload size={32} className={isDragOver ? 'animate-float text-brand-600 dark:text-brand-400' : 'text-brand-500 dark:text-brand-400'} />
          </div>
          <p className="text-lg font-medium text-slate-700 dark:text-slate-200">{isDragOver ? '松开添加' : '点击上传或拖拽'}</p>
          <p className="text-sm text-slate-400 mt-2 mb-4">支持多文件、文件夹</p>

          <label 
              htmlFor="folder-upload" 
              className="z-10 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-600 px-4 py-2 rounded-full text-sm hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-brand-600 transition-colors flex items-center gap-2 cursor-pointer shadow-sm"
              onClick={(e) => e.stopPropagation()}
          >
              <Folder size={14} /> 选择文件夹
          </label>
          <label htmlFor="file-upload" className="absolute inset-0 cursor-pointer"></label>
        </div>
      )}

      {state === TransferState.CONFIGURING && metadata && (
         <div className="space-y-6">
            <div className="bg-slate-50 dark:bg-slate-900 p-4 rounded-xl flex items-center gap-4 border border-slate-100 dark:border-slate-800 animate-slide-up">
               <div className="flex-1 min-w-0">
                  <h4 className="font-bold text-slate-800 dark:text-white">已选择 {metadata.files.length} 个文件</h4>
                  <p className="text-xs text-slate-500 dark:text-slate-400">总大小: {formatFileSize(metadata.totalSize)}</p>
               </div>
               <button onClick={stopSharing} className="text-slate-400 hover:text-red-500 transition-colors"><X size={20} /></button>
            </div>
            
            {/* File List Preview */}
            <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden animate-slide-up">
                <button onClick={() => setShowFileList(!showFileList)} className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 flex justify-between text-sm hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-slate-700 dark:text-slate-300">
                    <span>文件列表</span>
                    {showFileList ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
                {showFileList && (
                    <div className="max-h-48 overflow-y-auto bg-white dark:bg-slate-800 border-t border-slate-100 dark:border-slate-700 p-1">
                        {metadata.files.map((f, i) => (
                            <div key={i} className="flex justify-between text-xs py-1.5 px-3 hover:bg-slate-50 dark:hover:bg-slate-700 rounded">
                                <span className="truncate flex-1 mr-4 text-slate-600 dark:text-slate-300">{f.name}</span>
                                <span className="text-slate-400 font-mono">{formatFileSize(f.size)}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                    <div>
                         <label className="text-xs text-slate-500 dark:text-slate-400 mb-1 block">有效期</label>
                         <select value={expiryOption} onChange={(e) => setExpiryOption(e.target.value)} className="w-full p-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm outline-none text-slate-800 dark:text-slate-100">
                            <option value="10m">10 分钟</option>
                            <option value="1h">1 小时</option>
                            <option value="1d">1 天</option>
                            <option value="never">永久</option>
                         </select>
                    </div>
                    <div>
                         <label className="text-xs text-slate-500 dark:text-slate-400 mb-1 block">自定义口令</label>
                         <input type="text" inputMode="numeric" placeholder="随机" value={customCodeInput} onChange={(e) => setCustomCodeInput(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))} className="w-full p-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm outline-none text-slate-800 dark:text-slate-100" />
                    </div>
                </div>
                {errorMsg && <div className="text-red-500 text-sm flex items-center gap-2 bg-red-50 dark:bg-red-900/20 p-2 rounded"><AlertCircle size={14} /> {errorMsg}</div>}
                <button onClick={startSharing} className="w-full bg-brand-600 text-white font-bold py-3.5 rounded-lg hover:bg-brand-700 shadow-lg">创建分享</button>
            </div>
         </div>
      )}

      {state === TransferState.GENERATING_CODE && (
          <div className="py-12 flex flex-col items-center justify-center text-center animate-pop-in">
              <Loader2 size={48} className="animate-spin text-brand-500 mb-4" />
              <h3 className="text-lg font-bold text-slate-800 dark:text-white">正在准备传输节点...</h3>
          </div>
      )}

      {(state === TransferState.WAITING_FOR_PEER || state === TransferState.PEER_CONNECTED || state === TransferState.TRANSFERRING) && (
        <div className="text-center space-y-6 animate-pop-in">
           <div className="relative inline-block" onClick={handleCopyCode}>
              <div className={`text-4xl md:text-6xl font-mono font-bold tracking-widest px-8 py-4 rounded-2xl border-2 cursor-pointer transition-all duration-300 ${copied ? 'bg-green-100 border-green-300 text-green-700' : 'bg-brand-50 border-brand-100 text-brand-600 dark:bg-slate-900 dark:border-slate-700 dark:text-brand-400'}`}>
                  {transferCode}
              </div>
           </div>

           <div className={`max-w-xs mx-auto bg-slate-50 dark:bg-slate-900 p-3 rounded-lg border flex items-center gap-2 ${linkCopied ? 'border-green-200 bg-green-50' : 'border-slate-200 dark:border-slate-700'}`}>
              <div className="flex-1 min-w-0 text-left">
                  <div className="text-xs text-slate-400">分享链接</div>
                  <div className="text-sm font-mono text-slate-600 dark:text-slate-300 truncate select-all">{shareLink}</div>
              </div>
              <button onClick={handleCopyLink} className="p-2"><LinkIcon size={18} /></button>
           </div>

           <div className="flex justify-center gap-6 text-sm text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-900 py-3 rounded-lg">
               <span>有效期: {remainingTime}</span>
               <span>状态: <span className="font-bold text-brand-600">{connectionStatus || (state === TransferState.TRANSFERRING ? '传输中' : '等待连接')}</span></span>
           </div>

           {state === TransferState.TRANSFERRING && (
               <div className="w-full space-y-5">
                   <div className="flex flex-col items-center gap-2">
                       <Loader2 size={32} className="animate-spin text-brand-500" />
                       <div className="text-center">
                           <p className="text-lg font-bold text-slate-700 dark:text-slate-200">正在发送...</p>
                           <p className="text-sm text-slate-500 dark:text-slate-400 font-medium">
                               {currentFileIndex + 1}/{metadata?.files.length}: {fileList[currentFileIndex]?.name}
                           </p>
                       </div>
                   </div>

                   <div className="space-y-2">
                       <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400 px-1">
                           <span>总进度</span>
                           <span>{totalProgress}%</span>
                       </div>
                       <div className="w-full bg-slate-100 dark:bg-slate-700 rounded-full h-3 overflow-hidden">
                           <div 
                               className="h-full bg-brand-500 transition-all duration-300 relative" 
                               style={{ width: `${totalProgress}%` }}
                           >
                               <div className="absolute inset-0 bg-white/20 animate-[shimmer_2s_infinite]"></div>
                           </div>
                       </div>
                   </div>

                   <div className="grid grid-cols-2 gap-3">
                       <div className="bg-slate-50 dark:bg-slate-900 p-3 rounded-xl border border-slate-100 dark:border-slate-700 text-center">
                           <p className="text-[10px] text-slate-400 uppercase tracking-wider mb-0.5">实时速度</p>
                           <p className="text-brand-600 dark:text-brand-400 font-bold font-mono">{currentSpeed}</p>
                       </div>
                       <div className="bg-slate-50 dark:bg-slate-900 p-3 rounded-xl border border-slate-100 dark:border-slate-700 text-center">
                           <p className="text-[10px] text-slate-400 uppercase tracking-wider mb-0.5">平均速度</p>
                           <p className="text-blue-600 dark:text-blue-400 font-bold font-mono">{avgSpeed}</p>
                       </div>
                   </div>
               </div>
           )}

           <button onClick={stopSharing} className="w-full bg-red-50 text-red-600 font-bold py-3.5 rounded-lg hover:bg-red-100 transition-colors border border-red-100 flex items-center justify-center gap-2">
             <X size={18} /> 停止分享
           </button>
        </div>
      )}

      {state === TransferState.ERROR && (
          <div className="text-center py-8 animate-pop-in">
              <div className="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4"><AlertCircle size={32} /></div>
              <h3 className="text-lg font-bold">发生错误</h3>
              <p className="text-slate-500 mt-2 mb-6">{errorMsg}</p>
              <button onClick={stopSharing} className="px-6 py-2 bg-slate-200 rounded-lg">返回</button>
          </div>
      )}
    </div>
  );
};
