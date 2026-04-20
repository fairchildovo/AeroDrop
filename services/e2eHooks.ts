import type { IceConfigResult } from './stunService';

export interface AeroDropPeerRuntimeModuleLike {
  default: new (...args: any[]) => unknown;
}

export interface AeroDropE2EHooks {
  getIceConfigOverride?: () => IceConfigResult;
  createPeerRuntimeModule?: () => Promise<AeroDropPeerRuntimeModuleLike> | AeroDropPeerRuntimeModuleLike;
}

export const getAeroDropE2EHooks = (): AeroDropE2EHooks | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const hooks = (window as Window & { __AERODROP_E2E__?: AeroDropE2EHooks }).__AERODROP_E2E__;
  return hooks ?? null;
};
