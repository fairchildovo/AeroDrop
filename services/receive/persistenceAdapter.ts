export interface ReceivePersistenceAdapterOptions {
  isIOS: boolean;
  isSafari: boolean;
  isTransferActive: () => boolean;
  getReceivedSize: () => number;
  getCurrentFileSize: () => number;
  getCurrentFileIndex: () => number;
  getCurrentFileInfo: () => { name: string; type: string } | null;
  isIndexedDbBuffering: () => boolean;
  getMemoryChunks: () => ArrayBuffer[];
  readIndexedDbBlobsForFile: (fileIndex: number) => Promise<Blob[]>;
  deleteIndexedDbChunksForFile: (fileIndex: number) => Promise<void>;
  resetIndexedDbFileState: () => void;
  resetMemoryFileState: () => void;
  failTransferPersistence: (message: string) => void;
}

export interface ReceivePersistenceAdapter {
  saveCurrentFile: () => Promise<boolean>;
  reset: () => void;
}

const saveFileForIOS = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob);

  const downloadModal = document.createElement('div');
  downloadModal.id = 'ios-download-modal';
  downloadModal.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.8); z-index: 99999;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 20px;
  `;

  const contentDiv = document.createElement('div');
  contentDiv.style.cssText = 'background: white; padding: 24px; border-radius: 16px; max-width: 320px; text-align: center;';

  const title = document.createElement('h3');
  title.style.cssText = 'margin: 0 0 12px; font-size: 18px; color: #1e293b;';
  title.textContent = '文件已准备就绪';

  const fileNameP = document.createElement('p');
  fileNameP.style.cssText = 'margin: 0 0 20px; font-size: 14px; color: #64748b; word-break: break-all;';
  fileNameP.textContent = fileName;

  const downloadLink = document.createElement('a');
  downloadLink.href = url;
  downloadLink.download = fileName;
  downloadLink.style.cssText = 'display: block; background: #3b82f6; color: white; padding: 14px 24px; border-radius: 12px; text-decoration: none; font-weight: 600; font-size: 16px;';
  downloadLink.textContent = '点击保存文件';
  downloadLink.onclick = () => {
    setTimeout(() => downloadModal.remove(), 500);
    scheduleBlobUrlRevokeAfterFocus(url, { fallbackMs: 10 * 60 * 1000, focusDelayMs: 5000 });
  };

  const cancelBtn = document.createElement('button');
  cancelBtn.style.cssText = 'margin-top: 12px; background: none; border: none; color: #64748b; font-size: 14px; cursor: pointer;';
  cancelBtn.textContent = '取消';
  cancelBtn.onclick = () => {
    downloadModal.remove();
    URL.revokeObjectURL(url);
  };

  contentDiv.appendChild(title);
  contentDiv.appendChild(fileNameP);
  contentDiv.appendChild(downloadLink);
  contentDiv.appendChild(cancelBtn);
  downloadModal.appendChild(contentDiv);
  document.body.appendChild(downloadModal);
};

const scheduleBlobUrlRevokeAfterFocus = (url: string, opts?: { fallbackMs?: number; focusDelayMs?: number }) => {
  const fallbackMs = opts?.fallbackMs ?? 5 * 60 * 1000;
  const focusDelayMs = opts?.focusDelayMs ?? 4000;
  let revoked = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let focusDelayTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanupListener = () => {
    window.removeEventListener('focus', onFocus);
  };

  const revokeNow = () => {
    if (revoked) return;
    revoked = true;
    cleanupListener();
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    if (focusDelayTimer) {
      clearTimeout(focusDelayTimer);
      focusDelayTimer = null;
    }
    URL.revokeObjectURL(url);
  };

  const onFocus = () => {
    if (revoked) return;
    if (focusDelayTimer) clearTimeout(focusDelayTimer);
    focusDelayTimer = setTimeout(() => {
      revokeNow();
    }, focusDelayMs);
  };

  window.addEventListener('focus', onFocus);
  fallbackTimer = setTimeout(() => {
    revokeNow();
  }, fallbackMs);
};

export const createReceivePersistenceAdapter = (
  options: ReceivePersistenceAdapterOptions
): ReceivePersistenceAdapter => {
  const saveCurrentFile = async (): Promise<boolean> => {
    if (!options.isTransferActive()) return false;
    if (options.getReceivedSize() === 0 && options.getCurrentFileSize() > 0) return false;

    const currentFileInfo = options.getCurrentFileInfo();
    const finalName = currentFileInfo?.name || `file_${Date.now()}.bin`;
    const finalType = currentFileInfo?.type || 'application/octet-stream';

    try {
      let blob: Blob;
      if (options.isIndexedDbBuffering()) {
        const fileIndex = options.getCurrentFileIndex();
        const blobs = await options.readIndexedDbBlobsForFile(fileIndex);
        if (blobs.length === 0 && options.getCurrentFileSize() > 0) {
          options.failTransferPersistence('iOS 缓冲文件为空，请重试传输。');
          return false;
        }
        blob = new Blob(blobs, { type: finalType });
      } else {
        blob = new Blob(options.getMemoryChunks(), { type: finalType });
      }

      if (options.isIOS || options.isSafari) {
        saveFileForIOS(blob, finalName);
      } else {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = finalName;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        scheduleBlobUrlRevokeAfterFocus(url);
      }
    } catch (error) {
      console.error('Save failed:', error);
      options.failTransferPersistence('浏览器保存失败，请检查下载权限后重试。');
      return false;
    }

    if (options.isIndexedDbBuffering()) {
      try {
        await options.deleteIndexedDbChunksForFile(options.getCurrentFileIndex());
      } catch (error) {
        console.warn('IndexedDB cleanup after save failed:', error);
      }
      options.resetIndexedDbFileState();
    }

    options.resetMemoryFileState();
    return true;
  };

  return {
    saveCurrentFile,
    reset: () => {},
  };
};
