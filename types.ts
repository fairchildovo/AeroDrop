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

export interface FileMetadata {
  name: string;
  size: number;
  type: string;
  lastModified: number;
  preview?: string; // Base64 thumbnail or text snippet
  constraints?: TransferConstraints;
}

export interface ChunkPayload {
  data: ArrayBuffer;
  index: number;
  total: number;
}

export interface P2PMessage {
  type: 'METADATA' | 'FILE_CHUNK' | 'FILE_COMPLETE' | 'ACCEPT_TRANSFER' | 'REJECT_TRANSFER';
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