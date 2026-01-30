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
}

export interface ResumePayload {
  fileIndex: number;
  chunkIndex: number;
}

export interface P2PMessage {
  type: 'METADATA' | 'FILE_START' | 'FILE_CHUNK' | 'FILE_COMPLETE' | 'ALL_FILES_COMPLETE' | 'ACCEPT_TRANSFER' | 'REJECT_TRANSFER' | 'RESUME_REQUEST' | 'TRANSFER_CANCELLED';
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
}
