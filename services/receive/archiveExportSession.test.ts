import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createArchiveExportSession,
  type ArchiveExportSource,
} from './archiveExportSession.ts';

class FakeBlobReader {
  constructor(public readonly blob: Blob) {}
}

class FakeBlobWriter {
  blob: Blob | null = null;

  async getData() {
    if (!this.blob) {
      throw new Error('zip blob not written');
    }

    return this.blob;
  }
}

class FakeZipWriter {
  readonly entries: Array<{
    name: string;
    data: unknown;
    options?: Record<string, unknown>;
  }> = [];

  constructor(private readonly writer: FakeBlobWriter) {}

  async add(name: string, data: unknown, options?: Record<string, unknown>) {
    this.entries.push({ name, data, options });
  }

  async close() {
    this.writer.blob = new Blob([JSON.stringify(this.entries.map((entry) => entry.name))], {
      type: 'application/zip',
    });
    return this.writer.blob;
  }
}

const createSources = (): ArchiveExportSource[] => [
  {
    relativePath: 'docs/readme.txt',
    open: async () => new Blob(['hello'], { type: 'text/plain' }),
  },
  {
    relativePath: 'images/icon.svg',
    open: async () => new Blob(['<svg/>'], { type: 'image/svg+xml' }),
  },
];

test('exports multiple files into a zip archive and reports archive metadata', async () => {
  let capturedWriter: FakeZipWriter | null = null;

  const session = createArchiveExportSession({
    loadZipModule: async () => ({
      BlobReader: FakeBlobReader,
      BlobWriter: FakeBlobWriter,
      ZipWriter: class extends FakeZipWriter {
        constructor(writer: FakeBlobWriter) {
          super(writer);
          capturedWriter = this;
        }
      },
    }),
  });

  const result = await session.exportArchive({
    archiveName: 'receive-batch',
    files: createSources(),
  });

  assert.ok(capturedWriter);
  const writer = capturedWriter as FakeZipWriter;
  assert.equal(result.archiveName, 'receive-batch.zip');
  assert.equal(result.fileCount, 2);
  assert.equal(result.archive.type, 'application/zip');
  assert.deepEqual(
    writer.entries.map((entry) => entry.name),
    ['docs/readme.txt', 'images/icon.svg']
  );
});

test('exportZip preserves nested relative paths instead of flattening names', async () => {
  let capturedWriter: FakeZipWriter | null = null;

  const session = createArchiveExportSession({
    loadZipModule: async () => ({
      BlobReader: FakeBlobReader,
      BlobWriter: FakeBlobWriter,
      ZipWriter: class extends FakeZipWriter {
        constructor(writer: FakeBlobWriter) {
          super(writer);
          capturedWriter = this;
        }
      },
    }),
  });

  await session.exportZip([
    {
      relativePath: '.\\album\\spring\\shot-01.heic',
      blob: new Blob(['one']),
    },
    {
      relativePath: 'album\\spring\\shot-02.heic',
      blob: new Blob(['two']),
    },
  ]);

  assert.ok(capturedWriter);
  const writer = capturedWriter as FakeZipWriter;
  assert.deepEqual(
    writer.entries.map((entry) => entry.name),
    ['album/spring/shot-01.heic', 'album/spring/shot-02.heic']
  );
});

test('passes readable streams through without flattening into blobs first', async () => {
  let capturedWriter: FakeZipWriter | null = null;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.close();
    },
  });

  const session = createArchiveExportSession({
    loadZipModule: async () => ({
      BlobReader: FakeBlobReader,
      BlobWriter: FakeBlobWriter,
      ZipWriter: class extends FakeZipWriter {
        constructor(writer: FakeBlobWriter) {
          super(writer);
          capturedWriter = this;
        }
      },
    }),
  });

  await session.exportArchive({
    archiveName: 'streamed.zip',
    files: [
      {
        relativePath: '.\\chunks\\data.bin',
        open: async () => readable,
      },
    ],
  });

  assert.ok(capturedWriter);
  const writer = capturedWriter as FakeZipWriter;
  assert.deepEqual(writer.entries.map((entry) => entry.name), ['chunks/data.bin']);
  assert.equal(writer.entries[0]?.data, readable);
});
