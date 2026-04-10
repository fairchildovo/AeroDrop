
type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

type IceConfigResponse = {
  iceServers?: IceServerConfig[];
  secure?: boolean;
  iceCandidatePoolSize?: number;
  iceTransportPolicy?: RTCIceTransportPolicy;
  hasTurn?: boolean;
};

export type IceConfigResult = {
  iceServers: IceServerConfig[];
  secure: boolean;
  iceCandidatePoolSize: number;
  iceTransportPolicy: RTCIceTransportPolicy;
  hasTurn: boolean;
};

const ICE_CACHE_TTL_MS = 30_000;
const ICE_FETCH_TIMEOUT_MS = 2000;
let cachedConfig: IceConfigResult | null = null;
let cachedAt = 0;
let inflightRequest: Promise<IceConfigResult> | null = null;

export const getIceConfig = async (): Promise<IceConfigResult> => {
  const now = Date.now();
  if (cachedConfig && now - cachedAt < ICE_CACHE_TTL_MS) {
    return cachedConfig;
  }

  if (inflightRequest) {
    return inflightRequest;
  }

  inflightRequest = fetchIceConfig().finally(() => {
    inflightRequest = null;
  });
  return inflightRequest;
};

const fallbackConfig: IceConfigResult = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ],
  secure: true,
  iceCandidatePoolSize: 20,
  iceTransportPolicy: 'all' as RTCIceTransportPolicy,
  hasTurn: false
};

const fetchIceConfig = async (): Promise<IceConfigResult> => {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), ICE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch('/api/ice-config', { cache: 'no-store', signal: controller.signal });
    if (!res.ok) return fallbackConfig;
    const data = (await res.json()) as IceConfigResponse;

    if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) {
      return fallbackConfig;
    }

    const result: IceConfigResult = {
      iceServers: data.iceServers,
      secure: typeof data.secure === 'boolean' ? data.secure : fallbackConfig.secure,
      iceCandidatePoolSize: typeof data.iceCandidatePoolSize === 'number' ? data.iceCandidatePoolSize : fallbackConfig.iceCandidatePoolSize,
      iceTransportPolicy: data.iceTransportPolicy === 'relay' ? 'relay' : 'all',
      hasTurn: typeof data.hasTurn === 'boolean'
        ? data.hasTurn
        : data.iceServers.some(server => {
            const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
            return urls.some(url => url.startsWith('turn:') || url.startsWith('turns:'));
          })
    };
    cachedConfig = result;
    cachedAt = Date.now();
    return result;
  } catch {
    return fallbackConfig;
  } finally {
    window.clearTimeout(timeoutId);
  }
};

/** Prefetch ICE config so subsequent getIceConfig() calls return instantly. */
export const prefetchIceConfig = (): void => {
  getIceConfig().catch(() => {});
};

/*
 * NOTE:
 * TURN credentials should come from server-side environment bindings.
 * Do not hardcode long-lived TURN credentials in frontend bundles.
 */
