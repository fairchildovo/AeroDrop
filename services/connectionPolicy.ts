import type { BrowserNetworkProfile } from './networkProfile';
import type { IceConfigResult } from './stunService';
import { getRouteSelectionTimings } from './routeSelectionPolicy';

export type HappyEyeballsPlan = {
  initialPolicy: RTCIceTransportPolicy;
  backgroundPolicy: RTCIceTransportPolicy | null;
  initialTimeoutMs: number;
  backgroundDelayMs: number | null;
  backgroundTimeoutMs: number | null;
  reason: 'default' | 'relay_recommended' | 'mobile_network' | 'constrained_network';
};

type ConnectionPolicyOptions = {
  defaultInitialTimeoutMs: number;
  relayInitialTimeoutMs: number;
};

const getRelayPrewarmReason = (
  iceConfig: IceConfigResult,
  profile: BrowserNetworkProfile
) => {
  if (!iceConfig.hasTurn) {
    return 'default' as const;
  }

  if (profile.isMobileDevice || profile.isLikelyMobileNetwork) {
    return 'mobile_network';
  }

  if (profile.isConstrained) {
    return 'constrained_network';
  }

  if (
    iceConfig.relayRecommended ||
    (iceConfig.fetchLatencyMs !== null && iceConfig.fetchLatencyMs >= 1200)
  ) {
    return 'relay_recommended';
  }

  return 'default';
};

export const createHappyEyeballsPlan = (
  iceConfig: IceConfigResult,
  profile: BrowserNetworkProfile,
  options: ConnectionPolicyOptions
): HappyEyeballsPlan => {
  const relayPrewarmReason = getRelayPrewarmReason(iceConfig, profile);
  const routeTimings = getRouteSelectionTimings({
    isMobileDevice: profile.isMobileDevice,
    isConstrained: profile.isConstrained,
    relayRecommended: iceConfig.relayRecommended,
    fetchLatencyMs: iceConfig.fetchLatencyMs,
  });
  const shouldPrewarmRelay = iceConfig.hasTurn && routeTimings.startRelayDelayMs !== null;

  if (!iceConfig.hasTurn) {
    return {
      initialPolicy: 'all',
      backgroundPolicy: null,
      initialTimeoutMs: options.defaultInitialTimeoutMs,
      backgroundDelayMs: null,
      backgroundTimeoutMs: null,
      reason: 'default',
    };
  }

  return {
    initialPolicy: 'all',
    backgroundPolicy: shouldPrewarmRelay ? 'relay' : null,
    initialTimeoutMs: options.defaultInitialTimeoutMs,
    backgroundDelayMs: shouldPrewarmRelay ? routeTimings.startRelayDelayMs : null,
    backgroundTimeoutMs: shouldPrewarmRelay ? options.relayInitialTimeoutMs : null,
    reason: shouldPrewarmRelay ? relayPrewarmReason : 'default',
  };
};
