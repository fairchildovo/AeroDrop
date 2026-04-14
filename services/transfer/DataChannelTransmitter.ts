import type { DataConnection } from '../peerRuntime';

type FlowControlConfig = {
  highWaterMark: number;
  lowWaterMark: number;
};

const BUFFER_DRAIN_TIMEOUT_MS = 30_000;
const BUFFER_DRAIN_POLL_INTERVAL_MS = 100;

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
