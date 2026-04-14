export type RelayReason = 'isp' | 'score' | 'location' | 'network' | null;

type EffectiveConnectionType = 'slow-2g' | '2g' | '3g' | '4g';

type NetworkInformationLike = EventTarget & {
  type?: string;
  effectiveType?: EffectiveConnectionType | string;
  saveData?: boolean;
  rtt?: number;
  downlink?: number;
};

export type BrowserNetworkProfile = {
  isMobileDevice: boolean;
  connectionType: string;
  effectiveType: string;
  saveData: boolean;
  rtt: number | null;
  downlink: number | null;
  isLikelyMobileNetwork: boolean;
  isConstrained: boolean;
  profileKey: string;
};

const UNKNOWN_CONNECTION_TYPE = 'unknown';
const UNKNOWN_EFFECTIVE_TYPE = 'unknown';

const getNetworkInformation = (): NetworkInformationLike | null => {
  const nav = navigator as Navigator & {
    connection?: NetworkInformationLike;
    mozConnection?: NetworkInformationLike;
    webkitConnection?: NetworkInformationLike;
  };

  return nav.connection ?? nav.mozConnection ?? nav.webkitConnection ?? null;
};

const normalizePositiveNumber = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
};

export const getBrowserNetworkProfile = (): BrowserNetworkProfile => {
  const ua = navigator.userAgent.toLowerCase();
  const isMobileDevice =
    /android|iphone|ipad|ipod|mobile/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const connection = getNetworkInformation();
  const connectionType = connection?.type?.trim().toLowerCase() || UNKNOWN_CONNECTION_TYPE;
  const effectiveType = connection?.effectiveType?.trim().toLowerCase() || UNKNOWN_EFFECTIVE_TYPE;
  const saveData = connection?.saveData === true;
  const rtt = normalizePositiveNumber(connection?.rtt);
  const downlink = normalizePositiveNumber(connection?.downlink);

  const isLikelyMobileNetwork =
    connectionType === 'cellular' ||
    connectionType === 'wimax' ||
    (isMobileDevice &&
      effectiveType !== UNKNOWN_EFFECTIVE_TYPE &&
      (effectiveType === 'slow-2g' || effectiveType === '2g' || effectiveType === '3g'));

  const isConstrained =
    saveData ||
    effectiveType === 'slow-2g' ||
    effectiveType === '2g' ||
    effectiveType === '3g' ||
    (rtt !== null && rtt >= 180) ||
    (downlink !== null && downlink > 0 && downlink < 5);

  return {
    isMobileDevice,
    connectionType,
    effectiveType,
    saveData,
    rtt,
    downlink,
    isLikelyMobileNetwork,
    isConstrained,
    profileKey: [
      isMobileDevice ? 'm1' : 'm0',
      connectionType,
      effectiveType,
      saveData ? 'sd1' : 'sd0',
      rtt ?? 'na',
      downlink ?? 'na',
    ].join(':'),
  };
};

export const appendNetworkProfileQuery = (
  params: URLSearchParams,
  profile: BrowserNetworkProfile
): URLSearchParams => {
  params.set('mobileDevice', profile.isMobileDevice ? '1' : '0');
  params.set('networkType', profile.connectionType);
  params.set('effectiveType', profile.effectiveType);
  params.set('saveData', profile.saveData ? '1' : '0');
  if (profile.rtt !== null) {
    params.set('rtt', String(profile.rtt));
  }
  if (profile.downlink !== null) {
    params.set('downlink', String(profile.downlink));
  }
  return params;
};

export const watchNetworkProfileChanges = (onChange: () => void): void => {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  getNetworkInformation()?.addEventListener?.('change', onChange as EventListener);
};
