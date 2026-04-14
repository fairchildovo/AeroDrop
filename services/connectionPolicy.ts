import type { BrowserNetworkProfile } from './networkProfile';
import type { IceConfigResult } from './stunService';

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
  relayParallelDelayMs: number;
  p2pBackfillDelayMs: number;
};

const shouldPreferRelayFirst = (
  iceConfig: IceConfigResult,
  profile: BrowserNetworkProfile
): HappyEyeballsPlan['reason'] | null => {
  if (!iceConfig.hasTurn) {
    return null;
  }

  if (iceConfig.iceTransportPolicy === 'relay') {
    return 'relay_recommended';
  }

  if (profile.isLikelyMobileNetwork && profile.isConstrained) {
    return 'mobile_network';
  }

  if (profile.isConstrained || (iceConfig.fetchLatencyMs !== null && iceConfig.fetchLatencyMs >= 1200)) {
    return 'constrained_network';
  }

  return null;
};

export const createHappyEyeballsPlan = (
  iceConfig: IceConfigResult,
  profile: BrowserNetworkProfile,
  options: ConnectionPolicyOptions
): HappyEyeballsPlan => {
  const relayReason = shouldPreferRelayFirst(iceConfig, profile);
  const shouldStartRelayFallbackEarly =
    iceConfig.hasTurn &&
    (
      iceConfig.relayRecommended ||
      profile.isLikelyMobileNetwork ||
      profile.isConstrained ||
      (iceConfig.fetchLatencyMs !== null && iceConfig.fetchLatencyMs >= 1200)
    );

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

  if (relayReason) {
    return {
      initialPolicy: 'relay',
      backgroundPolicy: 'all',
      initialTimeoutMs: options.relayInitialTimeoutMs,
      backgroundDelayMs: profile.isLikelyMobileNetwork ? 1400 : options.p2pBackfillDelayMs,
      backgroundTimeoutMs: options.defaultInitialTimeoutMs,
      reason: relayReason,
    };
  }

  return {
    initialPolicy: 'all',
    backgroundPolicy: 'relay',
    initialTimeoutMs: options.defaultInitialTimeoutMs,
    backgroundDelayMs: shouldStartRelayFallbackEarly
      ? Math.min(600, options.relayParallelDelayMs)
      : (profile.isConstrained ? 800 : options.relayParallelDelayMs),
    backgroundTimeoutMs: options.relayInitialTimeoutMs,
    reason: shouldStartRelayFallbackEarly
      ? (iceConfig.relayRecommended
          ? 'relay_recommended'
          : profile.isLikelyMobileNetwork
            ? 'mobile_network'
            : 'constrained_network')
      : 'default',
  };
};
