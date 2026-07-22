export const NO_TURN_WARNING_MESSAGE =
  '当前服务未启用 TURN 中继，跨网络或手机流量下可能无法连接。';
export const RATE_LIMITED_CONNECTION_MESSAGE =
  '连接请求过多，请稍后再试。';

export const getReceiverPreTransferFailureMessage = (hasTurn: boolean): string => {
  if (hasTurn) {
    return '连接超时。请检查口令是否正确。';
  }

  return `${NO_TURN_WARNING_MESSAGE} 当前更像是中继不可用，而不是口令错误。`;
};

export const getReceiverDisconnectedMessage = (
  hasTurn: boolean,
  isStillWaitingForPeer: boolean
): string => {
  if (!isStillWaitingForPeer) {
    return '连接已断开';
  }

  return hasTurn
    ? '连接已断开，请检查口令是否正确后重试。'
    : `${NO_TURN_WARNING_MESSAGE} 如果发送端在手机流量或不同网络下，这通常会直接导致建连失败。`;
};
