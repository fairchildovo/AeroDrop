import { type ReceiveStreamingTarget } from './streamingWriter.ts';

export interface DirectorySaveSessionWritableFileStream {
  write: (data: BufferSource | Blob | string | Uint8Array) => Promise<void>;
  truncate: (size: number) => Promise<void>;
  close: () => Promise<void>;
}

export interface DirectorySaveSessionFileHandle {
  readonly kind: 'file';
  readonly name: string;
  createWritable?: (options?: unknown) => Promise<DirectorySaveSessionWritableFileStream>;
  getFile?: () => Promise<Pick<File, 'size'>>;
}

export interface DirectorySaveSessionDirectoryHandle {
  readonly kind?: 'directory';
  readonly name: string;
  getDirectoryHandle: (
    name: string,
    options?: { create?: boolean }
  ) => Promise<DirectorySaveSessionDirectoryHandle>;
  getFileHandle: (
    name: string,
    options?: { create?: boolean }
  ) => Promise<DirectorySaveSessionFileHandle>;
}

export interface DirectorySaveSessionResolvedFile {
  relativePath: string;
  pathSegments: string[];
  parentDirectoryPath: string;
  directoryHandle: DirectorySaveSessionDirectoryHandle;
  fileHandle: DirectorySaveSessionFileHandle;
}

export interface LegacyResolvedFileHandle {
  normalizedRelativePath: string;
  fileName: string;
  directoryHandle: DirectorySaveSessionDirectoryHandle;
  fileHandle: DirectorySaveSessionFileHandle;
}

export interface DirectorySaveSession {
  attachRootDirectory: (rootDirectoryHandle: DirectorySaveSessionDirectoryHandle) => void;
  getRootDirectoryName: () => string;
  resolveFile: (relativePath: string) => Promise<DirectorySaveSessionResolvedFile>;
  resolveFileHandle: (relativePath: string) => Promise<LegacyResolvedFileHandle>;
  createStreamingTarget: (relativePath: string) => Promise<ReceiveStreamingTarget>;
}

const CONTROL_CHARACTERS = /[\x00-\x1f]/;
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;

const assertRelativePathNotAbsolute = (relativePath: string) => {
  const trimmedPath = relativePath.trim();

  if (!trimmedPath) {
    throw new Error('RELATIVE_PATH_EMPTY');
  }
  if (trimmedPath.startsWith('/')) {
    throw new Error('RELATIVE_PATH_ABSOLUTE');
  }
  if (WINDOWS_ABSOLUTE_PATH.test(trimmedPath)) {
    throw new Error('RELATIVE_PATH_ABSOLUTE');
  }
};

const normalizeStrictRelativePath = (relativePath: string): string[] => {
  assertRelativePathNotAbsolute(relativePath);

  const segments = relativePath
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    throw new Error('RELATIVE_PATH_EMPTY');
  }

  for (const segment of segments) {
    if (segment === '..') {
      throw new Error('RELATIVE_PATH_TRAVERSAL');
    }
    if (segment === '.') {
      throw new Error('RELATIVE_PATH_DOT_SEGMENT');
    }
    if (CONTROL_CHARACTERS.test(segment)) {
      throw new Error('RELATIVE_PATH_INVALID_SEGMENT');
    }
  }

  return segments;
};

const sanitizeLegacyRelativePath = (relativePath: string): string[] => {
  assertRelativePathNotAbsolute(relativePath);

  const segments = relativePath
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !CONTROL_CHARACTERS.test(segment)
    );

  if (segments.length === 0) {
    throw new Error('RELATIVE_PATH_EMPTY');
  }

  return segments;
};

