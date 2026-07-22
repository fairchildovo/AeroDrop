import type { DataConnection } from '../peerRuntime';

type FlowControlConfig = {
  highWaterMark: number;
  lowWaterMark: number;
};

export const DEFAULT_SAFE_DATA_CHANNEL_MESSAGE_SIZE = 64 * 1024;

const BUFFER_DRAIN_TIMEOUT_MS = 30_000;
const BUFFER_DRAIN_POLL_INTERVAL_MS = 100;

export const resolveDataChannelChunkSize = (
  routeChunkCap: number,
  maxMessageSize?: number | null,
) => {
  const negotiatedLimit = maxMessageSize === Number.POSITIVE_INFINITY
    ? routeChunkCap
    : typeof maxMessageSize === 'number' && Number.isFinite(maxMessageSize) && maxMessageSize > 0
      ? Math.floor(maxMessageSize)
      : DEFAULT_SAFE_DATA_CHANNEL_MESSAGE_SIZE;

  return Math.max(1, Math.min(Math.floor(routeChunkCap), negotiatedLimit));
};

export const isDataChannelMessageTooLargeError = (error: unknown) => {
  if (!(error instanceof Error)) return false;
  return error.name === 'TypeError'
    || /message.{0,20}(too large|size)|maxmessagesize|sctp/i.test(error.message);
};

const isTransportUnavailable = (
  conn: DataConnection,
  dataChannel: RTCDataChannel,
  peerConnection?: RTCPeerConnection,
) => {
  const pcState = peerConnection?.connectionState;
  return (
    !conn.open ||
    dataChannel.readyState !== 'open' ||
    pcState === 'closed' ||
    pcState === 'failed'
  );
};

export const waitForDataChannelDrain = async (
  conn: DataConnection,
  dataChannel: RTCDataChannel,
  flow: FlowControlConfig,
) => {
  if (dataChannel.bufferedAmount <= flow.highWaterMark) {
    return;
  }

  dataChannel.bufferedAmountLowThreshold = flow.lowWaterMark;
  const peerConnection = conn.peerConnection;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      clearTimeout(timeoutId);
      dataChannel.removeEventListener('bufferedamountlow', onLow);
      dataChannel.removeEventListener('close', onClose);
      peerConnection?.removeEventListener('connectionstatechange', onConnectionStateChange);
    };

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const ensureDrainOrFail = () => {
      if (isTransportUnavailable(conn, dataChannel, peerConnection)) {
        finish(new Error(
          `Transport unavailable while waiting for buffer drain: dc=${dataChannel.readyState}, pc=${peerConnection?.connectionState ?? 'unknown'}`,
        ));
        return;
      }

      if (dataChannel.bufferedAmount <= flow.lowWaterMark) {
        finish();
      }
    };

    const onLow = () => ensureDrainOrFail();
    const onClose = () => finish(new Error('Data channel closed while waiting for buffer drain'));
    const onConnectionStateChange = () => ensureDrainOrFail();

    const timeoutId = setTimeout(() => {
      if (dataChannel.bufferedAmount <= flow.lowWaterMark) {
        finish();
        return;
      }

      finish(new Error(
        `Backpressure drain timeout (${BUFFER_DRAIN_TIMEOUT_MS}ms): buffered=${dataChannel.bufferedAmount}, high=${flow.highWaterMark}, low=${flow.lowWaterMark}, dc=${dataChannel.readyState}, pc=${peerConnection?.connectionState ?? 'unknown'}`,
      ));
    }, BUFFER_DRAIN_TIMEOUT_MS);

    dataChannel.addEventListener('bufferedamountlow', onLow);
    dataChannel.addEventListener('close', onClose);
    peerConnection?.addEventListener('connectionstatechange', onConnectionStateChange);
    pollTimer = setInterval(ensureDrainOrFail, BUFFER_DRAIN_POLL_INTERVAL_MS);

    ensureDrainOrFail();
  });
};
