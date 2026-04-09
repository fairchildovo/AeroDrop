
type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

type IceConfigResponse = {
  iceServers?: IceServerConfig[];
  secure?: boolean;
  iceCandidatePoolSize?: number;
};

export const getIceConfig = async (): Promise<{ iceServers: IceServerConfig[], secure: boolean, iceCandidatePoolSize: number }> => {
  const fallback: { iceServers: IceServerConfig[], secure: boolean, iceCandidatePoolSize: number } = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ],
    secure: true,
    iceCandidatePoolSize: 10
  };

  try {
    const res = await fetch('/api/ice-config', { cache: 'no-store' });
    if (!res.ok) return fallback;
    const data = (await res.json()) as IceConfigResponse;

    if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) {
      return fallback;
    }

    return {
      iceServers: data.iceServers,
      secure: typeof data.secure === 'boolean' ? data.secure : fallback.secure,
      iceCandidatePoolSize: typeof data.iceCandidatePoolSize === 'number' ? data.iceCandidatePoolSize : fallback.iceCandidatePoolSize
    };
  } catch {
    return fallback;
  }

  /*
   * Server endpoint format:
   * {
   *   "iceServers": [{ "urls": "...", "username": "...", "credential": "..." }],
   *   "secure": true,
   *   "iceCandidatePoolSize": 10
   * }
   */
};

/*
 * NOTE:
 * TURN credentials should come from server-side environment bindings.
 * Do not hardcode long-lived TURN credentials in frontend bundles.
 */
