export type IceConfigRelayReason = 'isp' | 'score' | 'location' | 'network' | null;

export type IceTransportPolicyDecisionInput = {
  hasTurn: boolean;
  isRisk: boolean;
  riskReason: IceConfigRelayReason;
};

export type IceTransportPolicyDecision = {
  iceTransportPolicy: 'all' | 'relay';
  relayRecommended: boolean;
  relayReason: IceConfigRelayReason;
};

export const resolveIceTransportPolicyDecision = (
  input: IceTransportPolicyDecisionInput
): IceTransportPolicyDecision => {
  const shouldRecommendRelay = input.hasTurn && input.isRisk;

  return {
    // Keep full candidate gathering enabled by default so desktop/proxy
    // environments can still win with direct P2P when it is actually viable.
    iceTransportPolicy: 'all',
    relayRecommended: shouldRecommendRelay,
    relayReason: shouldRecommendRelay ? input.riskReason : null,
  };
};
