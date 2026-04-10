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
  expiresAt?: number; 
}

export interface FileInfo {
  name: string;
  size: number;
  type: string;
  lastModified: number;
  preview?: string; 
  fingerprint?: string; 
}

export interface FileMetadata {
  files: FileInfo[];
  totalSize: number;
  constraints?: TransferConstraints;
  protocolVersion?: number;
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
  fileName?: string; 
  hashAlgorithm?: 'crc32';
  fileHash?: string;
  hashStartOffset?: number;
  hashedBytes?: number;
}

export interface ResumePayload {
  fileIndex: number;
  byteOffset?: number;
  silent?: boolean;
  // Backward compatibility for older clients.
  chunkIndex?: number;
}

export const P2P_PROTOCOL_VERSION = 2;

export interface TransferProgressPayload {
  overallTransferredBytes: number;
  overallTotalBytes: number;
  speedBytes: number;
}

export interface RejectTransferPayload {
  reason?: string;
}

export interface TransferCancelledPayload {
  reason?: string;
}

export interface DeviceInfoPayload {
  deviceName?: string;
  sessionId?: string;
}

export interface HeartbeatPayload {
  t: number;
}

export type P2PMessageMap = {
  METADATA: FileMetadata;
  FILE_START: FileStartPayload;
  FILE_CHUNK: ChunkPayload;
  FILE_COMPLETE: FileCompletePayload;
  ALL_FILES_COMPLETE: undefined;
  ALL_FILES_RECEIVED: undefined;
  TRANSFER_PROGRESS: TransferProgressPayload;
  ACCEPT_TRANSFER: undefined;
  REJECT_TRANSFER: RejectTransferPayload;
  RESUME_REQUEST: ResumePayload;
  TRANSFER_CANCELLED: TransferCancelledPayload;
  DEVICE_INFO: DeviceInfoPayload;
  HEARTBEAT: HeartbeatPayload;
};

export type P2PMessage = {
  [K in keyof P2PMessageMap]:
    P2PMessageMap[K] extends undefined
      ? { type: K; payload?: undefined }
      : { type: K; payload: P2PMessageMap[K] }
}[keyof P2PMessageMap];

export type TypedP2PMessage<T extends keyof P2PMessageMap> =
  P2PMessageMap[T] extends undefined
    ? { type: T; payload?: undefined }
    : { type: T; payload: P2PMessageMap[T] };

export const createP2PMessage = <T extends keyof P2PMessageMap>(
  type: T,
  ...payload: P2PMessageMap[T] extends undefined ? [] : [P2PMessageMap[T]]
): TypedP2PMessage<T> => {
  if (payload.length === 0) {
    return { type } as TypedP2PMessage<T>;
  }
  return { type, payload: payload[0] } as TypedP2PMessage<T>;
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



declare global {
  interface File {
    fullPath?: string;
  }

  interface Window {
    showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
  }

  interface SaveFilePickerOptions {
    suggestedName?: string;
    types?: {
      description?: string;
      accept: Record<string, string[]>;
    }[];
    excludeAcceptAllOption?: boolean;
  }

  interface FileSystemFileHandle {
    readonly kind: 'file';
    readonly name: string;
    createWritable(options?: any): Promise<FileSystemWritableFileStream>;
    getFile(): Promise<File>;
  }

  interface FileSystemWritableFileStream extends WritableStream {
    write(data: BufferSource | Blob | string | Uint8Array): Promise<void>;
    seek(position: number): Promise<void>;
    truncate(size: number): Promise<void>;
    close(): Promise<void>;
  }

  
  interface FileSystemEntry {
    readonly isFile: boolean;
    readonly isDirectory: boolean;
    readonly name: string;
    readonly fullPath: string;
    readonly filesystem: FileSystem;
  }

  interface FileSystemFileEntry extends FileSystemEntry {
    file(successCallback: (file: File) => void, errorCallback?: (error: any) => void): void;
  }

  interface FileSystemDirectoryEntry extends FileSystemEntry {
    createReader(): FileSystemDirectoryReader;
  }

  interface FileSystemDirectoryReader {
    readEntries(successCallback: (entries: FileSystemEntry[]) => void, errorCallback?: (error: any) => void): void;
  }

  interface BeforeInstallPromptEvent extends Event {
    readonly platforms: string[];
    readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
    prompt(): Promise<void>;
  }

  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
  }

  interface Navigator {
    standalone?: boolean;
  }
}

declare module 'react' {
  interface InputHTMLAttributes<T> {
    webkitdirectory?: string;
    directory?: string;
  }
}
