
import React, { useState, useEffect, useRef, useCallback } from 'react';
import Peer, { DataConnection } from 'peerjs';
import JSZip from 'jszip';
import { TransferState, FileMetadata, P2PMessage, ChunkPayload } from '../types';
import { formatFileSize, generatePreview } from '../services/fileUtils';
import { Upload, AlertCircle, Settings, Clock, X, Copy, Check, KeyRound, Loader2, FileType, FileCode, FileImage, FileAudio, FileVideo, FileArchive, Package, File as FileIcon, Link as LinkIcon, Folder, Pencil, ChevronDown, ChevronUp } from 'lucide-react';

interface SenderProps {
  onNotification: (msg: string, type: 'success' | 'info' | 'error') => void;
}

// Robust ICE Server Configuration for Cross-Network Connectivity
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    { urls: 'stun:stun.framasoft.org:3478' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ],
  secure: true
};

export const Sender: React.FC<SenderProps> = ({ onNotification }) => {
  const [state, setState] = useState<TransferState>(TransferState.IDLE);
  const [file, setFile] = useState<File | null>(null);
  const [metadata, setMetadata] = useState<FileMetadata | null>(null);
  const [transferCode, setTransferCode] = useState<string>('');
  const [customCodeInput, setCustomCodeInput] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [isCompressing, setIsCompressing] = useState(false);
  
  // UI States for interactions
  const [isDragOver, setIsDragOver] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<string>('');
  
  // Folder Content Preview State
  const [folderContent, setFolderContent] = useState<{name: string, size: number}[]>([]);
  const [showFileList, setShowFileList] = useState(false);

  // Renaming State
  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState('');

  // Constraints State
  const [expiryOption, setExpiryOption] = useState<string>('1h'); // 10m, 1h, 1d, never
  const [remainingTime, setRemainingTime] = useState<string>('');

  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const peerRef = useRef<Peer | null>(null);
  const activeConnections = useRef<Set<DataConnection>>(new Set());
  const activeTransfersRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  
  // Ref to hold the current file to avoid stale closures in async PeerJS callbacks
  const fileRef = useRef<File | null>(null);

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
    return () => {
      stopSharing();
    };
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
        
        updateTimer(); // Initial call
        // Clear previous timer if exists
        if (timerRef.current) clearInterval(timerRef.current);
        // Set new timer
        timerRef.current = setInterval(updateTimer, 1000);
      } else {
        setRemainingTime('永久有效');
      }
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [state, metadata]);

  const processFile = useCallback(async (selectedFile: File) => {
    setFile(selectedFile);
    fileRef.current = selectedFile;
    setState(TransferState.CONFIGURING);
    
    // Reset editing state
    setIsEditingName(false);
    setEditedName('');

    // Generate preview
    const preview = await generatePreview(selectedFile);
    
    setMetadata({
      name: selectedFile.name,
      size: selectedFile.size,
      type: selectedFile.type,
      lastModified: selectedFile.lastModified,
      preview: preview
    });
  }, []);

  // Helper: Traverse File System Entry (for Folder Drag & Drop)
  const traverseFileTree = (item: any, path: string = ""): Promise<File[]> => {
    return new Promise((resolve, reject) => {
      if (item.isFile) {
        item.file((file: File) => {
          // Manually attach path info for zipping
          // @ts-ignore
          file.fullPath = path + file.name;
          resolve([file]);
        }, (err: any) => {
            console.warn("Failed to read file", err);
            resolve([]); // Skip failed files but continue
        });
      } else if (item.isDirectory) {
        const dirReader = item.createReader();
        const entries: any[] = [];
        
        const readEntries = () => {
          dirReader.readEntries(async (results: any[]) => {
            if (results.length === 0) {
               // Finished reading this level
               try {
                  const subPromises = entries.map(entry => 
                    traverseFileTree(entry, path + item.name + "/")
                  );
                  const filesArrays = await Promise.all(subPromises);
                  resolve(filesArrays.flat());
               } catch (err) {
                  reject(err);
               }
            } else {
               entries.push(...results);
               readEntries(); // Recursively read next batch
            }
          }, (err: any) => reject(err));
        };
        readEntries();
      }
    });
  };

  const handleDirectoryDrop = async (entry: any) => {
      setIsCompressing(true);
      try {
          // Decode entry name to handle special characters correctly
          const entryName = decodeURIComponent(entry.name);
          
          // Traverse and get all files
          const files = await traverseFileTree(entry, ""); // path starts empty, handled in recursion
          
          if (files.length === 0) {
             throw new Error("文件夹为空");
          }

          // Capture file list for preview
          const contentList = files
            .map((f: any) => ({ name: f.fullPath || f.name, size: f.size }))
            .sort((a, b) => a.name.localeCompare(b.name));
          setFolderContent(contentList);

          const zip = new JSZip();
          files.forEach((file: any) => {
             // fullPath is constructed in traverseFileTree: "RootName/SubFolder/File.txt"
             let zipPath = file.fullPath || file.webkitRelativePath || file.name;
             
             // Decode path components just in case
             zipPath = decodeURIComponent(zipPath);

             // If the path starts with the folder name, strip it to avoid bad naming inside zip
             // e.g. "38833.../file.txt" -> "file.txt"
             // The zip file itself will be named later, user can rename it.
             const rootPrefix = entry.name + '/';
             if (zipPath.startsWith(rootPrefix)) {
                 zipPath = zipPath.substring(rootPrefix.length);
             } else if (zipPath.startsWith(entryName + '/')) {
                 zipPath = zipPath.substring(entryName.length + 1);
             }

             zip.file(zipPath, file);
          });

          const content = await zip.generateAsync({type: "blob"});
          // Default name is the folder name. If it's garbage (e.g. temp ID), user can rename in UI.
          const zipName = entryName ? `${entryName}.zip` : 'folder_archive.zip';
          const zipFile = new File([content], zipName, { type: 'application/zip' });
          
          processFile(zipFile);
      } catch (err) {
          console.error("Folder processing failed", err);
          onNotification("文件夹解析失败，请重试", "error");
          setFolderContent([]);
      } finally {
          setIsCompressing(false);
      }
  };

  // Helper to zip multiple individual files (not folder structure)
  const zipMultipleFiles = async (files: File[]) => {
      setIsCompressing(true);
      try {
          // Preview list
          const contentList = files.map(f => ({ name: f.name, size: f.size }));
          setFolderContent(contentList);

          const zip = new JSZip();
          files.forEach(f => {
              zip.file(f.name, f);
          });

          const content = await zip.generateAsync({type: "blob"});
          const timestamp = Math.floor(Date.now() / 1000).toString().slice(-4);
          const zipName = `files_archive_${timestamp}.zip`;
          const zipFile = new File([content], zipName, { type: 'application/zip' });

          processFile(zipFile);
      } catch (err) {
          console.error("Multi-file zip failed", err);
          onNotification("文件打包失败", "error");
          setFolderContent([]);
      } finally {
          setIsCompressing(false);
      }
  };

  // Global Drag and Drop support
  useEffect(() => {
    if (state !== TransferState.IDLE) return;

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      setIsDragOver(true);
    };
    
    const handleDragLeave = (e: DragEvent) => {
        // Only disable if we left the window
        if (e.clientX === 0 && e.clientY === 0) {
            setIsDragOver(false);
        }
    };

    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
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

      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 1) {
            zipMultipleFiles(Array.from(files));
        } else {
            setFolderContent([]); // Clear folder content for single file drop
            processFile(files[0]);
        }
      }
    };

    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('drop', handleDrop);

    return () => {
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('drop', handleDrop);
    };
  }, [state, processFile]);

  // Local Drag handlers for visual cues
  const handleLocalDragEnter = (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(true);
  };
  
  const handleLocalDragLeave = (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    if (files.length > 1) {
        zipMultipleFiles(Array.from(files));
    } else {
        setFolderContent([]); // Clear folder content for single file select
        processFile(files[0]);
    }
    e.target.value = ''; // Reset input
  };

  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsCompressing(true);
    
    try {
        // Capture file list for preview
        const contentList = Array.from(files)
            .map((f: any) => ({ name: decodeURIComponent(f.webkitRelativePath || f.name), size: f.size }))
            .sort((a, b) => a.name.localeCompare(b.name));
        setFolderContent(contentList);

        const zip = new JSZip();
        
        // Detect root folder name safely with decoding
        let rootFolderName = 'folder_archive';
        const firstFile = files[0] as any;
        if (firstFile.webkitRelativePath) {
            // webkitRelativePath is "Root/Sub/File.txt"
            const rawPath = firstFile.webkitRelativePath;
            const parts = rawPath.split('/');
            if (parts.length > 0) {
                rootFolderName = decodeURIComponent(parts[0]);
            }
        }

        // Add all files to zip
        Array.from(files).forEach((file: any) => {
            // Use webkitRelativePath if available to maintain structure
            let path = file.webkitRelativePath || file.name;
            path = decodeURIComponent(path);
            
            // Strip root folder from internal path so zip structure is clean
            // The zip file itself is named Root.zip
            if (path.startsWith(rootFolderName + '/')) {
                path = path.substring(rootFolderName.length + 1);
            }
            
            zip.file(path, file);
        });

        const content = await zip.generateAsync({type: "blob"});
        const zipFile = new File([content], `${rootFolderName}.zip`, { type: 'application/zip' });
        
        processFile(zipFile);
    } catch (err) {
        console.error("Compression failed", err);
        onNotification("文件夹处理失败", "error");
        setFolderContent([]);
    } finally {
        setIsCompressing(false);
        e.target.value = '';
    }
  };

  const handleCustomCodeChange = (val: string) => {
      // Only allow digits, max 4
      const numeric = val.replace(/[^0-9]/g, '').slice(0, 4);
      setCustomCodeInput(numeric);
  };

  const handleSaveName = () => {
      if (!metadata || !editedName.trim()) {
          setIsEditingName(false);
          return;
      }
      const newName = editedName.trim();
      setMetadata({
          ...metadata,
          name: newName
      });
      setIsEditingName(false);
  };

  const startSharing = () => {
    if (!file || !metadata) return;

    setState(TransferState.GENERATING_CODE);
    setConnectionStatus('');

    // Calculate constraints
    let expiresAt: number | undefined;
    const now = Date.now();
    if (expiryOption === '10m') expiresAt = now + 10 * 60 * 1000;
    if (expiryOption === '1h') expiresAt = now + 60 * 60 * 1000;
    if (expiryOption === '1d') expiresAt = now + 24 * 60 * 60 * 1000;

    const finalMetadata = {
      ...metadata,
      constraints: { expiresAt }
    };
    setMetadata(finalMetadata);

    const peer = new Peer({
      debug: 1,
      config: ICE_CONFIG // Use robust ICE servers
    });

    peer.on('open', (id) => {
      let finalCode = '';
      
      if (customCodeInput && customCodeInput.length === 4) {
          finalCode = customCodeInput;
      } else {
          finalCode = Math.floor(1000 + Math.random() * 9000).toString();
      }

      const customId = `aerodrop-${finalCode}`;
      
      // If the random ID matches the auto-generated one, we might need to reconnect with custom ID
      peer.destroy();
      const customPeer = new Peer(customId, {
        debug: 1,
        config: ICE_CONFIG // Use robust ICE servers
      });
      
      setupPeerListeners(customPeer, finalCode);
    });
    
    peer.on('error', (err) => {
        // Fallback for initial connection error
        console.error("Initial Peer Error", err);
        setErrorMsg('网络初始化失败，请重试');
        setState(TransferState.ERROR);
    });
  };

  const setupPeerListeners = (peer: Peer, code: string) => {
      peerRef.current = peer;

      peer.on('open', (id) => {
          console.log('My Peer ID is: ' + id);
          setTransferCode(code);
          setState(TransferState.WAITING_FOR_PEER);
      });

      peer.on('error', (err) => {
          console.error(err);
          if (err.type === 'unavailable-id') {
              setErrorMsg('该口令已被占用，请换一个或使用随机口令。');
              setState(TransferState.CONFIGURING);
          } else {
              setErrorMsg(`连接服务错误: ${err.type}`);
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
          // Wait for open to confirm connection to avoid flash

          conn.on('open', () => {
              setConnectionStatus('已连接');
              setState(TransferState.PEER_CONNECTED);
              conn.send({ type: 'METADATA', payload: metadata });
          });

          conn.on('data', (data: any) => {
              const msg = data as P2PMessage;
              if (msg.type === 'ACCEPT_TRANSFER') {
                  // Only change state to TRANSFERRING if it's the first active one, or keep it transferring
                  setState(TransferState.TRANSFERRING);
                  sendFile(conn);
              }
          });

          conn.on('close', () => {
              activeConnections.current.delete(conn);
              // Check if any transfers are still active in the background logic (via activeTransfersRef)
              // If connection closes, we assume that transfer ended or failed.
              if (activeConnections.current.size === 0 && activeTransfersRef.current === 0) {
                  // If all connections closed and no active transfers, go back to waiting
                  setConnectionStatus('');
                  setState(TransferState.WAITING_FOR_PEER);
              }
          });
          
          conn.on('error', (err) => {
              console.error("Connection error:", err);
              activeConnections.current.delete(conn);
              if (activeConnections.current.size === 0 && activeTransfersRef.current === 0) {
                  setConnectionStatus('');
                  setState(TransferState.WAITING_FOR_PEER);
              }
          });
      });
  };

  const sendFile = async (conn: DataConnection) => {
    // Use ref to access file to avoid stale closure issues in async callback
    const currentFile = fileRef.current;
    if (!currentFile) return;

    activeTransfersRef.current += 1;

    const CHUNK_SIZE = 64 * 1024; // 64KB chunks
    const totalChunks = Math.ceil(currentFile.size / CHUNK_SIZE);
    
    let offset = 0;
    let index = 0;

    const readSlice = (start: number, end: number): Promise<ArrayBuffer> => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            const slice = currentFile.slice(start, end);
            reader.onload = () => resolve(reader.result as ArrayBuffer);
            reader.onerror = reject;
            reader.readAsArrayBuffer(slice);
        });
    };

    try {
        while (offset < currentFile.size) {
            if (!conn.open) throw new Error("Connection closed during transfer");

            const chunk = await readSlice(offset, offset + CHUNK_SIZE);
            
            const payload: ChunkPayload = {
                data: chunk,
                index: index,
                total: totalChunks
            };

            conn.send({
                type: 'FILE_CHUNK',
                payload: payload
            });

            offset += CHUNK_SIZE;
            index++;

            // Small delay to prevent flooding
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        conn.send({ type: 'FILE_COMPLETE' });
        onNotification("文件传输成功！", 'success');
        
        // Do NOT change to COMPLETED state. Stay in sharing mode.

    } catch (err) {
        console.error("Transfer failed", err);
        onNotification("传输中断", 'error');
        // Do not switch to ERROR state globally, as other transfers might be active.
    } finally {
        activeTransfersRef.current -= 1;
        // If no more active transfers, we can revert visual state from TRANSFERRING to PEER_CONNECTED
        if (activeTransfersRef.current === 0) {
            setState(TransferState.PEER_CONNECTED);
        }
    }
  };

  const stopSharing = () => {
    if (peerRef.current) {
      peerRef.current.destroy();
      peerRef.current = null;
    }
    activeConnections.current.forEach(conn => conn.close());
    activeConnections.current.clear();
    activeTransfersRef.current = 0;
    setConnectionStatus('');
    setState(TransferState.IDLE);
    setFile(null);
    setMetadata(null);
    setTransferCode('');
    setCustomCodeInput('');
    setIsEditingName(false);
    setFolderContent([]);
    fileRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
  };

  const handleCopyCode = async () => {
      if (!transferCode) return;
      try {
          await navigator.clipboard.writeText(transferCode);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
          onNotification('口令已复制', 'success');
      } catch (err) {
          onNotification('复制失败', 'error');
      }
  };

  const shareLink = `${window.location.origin}${window.location.pathname}?code=${transferCode}`;

  const handleCopyLink = async () => {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
      onNotification('链接已复制', 'success');
    } catch (err) {
      onNotification('复制失败', 'error');
    }
  };

  const getFileIcon = (name: string, type: string) => {
      const ext = name.split('.').pop()?.toLowerCase();
      
      if (type.startsWith('image/')) return <FileImage size={32} className="text-purple-500" />;
      if (type.startsWith('video/')) return <FileVideo size={32} className="text-red-500" />;
      if (type.startsWith('audio/')) return <FileAudio size={32} className="text-yellow-500" />;
      if (type.startsWith('text/') || ['js','ts','tsx','json','html','css'].includes(ext || '')) return <FileCode size={32} className="text-blue-500" />;
      if (['zip','rar','7z','tar','gz'].includes(ext || '')) return <FileArchive size={32} className="text-orange-500" />;
      if (['exe','msi','bat','sh','bin'].includes(ext || '')) return <Package size={32} className="text-slate-600 dark:text-slate-400" />;
      
      return <FileIcon size={32} className="text-slate-400" />;
  };

  if (isCompressing) {
      return (
          <div className="w-full max-w-xl mx-auto p-8 md:p-12 bg-white dark:bg-slate-800 rounded-2xl shadow-xl border border-slate-100 dark:border-slate-700 flex flex-col items-center justify-center text-center transition-colors">
              <Loader2 size={48} className="animate-spin text-brand-500 mb-6" />
              <h3 className="text-xl font-bold text-slate-800 dark:text-white">正在打包文件...</h3>
              <p className="text-slate-500 dark:text-slate-400 mt-2">如果是大文件，这可能需要一点时间</p>
          </div>
      );
  }

  return (
    <div className="w-full max-w-xl mx-auto p-4 md:p-6 bg-white dark:bg-slate-800 rounded-2xl shadow-xl border border-slate-100 dark:border-slate-700 transition-colors">
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-slate-800 dark:text-white">发送文件</h2>
        <p className="text-slate-500 dark:text-slate-400">点对点加密传输</p>
      </div>

      {state === TransferState.IDLE && (
        <div 
          onDragOver={handleLocalDragEnter}
          onDragEnter={handleLocalDragEnter}
          onDragLeave={handleLocalDragLeave}
          className={`relative border-2 border-dashed rounded-xl p-8 md:p-10 flex flex-col items-center justify-center cursor-pointer transition-all duration-300 group ${
            isDragOver 
              ? 'border-brand-500 bg-brand-50 dark:bg-slate-700 scale-[1.02] shadow-xl' 
              : 'border-slate-300 dark:border-slate-600 hover:border-brand-400 hover:bg-slate-50 dark:hover:bg-slate-800/50'
          }`}
        >
          <input 
            type="file" 
            id="file-upload" 
            className="hidden" 
            multiple
            onChange={handleFileSelect}
          />
          <input 
             type="file"
             id="folder-upload"
             className="hidden"
             // @ts-ignore
             webkitdirectory=""
             // @ts-ignore
             directory=""
             onChange={handleFolderSelect}
          />
          
          <div className={`w-16 h-16 bg-brand-50 dark:bg-slate-700 text-brand-600 dark:text-brand-400 rounded-full flex items-center justify-center mb-4 transition-transform duration-300 ${isDragOver ? 'scale-110 rotate-12' : 'group-hover:scale-110'}`}>
            <Upload size={32} className={isDragOver ? 'animate-float text-brand-600 dark:text-brand-400' : 'text-brand-500 dark:text-brand-400'} />
          </div>
          <p className={`text-lg font-medium transition-colors ${isDragOver ? 'text-brand-700 dark:text-brand-300' : 'text-slate-700 dark:text-slate-200'}`}>
            <span className="hidden md:inline">{isDragOver ? '松开以添加文件' : '点击上传或拖拽文件'}</span>
            <span className="md:hidden">点击上传文件</span>
          </p>
          <p className="text-sm text-slate-400 mt-2 mb-4">支持任意格式，可多选</p>

          <label 
             htmlFor="folder-upload" 
             className="z-10 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 px-4 py-2 rounded-full text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-brand-600 dark:hover:text-brand-400 hover:border-brand-200 transition-colors flex items-center gap-2 cursor-pointer shadow-sm active:scale-95"
             onClick={(e) => e.stopPropagation()} // Prevent triggering parent click
          >
              <Folder size={14} /> 选择文件夹
          </label>
          
          {/* Main click area for single file */}
          <label htmlFor="file-upload" className="absolute inset-0 cursor-pointer"></label>
        </div>
      )}

      {state === TransferState.CONFIGURING && file && (
         <div className="space-y-6">
            <div className="bg-slate-50 dark:bg-slate-900 p-4 rounded-xl flex items-center gap-4 border border-slate-100 dark:border-slate-800 animate-slide-up">
               <div className="w-12 h-12 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center shadow-sm shrink-0">
                   {getFileIcon(file.name, file.type)}
               </div>
               
               <div className="flex-1 min-w-0">
                  {isEditingName ? (
                    <div className="flex items-center gap-2">
                       <input 
                         type="text" 
                         value={editedName}
                         onChange={(e) => setEditedName(e.target.value)}
                         className="flex-1 p-1 px-2 text-sm border border-brand-300 rounded focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100"
                         autoFocus
                         onKeyDown={(e) => {
                             if(e.key === 'Enter') handleSaveName();
                             if(e.key === 'Escape') setIsEditingName(false);
                         }}
                       />
                       <button onClick={handleSaveName} className="p-1 text-green-600 hover:bg-green-50 rounded">
                           <Check size={16} />
                       </button>
                       <button onClick={() => setIsEditingName(false)} className="p-1 text-red-500 hover:bg-red-50 rounded">
                           <X size={16} />
                       </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 group">
                      <h4 className="font-bold text-slate-800 dark:text-white truncate" title={metadata?.name}>{metadata?.name}</h4>
                      <button 
                         onClick={() => { 
                             setEditedName(metadata?.name || ''); 
                             setIsEditingName(true); 
                         }}
                         className="text-slate-400 hover:text-brand-600 md:opacity-0 md:group-hover:opacity-100 transition-opacity"
                         title="重命名"
                      >
                         <Pencil size={14} />
                      </button>
                    </div>
                  )}
                  <p className="text-xs text-slate-500 dark:text-slate-400">{formatFileSize(file.size)}</p>
               </div>
               
               <button onClick={() => setState(TransferState.IDLE)} className="text-slate-400 hover:text-red-500 transition-colors">
                  <X size={20} />
               </button>
            </div>
            
            {/* Folder Content List */}
            {folderContent.length > 0 && (
                <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden transition-all animate-slide-up">
                    <button 
                        onClick={() => setShowFileList(!showFileList)}
                        className="w-full px-4 py-2 bg-slate-50 dark:bg-slate-900 flex items-center justify-between text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                    >
                        <span>包含 {folderContent.length} 个文件</span>
                        {showFileList ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
                    </button>
                    {showFileList && (
                        <div className="max-h-48 overflow-y-auto bg-white dark:bg-slate-800 border-t border-slate-100 dark:border-slate-700 p-1">
                            {folderContent.map((f, i) => (
                                <div key={i} className="flex justify-between items-center text-xs py-1.5 px-3 hover:bg-slate-50 dark:hover:bg-slate-700 rounded group">
                                    <span className="truncate flex-1 mr-4 text-slate-600 dark:text-slate-300 group-hover:text-slate-900 dark:group-hover:text-white" title={f.name}>
                                        {f.name}
                                    </span>
                                    <span className="text-slate-400 whitespace-nowrap font-mono">{formatFileSize(f.size)}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            <div className="space-y-4">
                <div>
                   <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2 flex items-center gap-2">
                      <Settings size={16} /> 设置分享选项
                   </label>
                   
                   <div className="grid grid-cols-2 gap-4 mb-4">
                      <div>
                         <label className="text-xs text-slate-500 dark:text-slate-400 mb-1 block">有效期</label>
                         <select 
                            value={expiryOption}
                            onChange={(e) => setExpiryOption(e.target.value)}
                            className="w-full p-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm focus:border-brand-500 outline-none transition-shadow text-slate-800 dark:text-slate-100"
                         >
                            <option value="10m">10 分钟</option>
                            <option value="1h">1 小时</option>
                            <option value="1d">1 天</option>
                            <option value="never">永久 (直到关闭页面)</option>
                         </select>
                      </div>
                      <div>
                         <label className="text-xs text-slate-500 dark:text-slate-400 mb-1 block">自定义口令 (可选)</label>
                         <input 
                            type="text"
                            inputMode="numeric"
                            placeholder="随机生成"
                            value={customCodeInput}
                            onChange={(e) => handleCustomCodeChange(e.target.value)}
                            className="w-full p-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm focus:border-brand-500 outline-none font-mono transition-shadow text-slate-800 dark:text-slate-100"
                         />
                      </div>
                   </div>
                </div>

                {errorMsg && (
                    <div className="text-red-500 text-sm flex items-center gap-2 bg-red-50 dark:bg-red-900/20 p-2 rounded animate-pop-in">
                        <AlertCircle size={14} /> {errorMsg}
                    </div>
                )}

                <button 
                  onClick={startSharing}
                  className="w-full bg-brand-600 text-white font-bold py-3.5 rounded-lg hover:bg-brand-700 transition-all shadow-lg shadow-brand-200 dark:shadow-none active:scale-[0.98]"
                >
                  创建分享链接
                </button>
            </div>
         </div>
      )}

      {state === TransferState.GENERATING_CODE && (
          <div className="py-12 flex flex-col items-center justify-center text-center animate-pop-in">
              <Loader2 size={48} className="animate-spin text-brand-500 mb-4" />
              <h3 className="text-lg font-bold text-slate-800 dark:text-white">正在注册网络节点...</h3>
              <p className="text-slate-500 dark:text-slate-400 text-sm mt-2">使用增强 STUN 配置连接中...</p>
          </div>
      )}

      {(state === TransferState.WAITING_FOR_PEER || state === TransferState.PEER_CONNECTED || state === TransferState.TRANSFERRING) && (
        <div className="text-center space-y-6 animate-pop-in">
           <div className="relative inline-block">
              <div 
                onClick={handleCopyCode}
                className={`text-4xl md:text-6xl font-mono font-bold tracking-widest px-6 md:px-8 py-4 rounded-2xl border-2 cursor-pointer transition-all duration-300 select-none flex items-center justify-center gap-4 group active:scale-95 ${
                  copied 
                  ? 'bg-green-100 border-green-300 text-green-700 dark:bg-green-900/30 dark:border-green-800 dark:text-green-400 scale-105' 
                  : 'bg-brand-50 border-brand-100 text-brand-600 hover:bg-brand-100 dark:bg-slate-900 dark:border-slate-700 dark:text-brand-400 dark:hover:bg-slate-800'
                }`}
              >
                  {transferCode.split('').map((char, i) => (
                      <span key={i}>{char}</span>
                  ))}
                  <div className={`absolute -right-8 top-1/2 -translate-y-1/2 transition-all duration-300 hidden md:block ${copied ? 'opacity-0 scale-50' : 'opacity-0 group-hover:opacity-100'}`}>
                      <Copy size={20} className="text-brand-400" />
                  </div>
              </div>
              {copied && (
                  <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 flex items-center gap-1 text-green-600 dark:text-green-400 text-sm font-medium animate-fade-in-up">
                      <Check size={14} /> 已复制
                  </div>
              )}
           </div>

           {/* Share Link Section */}
           <div className={`max-w-xs mx-auto bg-slate-50 dark:bg-slate-900 p-3 rounded-lg border transition-colors flex items-center gap-2 ${linkCopied ? 'border-green-200 bg-green-50 dark:bg-green-900/20 dark:border-green-800' : 'border-slate-200 dark:border-slate-700'}`}>
              <div className="flex-1 min-w-0">
                  <div className="text-xs text-slate-400 dark:text-slate-500 text-left mb-1">分享链接</div>
                  <div className="text-sm font-mono text-slate-600 dark:text-slate-300 truncate text-left select-all">{shareLink}</div>
              </div>
              <button 
                onClick={handleCopyLink}
                className={`p-2 rounded-md transition-all border shadow-sm active:scale-90 ${
                    linkCopied 
                    ? 'bg-green-100 text-green-600 border-green-200 dark:bg-green-900/40 dark:text-green-400 dark:border-green-800' 
                    : 'bg-white text-brand-600 border-transparent hover:border-slate-200 dark:bg-slate-800 dark:text-brand-400 dark:hover:border-slate-600'
                }`}
                title="复制链接"
              >
                  {linkCopied ? <Check size={18} /> : <LinkIcon size={18} />}
              </button>
           </div>

           <p className="text-slate-500 dark:text-slate-400">对方在“接收文件”处输入此口令</p>

           <div className="flex flex-col md:flex-row items-center justify-center gap-4 md:gap-6 text-sm text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-900 py-3 rounded-lg">
               <div className="flex items-center gap-2">
                   <Clock size={16} className="text-brand-500" />
                   <span>有效期: {remainingTime}</span>
               </div>
               <div className="hidden md:block w-px h-4 bg-slate-300 dark:bg-slate-700"></div>
               <div>
                   状态: <span className="font-bold text-brand-600 dark:text-brand-400">
                       {connectionStatus || (
                          state === TransferState.WAITING_FOR_PEER ? '等待连接...' : 
                          state === TransferState.PEER_CONNECTED ? '已连接' : 
                          state === TransferState.TRANSFERRING ? '传输中...' : ''
                       )}
                   </span>
               </div>
           </div>

           {state === TransferState.TRANSFERRING && (
               <div className="flex flex-col items-center gap-2">
                   <Loader2 size={24} className="animate-spin text-brand-500" />
                   <p className="text-slate-600 dark:text-slate-300 font-medium">正在发送文件...</p>
               </div>
           )}

           <button 
             onClick={stopSharing}
             className="w-full bg-red-50 text-red-600 font-bold py-3.5 rounded-lg hover:bg-red-100 transition-colors border border-red-100 flex items-center justify-center gap-2 active:scale-[0.98] dark:bg-red-900/20 dark:text-red-400 dark:border-red-900/30 dark:hover:bg-red-900/40"
           >
             <X size={18} /> 停止分享
           </button>
        </div>
      )}

      {state === TransferState.COMPLETED && (
          <div className="text-center py-8 animate-pop-in">
              <div className="w-20 h-20 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-6 animate-bounce dark:bg-green-900/30 dark:text-green-400">
                <Check size={40} />
              </div>
              <h3 className="text-2xl font-bold text-slate-800 dark:text-white">发送完成</h3>
              <p className="text-slate-500 dark:text-slate-400 mt-2">文件已成功传输给对方。</p>
              
              <button 
                onClick={stopSharing}
                className="mt-8 px-6 py-2 bg-slate-100 text-slate-700 font-medium rounded-lg hover:bg-slate-200 transition-colors dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
              >
                发送新文件
              </button>
          </div>
      )}

      {state === TransferState.ERROR && (
          <div className="text-center py-8 animate-pop-in">
              <div className="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4 dark:bg-red-900/30 dark:text-red-400">
                <AlertCircle size={32} />
              </div>
              <h3 className="text-lg font-bold text-slate-800 dark:text-white">发生错误</h3>
              <p className="text-slate-500 dark:text-slate-400 mt-2 mb-6">{errorMsg}</p>
              <button 
                onClick={stopSharing}
                className="px-6 py-2 bg-slate-200 text-slate-700 rounded-lg hover:bg-slate-300 font-medium transition-colors dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
              >
                返回
              </button>
          </div>
      )}
    </div>
  );
};
