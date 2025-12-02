
import React, { useState, useEffect, useRef, useCallback } from 'react';
import Peer, { DataConnection } from 'peerjs';
import { ChatMessage, P2PMessage } from '../types';
import { Send, Paperclip, Copy, LogOut, Users, Loader2, MessageCircle } from 'lucide-react';
import { formatFileSize, fileToBase64 } from '../services/fileUtils';

interface ChatRoomProps {
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
    { urls: 'stun:stun.framasoft.org:3478' }
  ],
  secure: true // Ensure WebRTC uses secure protocols (required for Cloudflare/HTTPS)
};

// Predefined colors for avatars
const AVATAR_COLORS = [
  'bg-red-500', 'bg-orange-500', 'bg-amber-500', 'bg-green-500', 
  'bg-emerald-500', 'bg-teal-500', 'bg-cyan-500', 'bg-sky-500', 
  'bg-blue-500', 'bg-indigo-500', 'bg-violet-500', 'bg-purple-500', 
  'bg-fuchsia-500', 'bg-pink-500', 'bg-rose-500'
];

const SESSION_KEY = 'aerodrop_chat_session';

// Custom component to render dice dots without border
const DiceAvatar: React.FC<{ value: number }> = ({ value }) => {
  const dots = [];
  // Coordinates on a 100x100 grid
  const tl = { cx: 25, cy: 25 }, tr = { cx: 75, cy: 25 };
  const cl = { cx: 25, cy: 50 }, cc = { cx: 50, cy: 50 }, cr = { cx: 75, cy: 50 };
  const bl = { cx: 25, cy: 75 }, br = { cx: 75, cy: 75 };

  switch (value) {
    case 1: dots.push(cc); break;
    case 2: dots.push(tl, br); break;
    case 3: dots.push(tl, cc, br); break;
    case 4: dots.push(tl, tr, bl, br); break;
    case 5: dots.push(tl, tr, cc, bl, br); break;
    case 6: dots.push(tl, tr, cl, cr, bl, br); break;
    default: dots.push(cc);
  }

  return (
    <svg viewBox="0 0 100 100" className="w-full h-full p-1.5" fill="currentColor">
      {dots.map((d, i) => (
        <circle key={i} cx={d.cx} cy={d.cy} r="10" />
      ))}
    </svg>
  );
};

