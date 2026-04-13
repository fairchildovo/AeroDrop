import { DurableObject } from 'cloudflare:workers';

interface AssetBinding {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

interface Env {
  ASSETS: AssetBinding;
  SIGNALING_HUB: DurableObjectNamespace;
  CF_TURN_TOKEN_ID?: string;
  CF_TURN_KEY_ID?: string;
  CF_TURN_API_TOKEN?: string;
  CF_TURN_TTL_SECONDS?: string;
  TURN_URLS?: string;
  TURN_USERNAME?: string;
  TURN_CREDENTIAL?: string;
}

type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

type IceConfigPayload = {
  iceServers: IceServerConfig[];
  secure: boolean;
  iceCandidatePoolSize: number;
  iceTransportPolicy: 'all' | 'relay';
  hasTurn: boolean;
};

type CloudflareTurnApiResponse = {
  iceServers?: IceServerConfig[];
};

type SignalingEnvelope =
  | { type: 'registered'; peerId: string }
  | { type: 'error'; code: string; message?: string; connectionId?: string; targetPeerId?: string; kind?: 'data' | 'media' }
  | {
      type: 'offer' | 'answer';
      connectionId: string;
      kind: 'data' | 'media';
      sourcePeerId: string;
      targetPeerId: string;
      description: RTCSessionDescriptionInit;
    }
  | {
      type: 'ice-candidate';
      connectionId: string;
      kind: 'data' | 'media';
      sourcePeerId: string;
      targetPeerId: string;
      candidate: RTCIceCandidateInit;
    };

const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const HTML_CACHE_CONTROL = 'no-cache';
const SW_CACHE_CONTROL = 'no-cache';
const MANIFEST_CACHE_CONTROL = 'no-cache';
const DEFAULT_CF_TURN_TTL_SECONDS = 3600;
const MIN_CF_TURN_TTL_SECONDS = 60;
const MAX_CF_TURN_TTL_SECONDS = 86400;
const CF_TURN_CACHE_SAFETY_WINDOW_SECONDS = 60;
const CF_TURN_FETCH_TIMEOUT_MS = 4000;

const STUN_SERVERS: IceServerConfig[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

let cachedCfIceConfig: IceConfigPayload | null = null;
let cachedCfIceConfigExpiresAt = 0;
let inflightCfIceConfig: Promise<IceConfigPayload | null> | null = null;

const SIGNALING_DO_NAME = 'global-signaling-hub';
const SIGNALING_PATH = '/ws-signaling';

const setSecurityHeaders = (headers: Headers) => {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  headers.set('X-XSS-Protection', '1; mode=block');
  if (!headers.has('Strict-Transport-Security')) {
    headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
};

const applyResponsePolicies = (request: Request, response: Response): Response => {
  const headers = new Headers(response.headers);
  setSecurityHeaders(headers);

  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    const pathname = new URL(request.url).pathname.toLowerCase();

    if (pathname === '/sw.js') {
      headers.set('Cache-Control', SW_CACHE_CONTROL);
    } else if (pathname === '/manifest.json') {
      headers.set('Cache-Control', MANIFEST_CACHE_CONTROL);
    } else if (pathname.endsWith('.js') || pathname.endsWith('.css')) {
      headers.set('Cache-Control', IMMUTABLE_ASSET_CACHE_CONTROL);
    } else if (pathname === '/' || pathname.endsWith('/index.html') || pathname.endsWith('.html')) {
      headers.set('Cache-Control', HTML_CACHE_CONTROL);
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const json = (data: unknown, init: ResponseInit = {}): Response => {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  });
};

const parseTurnUrls = (raw: string | undefined): string[] => {
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
};

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const getCloudflareTurnTokenId = (env: Env): string => {
  return env.CF_TURN_TOKEN_ID?.trim() || env.CF_TURN_KEY_ID?.trim() || '';
};

const getCloudflareTurnTtlSeconds = (env: Env): number => {
  const requestedTtl = parsePositiveInt(env.CF_TURN_TTL_SECONDS, DEFAULT_CF_TURN_TTL_SECONDS);
  return Math.min(MAX_CF_TURN_TTL_SECONDS, Math.max(MIN_CF_TURN_TTL_SECONDS, requestedTtl));
};

const createIceConfigPayload = (
  iceServers: IceServerConfig[],
  iceTransportPolicy: 'all' | 'relay' = 'all'
): IceConfigPayload => ({
  iceServers,
  secure: true,
  iceCandidatePoolSize: 20,
  iceTransportPolicy,
  hasTurn: iceServers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => url.startsWith('turn:') || url.startsWith('turns:'));
  }),
});

