export type ReceiverWaitingStage =
  | 'fetching_ice'
  | 'connecting_signaling'
  | 'connecting_peer'
  | 'waiting_response'
  | 'reconnecting'
  | '';

export interface ReceiverWaitingStatusInput {
  stage: ReceiverWaitingStage;
  reconnectAttempt: number;
}

export interface ReceiverWaitingStatusCopy {
  title: string;
  detail: string;
  cancelLabel: string;
}

export const getReceiverWaitingStatusCopy = (
  input: ReceiverWaitingStatusInput
): ReceiverWaitingStatusCopy => {
  switch (input.stage) {
    case 'fetching_ice':
      return {
        title: '正在获取网络配置...',
        detail: '拉取当前网络可用的 STUN/TURN 路由信息',
        cancelLabel: '取消',
      };
    case 'connecting_signaling':
      return {
        title: '正在连接信令服务...',
        detail: '连接 AeroDrop 信令通道并同步可用路由信息',
        cancelLabel: '取消',
      };
    case 'connecting_peer':
      return {
        title: '正在建立点对点通道...',
        detail: '通过 WebRTC 协商直连或中继链路',
        cancelLabel: '取消',
      };
    case 'waiting_response':
      return {
        title: '正在等待发送方响应...',
        detail: '路由已建立，等待发送方确认并发送元数据',
        cancelLabel: '取消',
      };
    case 'reconnecting':
      return {
        title: '连接中断，正在尝试恢复...',
        detail: `第 ${Math.max(1, input.reconnectAttempt)} 次自动重连中，请保持此页面打开，无需重新输入口令。`,
        cancelLabel: '停止重连',
      };
    default:
      return {
        title: '正在连接发送方...',
        detail: '准备连接并等待可用路由建立',
        cancelLabel: '取消',
      };
  }
};
