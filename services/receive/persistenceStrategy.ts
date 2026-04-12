export type PersistenceStrategy =
  | 'native-fs'
  | 'stream-saver'
  | 'indexeddb-buffer'
  | 'memory-blob';

export interface PersistenceStrategyInput {
  isIOS: boolean;
  isSafari: boolean;
  supportsNativeFs: boolean;
  supportsStreamSaver: boolean;
  supportsIndexedDb: boolean;
  fileSize: number;
  indexedDbThresholdBytes: number;
}

export const decidePersistenceStrategy = ({
  isIOS,
  isSafari,
  supportsNativeFs,
  supportsStreamSaver,
  supportsIndexedDb,
  fileSize,
  indexedDbThresholdBytes,
}: PersistenceStrategyInput): PersistenceStrategy => {
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
