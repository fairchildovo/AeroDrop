import {
  createP2PMessage,
  type NormalizedFileRequest,
  type NormalizedTransferMessage,
  type P2PMessage,
  type ResumePayload,
} from '../types';

const DEFAULT_CHUNK_SIZE = 256 * 1024;

export const normalizeFileRequest = (
  payload: Partial<ResumePayload> | undefined,
  chunkSize = DEFAULT_CHUNK_SIZE,
): NormalizedFileRequest => {
  const legacyChunkIndex = typeof payload?.chunkIndex === 'number' ? Math.max(0, payload.chunkIndex) : 0;
  const byteOffset = typeof payload?.byteOffset === 'number'
    ? Math.max(0, payload.byteOffset)
    : legacyChunkIndex * chunkSize;

  return {
    fileIndex: typeof payload?.fileIndex === 'number' ? Math.max(0, payload.fileIndex) : 0,
    byteOffset,
    silent: payload?.silent === true,
  };
};

export const normalizeTransferMessage = (
  message: P2PMessage,
  chunkSize = DEFAULT_CHUNK_SIZE,
): NormalizedTransferMessage => {
  if (message.type === 'RESUME_REQUEST') {
    return {
      type: 'FILE_REQUEST',
      payload: normalizeFileRequest(message.payload, chunkSize),
    };
  }

  return message;
};

export const createResumeRequestMessage = (request: NormalizedFileRequest) =>
  createP2PMessage('RESUME_REQUEST', {
    fileIndex: request.fileIndex,
    byteOffset: request.byteOffset,
    silent: request.silent,
  });
