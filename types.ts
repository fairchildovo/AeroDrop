
export enum TransferState {
  IDLE = 'IDLE',
  CONFIGURING = 'CONFIGURING',
  GENERATING_CODE = 'GENERATING_CODE',
  WAITING_FOR_PEER = 'WAITING_FOR_PEER',
  PEER_CONNECTED = 'PEER_CONNECTED',
  TRANSFERRING = 'TRANSFERRING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR',
}

export interface TransferConstraints {
  expiresAt?: number; // Timestamp
}

export interface FileInfo {
  name: string;
  size: number;
  type: string;
  lastModified: number;
  preview?: string; // Base64 thumbnail or text snippet
}

export interface FileMetadata {
  files: FileInfo[];
  totalSize: number;
  constraints?: TransferConstraints;
}

export interface ChunkPayload {
  data: ArrayBuffer;
  index: number;
  total: number;
  fileIndex: number;
}

export interface FileStartPayload {
  fileIndex: number;
  fileName: string;
  fileSize: number;
  fileType: string;
}

export interface FileCompletePayload {
  fileIndex: number;
}

export interface ResumePayload {
  fileIndex: number;
  chunkIndex: number;
}

export interface ChatChunkPayload {
  messageId: string;
  index: number;
  total: number;
  data: string; // Substring of the stringified JSON
}

export interface ChatFileStartPayload {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  senderId: string;
}

export interface ChatFileChunkPayload {
  messageId: string;
  data: ArrayBuffer; // Raw binary data
  index: number;
  total: number;
}

export interface P2PMessage {
  type: 'METADATA' | 'FILE_START' | 'FILE_CHUNK' | 'FILE_COMPLETE' | 'ALL_FILES_COMPLETE' | 'ACCEPT_TRANSFER' | 'REJECT_TRANSFER' | 'RESUME_REQUEST' | 'CHAT_MESSAGE' | 'CHAT_JOIN' | 'CHAT_LEAVE' | 'CHAT_MESSAGE_CHUNK' | 'TRANSFER_CANCELLED' | 'CHAT_FILE_START' | 'CHAT_FILE_CHUNK';
  payload?: any;
}

export interface AeroFile {
  file: File;
  metadata: FileMetadata;
}

export interface AppNotification {
  id: string;
  message: string;
  type: 'success' | 'info' | 'error';
  timestamp: number;
}

export interface User {
  id: string;
  email: string;
  name?: string;
}

// Chat Interfaces
export interface ChatMessage {
  id: string;
  senderId: string; // 'me' or peerId
  senderName?: string;
  type: 'text' | 'image' | 'file';
  content?: string; // Text content
  fileData?: {
    name: string;
    size: number;
    mimeType: string;
    data?: string; // Base64 (legacy/images)
    blob?: Blob;   // For large files
  };
  timestamp: number;
  isSystem?: boolean;
}