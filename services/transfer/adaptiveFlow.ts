import { FLOW_CONTROL, TRANSFER_CONFIG } from '../../constants/transfer';

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

const toStep = (value: number, step = 16 * 1024) => {
  return Math.max(step, Math.round(value / step) * step);
};

export const isPrivateIP = (ip: string) => {
  if (!ip) return false;
  const cleanIp = ip.replace(/^\[|\](:[0-9]+)?$/g, '').split(':')[0];

  if (cleanIp === '127.0.0.1' || cleanIp === '::1' || cleanIp.toLowerCase() === 'localhost') return true;
  if (cleanIp.toLowerCase().startsWith('fe80:')) return true;

  const parts = cleanIp.split('.');
  if (parts.length === 4) {
    const p0 = parseInt(parts[0], 10);
    const p1 = parseInt(parts[1], 10);

    if (p0 === 10) return true;
    if (p0 === 172 && p1 >= 16 && p1 <= 31) return true;
    if (p0 === 192 && p1 === 168) return true;
  }

  return false;
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

export const deriveAdaptiveFlow = (route: ConnectionRoute, metrics: ConnectionMetrics) => {
  const base = getBaseFlowByRoute(route);
  let chunkSize = base.chunkSize;
  let highWaterMark = base.highWaterMark;
  let lowWaterMark = base.lowWaterMark;

  const rtt = metrics.rttMs ?? 0;
  const loss = metrics.lossPct ?? 0;
  const bitrate = metrics.availableOutgoingBitrate ?? 0;
  const protocol = route.protocol.toLowerCase();

  if (route.isLan) {
    if (loss > 1 || rtt > 80) {
      chunkSize = Math.max(128 * 1024, Math.floor(base.chunkSize / 2));
      highWaterMark = Math.max(8 * 1024 * 1024, Math.floor(base.highWaterMark * 0.75));
      lowWaterMark = Math.max(2 * 1024 * 1024, Math.floor(base.lowWaterMark * 0.75));
    } else if (loss < 0.2 && rtt > 0 && rtt < 25) {
      highWaterMark = Math.min(24 * 1024 * 1024, Math.floor(base.highWaterMark * 1.25));
      lowWaterMark = Math.min(6 * 1024 * 1024, Math.floor(base.lowWaterMark * 1.25));
    }
  } else if (route.isRelay) {
    const isTcpRelay = protocol === 'tcp';

    if (loss > 8 || rtt > 900 || (bitrate > 0 && bitrate < 1_500_000 && rtt > 500)) {
      chunkSize = 32 * 1024;
      highWaterMark = Math.max(3 * 1024 * 1024, Math.floor(base.highWaterMark * 0.5));
      lowWaterMark = Math.max(768 * 1024, Math.floor(base.lowWaterMark * 0.5));
    } else if (isTcpRelay) {
      // TCP relay 容易出现队头阻塞，保守一些的 chunk 更稳，但仍保留较深缓冲。
      chunkSize = Math.min(base.chunkSize, 64 * 1024);
      highWaterMark = Math.max(6 * 1024 * 1024, Math.floor(base.highWaterMark * 0.9));
      lowWaterMark = Math.max(1536 * 1024, Math.floor(base.lowWaterMark * 0.9));
    } else if (loss < 1 && rtt > 0 && rtt < 180 && bitrate > 6_000_000) {
      chunkSize = Math.min(192 * 1024, Math.floor(base.chunkSize * 1.5));
      highWaterMark = Math.min(12 * 1024 * 1024, Math.floor(base.highWaterMark * 1.25));
      lowWaterMark = Math.min(3 * 1024 * 1024, Math.floor(base.lowWaterMark * 1.25));
    } else if (loss < 3 && rtt > 0 && rtt < 350) {
      highWaterMark = Math.min(10 * 1024 * 1024, Math.floor(base.highWaterMark * 1.1));
      lowWaterMark = Math.min(2560 * 1024, Math.floor(base.lowWaterMark * 1.1));
    }
  } else {
    if (loss > 3 || rtt > 260 || (bitrate > 0 && bitrate < 12_000_000)) {
      chunkSize = Math.max(128 * 1024, Math.floor(base.chunkSize / 2));
      highWaterMark = Math.max(4 * 1024 * 1024, Math.floor(base.highWaterMark * 0.6));
      lowWaterMark = Math.max(1 * 1024 * 1024, Math.floor(base.lowWaterMark * 0.6));
    } else if (loss < 0.5 && rtt > 0 && rtt < 90) {
      highWaterMark = Math.min(16 * 1024 * 1024, Math.floor(base.highWaterMark * 1.5));
      lowWaterMark = Math.min(4 * 1024 * 1024, Math.floor(base.lowWaterMark * 1.5));
    }
  }

  const finalHigh = toStep(highWaterMark);
  const finalLow = toStep(Math.min(lowWaterMark, Math.floor(finalHigh * 0.5)));
  const finalChunk = toStep(chunkSize, 4 * 1024);
  return {
    chunkSize: finalChunk,
    highWaterMark: finalHigh,
    lowWaterMark: finalLow,
  };
};
