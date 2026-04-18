export type PersistenceStrategy =
  | 'native-fs'
  | 'stream-saver'
  | 'indexeddb-buffer'
  | 'memory-blob';

export interface PersistenceStrategyInput {
  isIOS: boolean;
  isSafari: boolean;
  preferBrowserDownload?: boolean;
  supportsNativeFs: boolean;
  supportsStreamSaver: boolean;
  supportsIndexedDb: boolean;
  fileSize: number;
  indexedDbThresholdBytes: number;
}

export const decidePersistenceStrategy = ({
  isIOS,
  isSafari,
  preferBrowserDownload,
  supportsNativeFs,
  supportsStreamSaver,
  supportsIndexedDb,
  fileSize,
  indexedDbThresholdBytes,
}: PersistenceStrategyInput): PersistenceStrategy => {
  if (preferBrowserDownload) {
    if ((isIOS || isSafari) && supportsIndexedDb && fileSize >= indexedDbThresholdBytes) {
      return 'indexeddb-buffer';
    }

    return 'memory-blob';
  }

  if (!isIOS && !isSafari && supportsNativeFs) {
    return 'native-fs';
  }

  if ((isIOS || isSafari) && supportsIndexedDb && fileSize >= indexedDbThresholdBytes) {
    return 'indexeddb-buffer';
  }

  if (!isIOS && !isSafari && supportsStreamSaver) {
    return 'stream-saver';
  }

  return 'memory-blob';
};
