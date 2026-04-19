export interface SessionDirectoryHandleCache {
  remember: (handle: FileSystemDirectoryHandle) => void;
  clear: () => void;
  hasRememberedHandle: () => boolean;
  getRememberedHandle: () => FileSystemDirectoryHandle | null;
  getReusableHandle: () => Promise<FileSystemDirectoryHandle | null>;
}

export interface SessionDirectoryHandleCacheOptions {
  validateHandle?: (handle: FileSystemDirectoryHandle) => Promise<boolean>;
}

const defaultValidateHandle = async (handle: FileSystemDirectoryHandle) => {
  const permissionApi = handle as FileSystemDirectoryHandle & {
    queryPermission?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
  };

  if (typeof permissionApi.queryPermission === 'function') {
    const permission = await permissionApi.queryPermission({ mode: 'readwrite' });
    return permission === 'granted';
  }

  try {
    await handle.getFileHandle('.aerodrop-permission-check', { create: false });
  } catch {
    // Ignore: getFileHandle may fail if the sentinel file doesn't exist.
  }

  return true;
};

export const createSessionDirectoryHandleCache = (
  options: SessionDirectoryHandleCacheOptions = {}
): SessionDirectoryHandleCache => {
  let rememberedHandle: FileSystemDirectoryHandle | null = null;
  const validateHandle = options.validateHandle ?? defaultValidateHandle;

  return {
    remember: (handle) => {
      rememberedHandle = handle;
    },
    clear: () => {
      rememberedHandle = null;
    },
    hasRememberedHandle: () => rememberedHandle !== null,
    getRememberedHandle: () => rememberedHandle,
    getReusableHandle: async () => {
      if (!rememberedHandle) {
        return null;
      }

      const stillValid = await validateHandle(rememberedHandle);
      if (!stillValid) {
        rememberedHandle = null;
        return null;
      }

      return rememberedHandle;
    },
  };
};