const createDirectoryResolver = (getRootDirectoryHandle: () => DirectorySaveSessionDirectoryHandle) => {
  const directoryCache = new Map<string, DirectorySaveSessionDirectoryHandle>();
  const fileCache = new Map<string, DirectorySaveSessionFileHandle>();

  const resetCaches = () => {
    directoryCache.clear();
    fileCache.clear();
  };

  const resolveNormalizedPath = async (
    normalizedPath: string
  ): Promise<DirectorySaveSessionResolvedFile> => {
    const rootDirectoryHandle = getRootDirectoryHandle();
    if (!directoryCache.has('')) {
      directoryCache.set('', rootDirectoryHandle);
    }

    const pathSegments = normalizedPath.split('/');
    const fileName = pathSegments[pathSegments.length - 1];
    const directorySegments = pathSegments.slice(0, -1);
    const parentDirectoryPath = directorySegments.join('/');

    let currentDirectory = rootDirectoryHandle;
    let currentDirectoryPath = '';

    for (const segment of directorySegments) {
      currentDirectoryPath = currentDirectoryPath
        ? `${currentDirectoryPath}/${segment}`
        : segment;

      const cachedDirectory = directoryCache.get(currentDirectoryPath);
      if (cachedDirectory) {
        currentDirectory = cachedDirectory;
        continue;
      }

      const nextDirectory = await currentDirectory.getDirectoryHandle(segment, {
        create: true,
      });
      directoryCache.set(currentDirectoryPath, nextDirectory);
      currentDirectory = nextDirectory;
    }

    const cachedFileHandle = fileCache.get(normalizedPath);
    const fileHandle =
      cachedFileHandle ??
      (await currentDirectory.getFileHandle(fileName, {
        create: true,
      }));

    if (!cachedFileHandle) {
      fileCache.set(normalizedPath, fileHandle);
    }

    return {
      relativePath: normalizedPath,
      pathSegments,
      parentDirectoryPath,
      directoryHandle: currentDirectory,
      fileHandle,
    };
  };

  return {
    resetCaches,
    resolveNormalizedPath,
  };
};

export const createDirectorySaveSession = (options?: {
  rootDirectoryHandle?: DirectorySaveSessionDirectoryHandle;
}): DirectorySaveSession => {
  let rootDirectoryHandle = options?.rootDirectoryHandle ?? null;

  const ensureRootDirectoryHandle = (): DirectorySaveSessionDirectoryHandle => {
    if (!rootDirectoryHandle) {
      throw new Error('DIRECTORY_SAVE_SESSION_ROOT_UNSET');
    }
    return rootDirectoryHandle;
  };

  const resolver = createDirectoryResolver(ensureRootDirectoryHandle);

  return {
    attachRootDirectory: (nextRootDirectoryHandle) => {
      rootDirectoryHandle = nextRootDirectoryHandle;
      resolver.resetCaches();
    },

    getRootDirectoryName: () => ensureRootDirectoryHandle().name,

    resolveFile: async (relativePath) => {
      const normalizedPath = normalizeStrictRelativePath(relativePath).join('/');
      return resolver.resolveNormalizedPath(normalizedPath);
    },

    resolveFileHandle: async (relativePath) => {
      const normalizedRelativePath = sanitizeLegacyRelativePath(relativePath).join('/');
      const resolved = await resolver.resolveNormalizedPath(normalizedRelativePath);

      return {
        normalizedRelativePath,
        fileName: resolved.pathSegments[resolved.pathSegments.length - 1],
        directoryHandle: resolved.directoryHandle,
        fileHandle: resolved.fileHandle,
      };
    },

    createStreamingTarget: async (relativePath) => {
      const resolved = await resolver.resolveNormalizedPath(
        normalizeStrictRelativePath(relativePath).join('/')
      );

      if (!resolved.fileHandle.createWritable) {
        throw new Error('DIRECTORY_SAVE_TARGET_UNWRITABLE');
      }

      const writable = await resolved.fileHandle.createWritable();

      return {
        kind: 'native-fs',
        write: async (chunk) => {
          await writable.write(chunk);
        },
        close: async () => {
          await writable.close();
        },
        truncate: async (size) => {
          await writable.truncate(size);
        },
        verifyCommittedBytes: async (expectedBytes) => {
          if (!resolved.fileHandle.getFile) {
            return false;
          }

          const file = await resolved.fileHandle.getFile();
          return file.size === expectedBytes;
        },
      } satisfies ReceiveStreamingTarget;
    },
  };
};
