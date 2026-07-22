import { FLOW_CONTROL, TRANSFER_CONFIG } from '../../constants/transfer';
import { resolveDataChannelChunkSize } from './DataChannelTransmitter';

export { isPrivateIP } from '../networkAddress';

export type ConnectionRoute = {
  isLan: boolean;
  isRelay: boolean;
  protocol: string;
};

export type ConnectionMetrics = {
  rttMs: number | null;
  lossPct: number | null;
  availableOutgoingBitrate: number | null;
};

export type AdaptiveFlowProfile = {
  chunkSize: number;
  highWaterMark: number;
  lowWaterMark: number;
  lastUpdatedAt: number;
  metrics: ConnectionMetrics;
};

export const getBaseFlowByRoute = (route: ConnectionRoute) => {
  if (route.isLan) {
    return {
      chunkSize: TRANSFER_CONFIG.CHUNK_SIZE_LAN,
      highWaterMark: FLOW_CONTROL.HIGH_WATER_MARK_LAN,
      lowWaterMark: FLOW_CONTROL.LOW_WATER_MARK_LAN,
    };
  }

  if (route.isRelay) {
    return {
      chunkSize: TRANSFER_CONFIG.CHUNK_SIZE_RELAY,
      highWaterMark: FLOW_CONTROL.HIGH_WATER_MARK_RELAY,
      lowWaterMark: FLOW_CONTROL.LOW_WATER_MARK_RELAY,
    };
  }

  return {
    chunkSize: TRANSFER_CONFIG.CHUNK_SIZE_WAN,
    highWaterMark: FLOW_CONTROL.HIGH_WATER_MARK_WAN,
    lowWaterMark: FLOW_CONTROL.LOW_WATER_MARK_WAN,
  };
};

export const deriveAdaptiveFlow = (
  route: ConnectionRoute,
  _metrics: ConnectionMetrics,
  maxMessageSize?: number | null,
) => {
  const base = getBaseFlowByRoute(route);
  return {
    chunkSize: resolveDataChannelChunkSize(base.chunkSize, maxMessageSize),
    highWaterMark: base.highWaterMark,
    lowWaterMark: base.lowWaterMark,
  };
};