const createStaticIceConfigPayload = (env: Env): IceConfigPayload => {
  const turnUrls = parseTurnUrls(env.TURN_URLS);
  const turnUsername = env.TURN_USERNAME?.trim();
  const turnCredential = env.TURN_CREDENTIAL?.trim();

  const iceServers: IceServerConfig[] = [...STUN_SERVERS];
  const hasTurn = turnUrls.length > 0 && !!turnUsername && !!turnCredential;

  if (hasTurn) {
    iceServers.push({
      urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls,
      username: turnUsername,
      credential: turnCredential,
    });
  }

  return createIceConfigPayload(iceServers);
};

const isAllowedSameOriginRequest = (request: Request): boolean => {
  const requestOrigin = request.headers.get('Origin');
  const requestReferer = request.headers.get('Referer');
  const secFetchSite = request.headers.get('Sec-Fetch-Site');
  const requestUrl = new URL(request.url);
  const allowedOrigin = requestUrl.origin;
  let refererOrigin: string | null = null;

  if (requestReferer) {
    try {
      refererOrigin = new URL(requestReferer).origin;
    } catch {
      refererOrigin = null;
    }
  }

  return (
    requestOrigin === allowedOrigin ||
    (!requestOrigin && refererOrigin === allowedOrigin) ||
    (!requestOrigin &&
      !refererOrigin &&
      (secFetchSite === 'same-origin' || secFetchSite === 'same-site'))
  );
};

const fetchCloudflareTurnIceConfig = async (env: Env): Promise<IceConfigPayload | null> => {
  const turnTokenId = getCloudflareTurnTokenId(env);
  const apiToken = env.CF_TURN_API_TOKEN?.trim();

  if (!turnTokenId || !apiToken) {
    return null;
  }

  const now = Date.now();
  if (cachedCfIceConfig && now < cachedCfIceConfigExpiresAt) {
    return cachedCfIceConfig;
  }

  if (inflightCfIceConfig) {
    return inflightCfIceConfig;
  }

  inflightCfIceConfig = (async () => {
    const ttlSeconds = getCloudflareTurnTtlSeconds(env);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CF_TURN_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${turnTokenId}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl: ttlSeconds }),
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        throw new Error(`Cloudflare TURN API returned ${response.status}`);
      }

      const data = (await response.json()) as CloudflareTurnApiResponse;
      if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) {
        throw new Error('Cloudflare TURN API returned no iceServers');
      }

      const payload = createIceConfigPayload(data.iceServers);
      cachedCfIceConfig = payload;

      const cacheTtlSeconds = Math.max(
        30,
        Math.min(300, ttlSeconds - CF_TURN_CACHE_SAFETY_WINDOW_SECONDS)
      );
      cachedCfIceConfigExpiresAt = Date.now() + cacheTtlSeconds * 1000;
      return payload;
    } catch (error) {
      console.error('Failed to fetch Cloudflare TURN credentials', error);
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  })().finally(() => {
    inflightCfIceConfig = null;
  });

  return inflightCfIceConfig;
};

const handleIceConfig = async (request: Request, env: Env): Promise<Response> => {
  if (!isAllowedSameOriginRequest(request)) {
    return json(
      { error: 'Forbidden' },
      {
        status: 403,
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    );
  }

  const cfIceConfig = await fetchCloudflareTurnIceConfig(env);
  const payload = cfIceConfig ?? createStaticIceConfigPayload(env);

  return json(
    payload,
    {
      headers: {
        'Cache-Control': 'no-store',
        Vary: 'Origin, Referer',
      },
    }
  );
};

const handleSignalingUpgrade = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== 'GET') {
    return new Response('Worker expected GET method', { status: 400 });
  }

  const upgradeHeader = request.headers.get('Upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    return new Response('Worker expected Upgrade: websocket', { status: 426 });
  }

  if (!isAllowedSameOriginRequest(request)) {
    return new Response('Forbidden', { status: 403 });
  }

  const url = new URL(request.url);
  const peerId = url.searchParams.get('peerId')?.trim() || '';
  if (!peerId) {
    return new Response('Missing peerId', { status: 400 });
  }

  const hubId = env.SIGNALING_HUB.idFromName(SIGNALING_DO_NAME);
  const stub = env.SIGNALING_HUB.get(hubId);
  return await stub.fetch(request);
};

const handleNetworkCheck = (request: Request): Response => {
  const cf = request.cf;

  if (!cf) {
    return json(
      {
        isRisk: false,
        reason: null,
        details: 'Local development or CF object missing',
        isp: 'Local Dev',
        country: 'CN',
      },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        },
      }
    );
  }

  const riskKeywords = [
    'google',
    'amazon',
    'aws',
    'microsoft',
    'azure',
    'digitalocean',
    'linode',
    'vultr',
    'alibaba',
    'tencent',
    'oracle',
    'cloudflare',
    'cdn',
    'server',
  ];

  const originalIsp = (cf.asOrganization as string) || 'Unknown';
  const isp = originalIsp.toLowerCase();
  const country = (cf.country as string) || 'Unknown';
  const threatScore = (cf.threatScore as number) || 0;

  let isRisk = false;
  let reason: 'isp' | 'score' | 'location' | null = null;
  let details = '';

  if (riskKeywords.some((keyword) => isp.includes(keyword))) {
    isRisk = true;
    reason = 'isp';
    details = originalIsp;
  } else if (threatScore > 10) {
    isRisk = true;
    reason = 'score';
    details = `Threat Score: ${threatScore}`;
  } else if (country !== 'CN') {
    details = `Location: ${country}`;
  }

  return json(
    {
      isRisk,
      reason,
      details,
      isp: originalIsp,
      country,
    },
    {
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      },
    }
  );
};

