type ArchiveExportInput = Blob | ReadableStream<Uint8Array>;

export interface ArchiveExportSource {
  relativePath: string;
  lastModified?: Date | number;
  open: () => Promise<ArchiveExportInput>;
}

export interface ArchiveExportEntry {
  relativePath: string;
  blob: Blob;
  lastModified?: Date | number;
}

export interface ArchiveExportRequest {
  archiveName: string;
  files: readonly ArchiveExportSource[];
}

export interface ArchiveExportResult {
  archiveName: string;
  archive: Blob;
  fileCount: number;
}

export interface ArchiveExportSession {
  exportArchive: (request: ArchiveExportRequest) => Promise<ArchiveExportResult>;
  exportZip: (entries: readonly ArchiveExportEntry[], archiveName?: string) => Promise<Blob>;
}

type ZipWriterLike = {
  add: (
    name: string,
    data: unknown,
    options?: {
      lastModDate?: Date;
      useCompressionStream?: boolean;
      zip64?: boolean;
    }
  ) => Promise<void>;
  close: () => Promise<Blob | void>;
};

type BlobWriterLike = {
  getData?: () => Promise<Blob>;
};

type ZipJsModuleLike = {
  BlobReader: new (...args: any[]) => unknown;
  BlobWriter: new (...args: any[]) => BlobWriterLike;
  ZipWriter: new (...args: any[]) => ZipWriterLike;
};

export interface ArchiveExportSessionOptions {
  loadZipModule?: () => Promise<ZipJsModuleLike> | ZipJsModuleLike;
}

const defaultArchiveName = 'received-files.zip';

const ensureArchiveName = (archiveName: string): string => {
  const trimmed = archiveName.trim().replace(/[\\/]+/g, '-');
  if (!trimmed) {
    return defaultArchiveName;
  }

  return trimmed.toLowerCase().endsWith('.zip') ? trimmed : `${trimmed}.zip`;
};

const normalizeArchiveRelativePath = (relativePath: string): string => {
  const normalized = relativePath.replace(/\\/g, '/').trim();
  if (!normalized || normalized.startsWith('/')) {
    throw new Error(`Invalid archive entry path: ${relativePath}`);
  }

  const segments = normalized
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.');

  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    throw new Error(`Invalid archive entry path: ${relativePath}`);
  }

  return segments.join('/');
};

const toZipEntryInput = (zipModule: ZipJsModuleLike, input: ArchiveExportInput): unknown => {
  if (input instanceof Blob) {
    return new zipModule.BlobReader(input);
  }

  return input;
};

const toLastModifiedDate = (lastModified?: Date | number): Date | undefined => {
  if (lastModified instanceof Date) {
    return lastModified;
  }

  if (typeof lastModified === 'number' && Number.isFinite(lastModified)) {
    return new Date(lastModified);
  }

  return undefined;
};

const loadDefaultZipModule = async (): Promise<ZipJsModuleLike> =>
  (await import('@zip.js/zip.js')) as unknown as ZipJsModuleLike;

export const createArchiveExportSession = (
  options: ArchiveExportSessionOptions = {}
): ArchiveExportSession => {
  let zipModulePromise: Promise<ZipJsModuleLike> | null = null;

  const loadZipModule = () => {
    if (!zipModulePromise) {
      zipModulePromise = Promise.resolve(
        options.loadZipModule ? options.loadZipModule() : loadDefaultZipModule()
      );
    }

    return zipModulePromise;
  };

  const exportArchive = async (request: ArchiveExportRequest): Promise<ArchiveExportResult> => {
    if (request.files.length === 0) {
      throw new Error('Cannot export an empty archive');
    }

    const zipModule = await loadZipModule();
    const archiveName = ensureArchiveName(request.archiveName);
    const blobWriter = new zipModule.BlobWriter('application/zip');
    const zipWriter = new zipModule.ZipWriter(blobWriter, {
      useCompressionStream: false,
      zip64: true,
    });

    let fileCount = 0;

    for (const file of request.files) {
      const entryName = normalizeArchiveRelativePath(file.relativePath);
      const input = await file.open();
      await zipWriter.add(entryName, toZipEntryInput(zipModule, input), {
        lastModDate: toLastModifiedDate(file.lastModified),
        useCompressionStream: false,
        zip64: true,
      });
      fileCount += 1;
    }

    const closedArchive = await zipWriter.close();
    const archive = closedArchive instanceof Blob
      ? closedArchive
      : await blobWriter.getData?.();

    if (!(archive instanceof Blob)) {
      throw new Error('Archive export did not produce a blob');
    }

    return {
      archiveName,
      archive,
      fileCount,
    };
  };

  return {
    exportArchive,
    exportZip: async (entries, archiveName) => {
      const result = await exportArchive({
        archiveName: archiveName ?? defaultArchiveName,
        files: entries.map((entry) => ({
          relativePath: entry.relativePath,
          lastModified: entry.lastModified,
          open: async () => entry.blob,
        })),
      });

      return result.archive;
    },
  };
};