export const ChatRoom: React.FC<ChatRoomProps> = ({ onNotification }) => {
  const [mode, setMode] = useState<'menu' | 'hosting' | 'joining' | 'chatting'>('menu');
  const [roomCode, setRoomCode] = useState('');
  const [inputCode, setInputCode] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [onlineCount, setOnlineCount] = useState(1);
  const [isHost, setIsHost] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);

  // Refs
  const peerRef = useRef<Peer | null>(null);
  const connectionsRef = useRef<DataConnection[]>([]); // For Host: list of guests. For Guest: list containing host.
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hostRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Restore session on mount
  useEffect(() => {
    const restoreSession = () => {
      try {
        const saved = localStorage.getItem(SESSION_KEY);
        if (saved) {
          const { code, host } = JSON.parse(saved);
          if (code) {
             console.log("Restoring chat session:", code, host ? "HOST" : "GUEST");
             if (host) {
                 startHosting(code, true);
             } else {
                 joinChat(code);
             }
          }
        }
      } catch (e) {
        console.error("Failed to restore session", e);
        localStorage.removeItem(SESSION_KEY);
      }
    };
    
    // Small delay to ensure network is ready on reload
    setTimeout(restoreSession, 500);
    
    return () => {
      if (hostRetryTimeoutRef.current) clearTimeout(hostRetryTimeoutRef.current);
      // We do NOT call leaveRoom() here to persist across refreshes
      // However, we must destroy the peer to prevent ID conflicts on reload
      if (peerRef.current) {
          peerRef.current.destroy();
      }
    };
  }, []);

  const generateMessageId = () => Math.random().toString(36).substring(2, 9);

  const getUserAvatar = (userId: string) => {
      if (userId === 'system') return { color: 'bg-slate-400', diceValue: 1 };
      
      let hash = 0;
      for (let i = 0; i < userId.length; i++) {
          hash = userId.charCodeAt(i) + ((hash << 5) - hash);
      }
      
      const colorIndex = Math.abs(hash) % AVATAR_COLORS.length;
      // Use a slightly different hash calc for dice to decorrelate from color
      const diceValue = (Math.abs(Math.floor(hash / 3)) % 6) + 1;

      return {
          color: AVATAR_COLORS[colorIndex],
          diceValue: diceValue
      };
  };

  const addSystemMessage = (text: string) => {
    setMessages(prev => [...prev, {
      id: generateMessageId(),
      senderId: 'system',
      type: 'text',
      content: text,
      timestamp: Date.now(),
      isSystem: true
    }]);
  };

  const leaveRoom = () => {
    // Explicitly remove session
    localStorage.removeItem(SESSION_KEY);

    connectionsRef.current.forEach(conn => conn.close());
    connectionsRef.current = [];
    if (peerRef.current) {
      peerRef.current.destroy();
      peerRef.current = null;
    }
    if (hostRetryTimeoutRef.current) clearTimeout(hostRetryTimeoutRef.current);
    
    setMessages([]);
    setMode('menu');
    setRoomCode('');
    setIsHost(false);
    setOnlineCount(1);
    setIsConnecting(false);
  };

  // --- Hosting Logic ---
  const handleCreateRoom = () => {
    // Generate 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    startHosting(code);
  };

  const startHosting = (code: string, isRestoring = false) => {
    setIsConnecting(true);
    setRoomCode(code);
    setIsHost(true);

    if (peerRef.current) peerRef.current.destroy();

    const peer = new Peer(`aerodrop-chat-${code}`, {
      config: ICE_CONFIG,
      debug: 1
    });

    peer.on('open', (id) => {
      console.log('Chat Room Ready:', id);
      setMode('chatting');
      setIsConnecting(false);
      
      // Save session
      localStorage.setItem(SESSION_KEY, JSON.stringify({ code, host: true }));
      
      if (!isRestoring) {
          addSystemMessage(`房间已创建，口令: ${code}`);
      } else {
          addSystemMessage('已恢复聊天室会话');
      }
    });

    peer.on('connection', (conn) => {
      setupConnection(conn);
    });

    peer.on('error', (err) => {
      console.error(err);
      if (err.type === 'unavailable-id') {
          if (isRestoring) {
              console.log("ID taken (likely previous session), retrying...");
              // If restoring, the ID might still be held by the server from the previous page load.
              // Retry until we get it back.
              hostRetryTimeoutRef.current = setTimeout(() => {
                  startHosting(code, true);
              }, 1500);
              return;
          }
          onNotification('创建房间失败，口令冲突，请重试', 'error');
          setIsConnecting(false);
          setMode('menu');
      } else {
          onNotification(`连接服务错误: ${err.type}`, 'error');
          setIsConnecting(false);
      }
    });

    peerRef.current = peer;
  };

  // --- Joining Logic ---
  const handleJoinRoom = () => {
    if (inputCode.length !== 6) return;
    joinChat(inputCode);
  };

  const joinChat = (code: string) => {
    setIsConnecting(true);
    setIsHost(false);
    setRoomCode(code);

    if (peerRef.current) peerRef.current.destroy();

    const peer = new Peer({
       config: ICE_CONFIG
    });

    peer.on('open', () => {
      const conn = peer.connect(`aerodrop-chat-${code}`, { reliable: true });
      setupConnection(conn);
    });

    peer.on('error', (err) => {
      console.error(err);
      onNotification('连接房间失败，请检查口令', 'error');
      setIsConnecting(false);
      setMode('menu');
      localStorage.removeItem(SESSION_KEY); // Invalid session
    });

    peerRef.current = peer;
  };

  // --- Connection Setup ---
  const setupConnection = (conn: DataConnection) => {
    conn.on('open', () => {
      connectionsRef.current.push(conn);
      setOnlineCount(prev => prev + 1);
      
      // Save session if we are guest (Host saves on open)
      if (!isHost) {
        setMode('chatting');
        setIsConnecting(false);
        localStorage.setItem(SESSION_KEY, JSON.stringify({ code: roomCode, host: false }));
        addSystemMessage('已加入聊天室');
      }
    });

    conn.on('data', (data: any) => {
      const msg = data as P2PMessage;
      
      if (msg.type === 'CHAT_MESSAGE') {
        const chatMsg = msg.payload as ChatMessage;
        
        // Add to local state
        setMessages(prev => {
            if (prev.some(m => m.id === chatMsg.id)) return prev; // Dedup
            return [...prev, chatMsg];
        });

        // If Host, relay to others
        if (isHost) {
          connectionsRef.current.forEach(c => {
             // Don't send back to sender
             if (c.peer !== conn.peer) {
                 c.send({ type: 'CHAT_MESSAGE', payload: chatMsg });
             }
          });
        }
      }
    });

    conn.on('close', () => {
      connectionsRef.current = connectionsRef.current.filter(c => c !== conn);
      setOnlineCount(prev => Math.max(1, prev - 1));
      
      if (!isHost) {
          // If we are guest and host disconnects
          // Check if we manually left (session removed) or host dropped
          if (localStorage.getItem(SESSION_KEY)) {
               // Host dropped, assume temporary disconnect or refresh
               addSystemMessage('连接中断，尝试重连...');
               // Auto retry logic
               setTimeout(() => {
                   if (localStorage.getItem(SESSION_KEY)) {
                       joinChat(roomCode);
                   }
               }, 2000);
          }
      }
    });
  };

  // --- Sending Messages ---
  const broadcastMessage = (msg: ChatMessage) => {
    // Add to self
    setMessages(prev => [...prev, msg]);

    // Send to all connections
    connectionsRef.current.forEach(conn => {
      conn.send({ type: 'CHAT_MESSAGE', payload: msg });
    });
  };

  const handleSendMessage = () => {
    if (!inputText.trim()) return;

    const msg: ChatMessage = {
      id: generateMessageId(),
      senderId: peerRef.current?.id || 'me',
      type: 'text',
      content: inputText,
      timestamp: Date.now()
    };

    broadcastMessage(msg);
    setInputText('');
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Limit file size for chat to 2MB to prevent freezing
    if (file.size > 2 * 1024 * 1024) {
      onNotification('聊天室文件限制为 2MB，请使用“发送文件”功能传输大文件', 'error');
      return;
    }

    try {
      const base64 = await fileToBase64(file);
      const isImage = file.type.startsWith('image/');
      
      const msg: ChatMessage = {
        id: generateMessageId(),
        senderId: peerRef.current?.id || 'me',
        type: isImage ? 'image' : 'file',
        fileData: {
          name: file.name,
          size: file.size,
          mimeType: file.type,
          data: base64
        },
        timestamp: Date.now()
      };

      broadcastMessage(msg);
    } catch (err) {
      onNotification('文件处理失败', 'error');
    }
    
    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleCopyText = (text?: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    onNotification('已复制', 'success');
  };

  const downloadFile = (data: string, name: string, mime: string) => {
      const link = document.createElement('a');
      link.href = `data:${mime};base64,${data}`;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
  };

  // --- Render ---

  if (mode === 'menu') {
    return (
      <div className="w-full max-w-xl mx-auto p-8 bg-white dark:bg-slate-800 rounded-2xl shadow-xl border border-slate-100 dark:border-slate-700 flex flex-col items-center animate-pop-in transition-colors">
        <div className="w-20 h-20 bg-brand-50 dark:bg-slate-700 text-brand-600 dark:text-brand-400 rounded-full flex items-center justify-center mb-6">
          <MessageCircle size={40} />
        </div>
        <h2 className="text-2xl font-bold text-slate-800 dark:text-white mb-2">匿名聊天室</h2>
        <p className="text-slate-500 dark:text-slate-400 text-center mb-8">
          创建一个临时加密聊天室，或输入口令加入现有房间。<br/>
          支持文字、图片和文件，不保留任何记录。
        </p>

        <div className="w-full space-y-4">
          <button 
            onClick={handleCreateRoom}
            className="w-full bg-brand-600 text-white font-bold py-4 rounded-xl hover:bg-brand-700 transition-all shadow-lg shadow-brand-200 dark:shadow-none active:scale-[0.98] flex items-center justify-center gap-2"
          >
            {isConnecting ? <Loader2 className="animate-spin" /> : '创建新房间'}
          </button>
          
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-slate-200 dark:border-slate-600" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-white dark:bg-slate-800 px-2 text-slate-400">或者</span>
            </div>
          </div>

          <div className="flex gap-2">
             <input 
               type="text" 
               inputMode="numeric"
               placeholder="输入 6 位口令"
               maxLength={6}
               value={inputCode}
               onChange={(e) => setInputCode(e.target.value.replace(/[^0-9]/g, ''))}
               className="flex-1 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-600 rounded-xl px-4 text-center font-mono text-lg outline-none focus:border-brand-500 transition-colors text-slate-800 dark:text-white"
             />
             <button 
               onClick={handleJoinRoom}
               disabled={inputCode.length !== 6 || isConnecting}
               className="bg-slate-800 dark:bg-slate-600 text-white font-bold px-6 rounded-xl hover:bg-slate-700 dark:hover:bg-slate-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
             >
                {isConnecting ? <Loader2 className="animate-spin" /> : '加入'}
             </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-xl mx-auto bg-white dark:bg-slate-800 md:rounded-2xl shadow-xl border border-slate-100 dark:border-slate-700 overflow-hidden flex flex-col h-[calc(100dvh-180px)] md:h-[600px] animate-slide-up transition-colors">
      {/* Header */}
      <div className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 p-4 flex items-center justify-between sticky top-0 z-10 shrink-0">
         <div className="flex items-center gap-3">
             <div className="w-10 h-10 bg-brand-100 dark:bg-slate-700 text-brand-600 dark:text-brand-400 rounded-full flex items-center justify-center">
                 <Users size={20} />
             </div>
             <div>
                 <h3 className="font-bold text-slate-800 dark:text-white flex items-center gap-2">
                    {roomCode} 
                    <button onClick={() => handleCopyText(roomCode)} className="text-slate-400 hover:text-brand-500"><Copy size={12} /></button>
                 </h3>
                 <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">{onlineCount} 人在线</span>
                 </div>
             </div>
         </div>
         <button onClick={leaveRoom} className="p-2 text-slate-400 hover:text-red-500 transition-colors bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg shadow-sm">
             <LogOut size={18} />
         </button>
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto p-4 bg-[#f2f2f7] dark:bg-slate-950 transition-colors"> {/* iMessage-ish background */}
          {messages.map((msg, index) => {
              const myId = peerRef.current?.id || 'me';
              const isMe = msg.senderId === myId;
              const isSys = msg.isSystem;

              // Check if previous message was from the same sender
              const prevMsg = messages[index - 1];
              const isConsecutive = prevMsg && prevMsg.senderId === msg.senderId;

              if (isSys) {
                  return (
                      <div key={msg.id} className="flex justify-center my-2 animate-fade-in-up">
                          <span className="text-xs text-slate-400 bg-slate-200/50 dark:bg-slate-800/50 px-3 py-1 rounded-full">{msg.content}</span>
                      </div>
                  );
              }

              const { color: avatarColor, diceValue } = getUserAvatar(msg.senderId);
              const nickname = msg.senderId.slice(-4); // Use last 4 chars as nickname

              return (
                  <div key={msg.id} className={`flex w-full mb-1 animate-fade-in-up ${isMe ? 'justify-end' : 'justify-start'}`}>
                      {/* Avatar for others */}
                      {!isMe && (
                        <div className="w-8 flex-shrink-0 flex flex-col items-center mr-2 self-end">
                             {!isConsecutive ? (
                                <div className={`w-8 h-8 rounded-full ${avatarColor} flex items-center justify-center text-white shadow-sm overflow-hidden`}>
                                    <DiceAvatar value={diceValue} />
                                </div>
                             ) : <div className="w-8" />} {/* Spacer */}
                        </div>
                      )}

                      <div className={`max-w-[85%] md:max-w-[70%] flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                          {/* Nickname for others, only on first msg of group */}
                          {!isMe && !isConsecutive && (
                              <span className="text-[10px] text-slate-400 ml-1 mb-0.5">#{nickname}</span>
                          )}

                          <div 
                             className={`rounded-2xl px-4 py-2 relative group shadow-sm ${
                                 isMe 
                                 ? 'bg-brand-500 text-white rounded-br-sm' 
                                 : 'bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 rounded-bl-sm border border-slate-100 dark:border-slate-600'
                             }`}
                          >
                              {/* Content */}
                              {msg.type === 'text' && (
                                  <p 
                                    className="whitespace-pre-wrap break-words cursor-pointer active:opacity-80 leading-snug"
                                    onClick={() => handleCopyText(msg.content)}
                                    title="点击复制"
                                  >
                                      {msg.content}
                                  </p>
                              )}

                              {msg.type === 'image' && msg.fileData && (
                                  <div>
                                      <img 
                                        src={`data:${msg.fileData.mimeType};base64,${msg.fileData.data}`} 
                                        alt="Image" 
                                        className="rounded-lg max-h-48 cursor-pointer hover:opacity-90 transition-opacity"
                                        onClick={() => downloadFile(msg.fileData!.data, msg.fileData!.name, msg.fileData!.mimeType)}
                                      />
                                  </div>
                              )}

                              {msg.type === 'file' && msg.fileData && (
                                  <div 
                                    className={`flex items-center gap-3 p-1 cursor-pointer ${isMe ? 'text-white' : 'text-slate-800 dark:text-slate-100'}`}
                                    onClick={() => downloadFile(msg.fileData!.data, msg.fileData!.name, msg.fileData!.mimeType)}
                                  >
                                      <div className={`p-2 rounded-lg ${isMe ? 'bg-white/20' : 'bg-slate-100 dark:bg-slate-600'}`}>
                                          <Paperclip size={20} />
                                      </div>
                                      <div className="overflow-hidden">
                                          <p className="font-bold text-sm truncate w-32">{msg.fileData.name}</p>
                                          <p className={`text-xs ${isMe ? 'text-blue-100' : 'text-slate-500 dark:text-slate-400'}`}>{formatFileSize(msg.fileData.size)}</p>
                                      </div>
                                  </div>
                              )}

                              {/* Timestamp - Positioned at side */}
                              <span className={`text-[10px] text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap absolute bottom-1 ${
                                isMe ? 'right-full mr-2' : 'left-full ml-2'
                              }`}>
                                  {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                          </div>
                      </div>
                  </div>
              );
          })}
          <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="bg-white dark:bg-slate-900 p-3 border-t border-slate-200 dark:border-slate-700 flex items-end gap-2 shrink-0 transition-colors">
         <input 
            type="file" 
            ref={fileInputRef} 
            className="hidden" 
            onChange={handleFileUpload}
         />
         <div className="flex gap-1 pb-1">
            <button 
                onClick={() => fileInputRef.current?.click()}
                className="p-2 text-slate-400 hover:text-brand-500 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-full transition-colors"
                title="发送文件/图片"
            >
                <Paperclip size={24} />
            </button>
         </div>

         <div className="flex-1 bg-slate-100 dark:bg-slate-800 rounded-2xl px-4 py-2 border border-transparent focus-within:border-brand-300 focus-within:bg-white dark:focus-within:bg-slate-900 transition-all">
             <textarea 
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSendMessage();
                    }
                }}
                placeholder="发送消息..."
                rows={1}
                className="w-full bg-transparent border-none outline-none resize-none text-slate-800 dark:text-white max-h-32 py-1 placeholder-slate-400"
                style={{ minHeight: '24px' }}
             />
         </div>
         
         <button 
            onClick={handleSendMessage}
            disabled={!inputText.trim()}
            className={`p-3 rounded-full transition-all duration-200 ${
                inputText.trim() 
                ? 'bg-brand-600 text-white shadow-md hover:bg-brand-700 transform hover:scale-105 active:scale-95' 
                : 'bg-slate-200 dark:bg-slate-700 text-slate-400 dark:text-slate-500 cursor-not-allowed'
            }`}
         >
             <Send size={20} fill={inputText.trim() ? "currentColor" : "none"} />
         </button>
      </div>
    </div>
  );
};