const handlePing = async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: {
        Allow: 'POST',
      },
    });
  }

  const body = await request.text();
  if (body !== 'ping') {
    return new Response('Bad Request', { status: 400 });
  }

  return new Response('pong', {
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  });
};

const handleApiRequest = async (request: Request, env: Env, pathname: string): Promise<Response> => {
  switch (pathname) {
    case '/api/ice-config':
      return handleIceConfig(request, env);
    case '/api/network-check':
      return handleNetworkCheck(request);
    case '/api/ping':
      return handlePing(request);
    default:
      return new Response('Not Found', {
        status: 404,
        headers: {
          'Cache-Control': 'no-store',
        },
      });
  }
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    if (pathname === SIGNALING_PATH) {
      return await handleSignalingUpgrade(request, env);
    }

    if (pathname.startsWith('/api/')) {
      const response = await handleApiRequest(request, env, pathname);
      return applyResponsePolicies(request, response);
    }

    const assetResponse = await env.ASSETS.fetch(request);
    return applyResponsePolicies(request, assetResponse);
  },
};

type SessionAttachment = {
  peerId: string;
};

export class SignalingHub extends DurableObject {
  private sessionsByPeer = new Map<string, WebSocket>();
  private peerBySocket = new Map<WebSocket, string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as SessionAttachment | null;
      if (!attachment?.peerId) continue;
      this.sessionsByPeer.set(attachment.peerId, ws);
      this.peerBySocket.set(ws, attachment.peerId);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }

    const url = new URL(request.url);
    const peerId = url.searchParams.get('peerId')?.trim() || '';
    if (!peerId) {
      return new Response('Missing peerId', { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.serializeAttachment({ peerId } satisfies SessionAttachment);
    this.ctx.acceptWebSocket(server);

    const existing = this.sessionsByPeer.get(peerId);
    if (existing && existing !== server) {
      server.send(
        JSON.stringify({
          type: 'error',
          code: 'unavailable-id',
          message: 'Peer ID already in use',
        } satisfies SignalingEnvelope)
      );
      server.close(4009, 'Peer ID already in use');
      return new Response(null, { status: 101, webSocket: client });
    }

    this.sessionsByPeer.set(peerId, server);
    this.peerBySocket.set(server, peerId);
    server.send(JSON.stringify({ type: 'registered', peerId } satisfies SignalingEnvelope));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') {
      this.sendError(ws, 'invalid-message', 'Only text signaling messages are supported');
      return;
    }

    let payload: SignalingEnvelope;
    try {
      payload = JSON.parse(message) as SignalingEnvelope;
    } catch {
      this.sendError(ws, 'invalid-message', 'Invalid JSON signaling payload');
      return;
    }

    if (payload.type !== 'offer' && payload.type !== 'answer' && payload.type !== 'ice-candidate') {
      this.sendError(ws, 'invalid-message', `Unsupported signaling type: ${(payload as { type?: string }).type ?? 'unknown'}`);
      return;
    }

    const sourcePeerId = this.peerBySocket.get(ws) || '';
    if (!sourcePeerId) {
      this.sendError(ws, 'disconnected', 'Socket is not registered');
      return;
    }

    const target = this.sessionsByPeer.get(payload.targetPeerId);
    if (!target) {
      this.sendError(ws, 'peer-unavailable', 'Target peer is unavailable', payload.connectionId, payload.targetPeerId, payload.kind);
      return;
    }

    target.send(
      JSON.stringify({
        ...payload,
        sourcePeerId,
      } satisfies SignalingEnvelope)
    );
  }

  webSocketClose(ws: WebSocket): void {
    this.unregisterSocket(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.unregisterSocket(ws);
  }

  private unregisterSocket(ws: WebSocket): void {
    const peerId = this.peerBySocket.get(ws);
    if (!peerId) return;
    this.peerBySocket.delete(ws);
    if (this.sessionsByPeer.get(peerId) === ws) {
      this.sessionsByPeer.delete(peerId);
    }
  }

  private sendError(
    ws: WebSocket,
    code: string,
    message: string,
    connectionId?: string,
    targetPeerId?: string,
    kind?: 'data' | 'media'
  ): void {
    ws.send(
      JSON.stringify({
        type: 'error',
        code,
        message,
        connectionId,
        targetPeerId,
        kind,
      } satisfies SignalingEnvelope)
    );
  }
}
