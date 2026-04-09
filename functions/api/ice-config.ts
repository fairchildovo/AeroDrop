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
  const turnUrls = parseTurnUrls(context.env.TURN_URLS);
  const turnUsername = context.env.TURN_USERNAME?.trim();
  const turnCredential = context.env.TURN_CREDENTIAL?.trim();

  const iceServers: IceServerConfig[] = [...STUN_SERVERS];

  if (turnUrls.length > 0 && turnUsername && turnCredential) {
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
      iceCandidatePoolSize: 10
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      }
    }
  );
};

