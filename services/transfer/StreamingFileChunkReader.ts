type FileChunk = {
  chunk: Uint8Array | null;
  fileOffset: number;
  isLastChunk: boolean;
};

export class StreamingFileChunkReader {
  private currentBatch: ArrayBuffer | null = null;
  private currentBatchStartOffset: number;
  private currentBatchOffset: number;
  private nextReadOffset: number;
  private finished: boolean;

  constructor(
    private readonly file: File,
    private readonly readBufferSize: number,
    startOffset = 0,
  ) {
    const normalizedOffset = Math.max(0, Math.min(startOffset, file.size));
    this.currentBatchStartOffset = normalizedOffset;
    this.currentBatchOffset = 0;
    this.nextReadOffset = normalizedOffset;
    this.finished = normalizedOffset >= file.size;
  }

  public async readNextChunk(chunkSize: number): Promise<FileChunk> {
    if (chunkSize <= 0) {
      throw new Error('Chunk size must be greater than 0');
    }

    if (this.finished) {
      return {
        chunk: null,
        fileOffset: this.nextReadOffset,
        isLastChunk: true,
      };
    }

    if (!this.currentBatch || this.currentBatchOffset >= this.currentBatch.byteLength) {
      await this.loadNextBatch();
    }

    if (!this.currentBatch || this.currentBatch.byteLength === 0) {
      this.finished = true;
      return {
        chunk: null,
        fileOffset: this.nextReadOffset,
        isLastChunk: true,
      };
    }

    const fileOffset = this.currentBatchStartOffset + this.currentBatchOffset;
    const chunkEnd = Math.min(this.currentBatchOffset + chunkSize, this.currentBatch.byteLength);
    const chunk = new Uint8Array(
      this.currentBatch,
      this.currentBatchOffset,
      chunkEnd - this.currentBatchOffset,
    );

    this.currentBatchOffset = chunkEnd;
    this.nextReadOffset = fileOffset + chunk.byteLength;
    this.finished = this.nextReadOffset >= this.file.size;

    return {
      chunk,
      fileOffset,
      isLastChunk: this.finished,
    };
  }

  private async loadNextBatch(): Promise<void> {
    const remainingBytes = this.file.size - this.nextReadOffset;
    if (remainingBytes <= 0) {
      this.currentBatch = null;
      this.currentBatchOffset = 0;
      this.finished = true;
      return;
    }

    const batchSize = Math.min(this.readBufferSize, remainingBytes);
    const fileSlice = this.file.slice(this.nextReadOffset, this.nextReadOffset + batchSize);
    this.currentBatch = await fileSlice.arrayBuffer();
    this.currentBatchStartOffset = this.nextReadOffset;
    this.currentBatchOffset = 0;
  }
}
