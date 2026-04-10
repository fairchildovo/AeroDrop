interface Env {
  TURN_URLS?: string;
  TURN_USERNAME?: string;
  TURN_CREDENTIAL?: string;
}

type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

const STUN_SERVERS: IceServerConfig[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
];

const parseTurnUrls = (raw: string | undefined): string[] => {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
};

export const onRequest: PagesFunction<Env> = async (context) => {
  const requestOrigin = context.request.headers.get('Origin');
  const requestReferer = context.request.headers.get('Referer');
  const secFetchSite = context.request.headers.get('Sec-Fetch-Site');
  const requestUrl = new URL(context.request.url);
  const allowedOrigin = requestUrl.origin;
  let refererOrigin: string | null = null;
  if (requestReferer) {
    try {
      refererOrigin = new URL(requestReferer).origin;
    } catch {
      refererOrigin = null;
    }
  }

  const isFromAllowedOrigin =
    requestOrigin === allowedOrigin ||
    (!requestOrigin && refererOrigin === allowedOrigin) ||
    (!requestOrigin && !refererOrigin && (secFetchSite === 'same-origin' || secFetchSite === 'same-site'));

  if (!isFromAllowedOrigin) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  }

  const turnUrls = parseTurnUrls(context.env.TURN_URLS);
  const turnUsername = context.env.TURN_USERNAME?.trim();
  const turnCredential = context.env.TURN_CREDENTIAL?.trim();

  const iceServers: IceServerConfig[] = [...STUN_SERVERS];
  const hasTurn = turnUrls.length > 0 && !!turnUsername && !!turnCredential;

  if (hasTurn) {
    iceServers.push({
      urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls,
      username: turnUsername,
      credential: turnCredential
    });
  }

  return new Response(
    JSON.stringify({
      iceServers,
      secure: true,
      iceCandidatePoolSize: 20,
      iceTransportPolicy: 'all',
      hasTurn
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Vary': 'Origin, Referer',
      }
    }
  );
};
