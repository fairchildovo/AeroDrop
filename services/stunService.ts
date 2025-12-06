// Hardcoded reliable servers (Cloudflare, Twilio, Google)
const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const STUN_LIST_URL = 'https://raw.githubusercontent.com/pradt2/always-online-stun/master/valid_hosts.txt';
const CACHE_KEY = 'aerodrop_stun_cache';
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

interface StunCache {
  timestamp: number;
  servers: string[];
}

export const getIceConfig = async (): Promise<{ iceServers: { urls: string | string[] }[], secure: boolean }> => {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const data: StunCache = JSON.parse(cached);
      if (Date.now() - data.timestamp < CACHE_DURATION && data.servers.length > 0) {
        console.log(`[STUN] Loaded ${data.servers.length} servers from cache.`);
        return buildConfig(data.servers);
      }
    }
  } catch (e) {
    console.warn('[STUN] Cache read failed', e);
  }

  try {
    console.log('[STUN] Fetching dynamic server list...');
    
    const timeout = new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error('Fetch timeout')), 800)
    );

    const fetchRequest = fetch(STUN_LIST_URL).then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    });

    const rawText = await Promise.race([fetchRequest, timeout]) as string;
    
    const allLines = rawText.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));

    localStorage.setItem(CACHE_KEY, JSON.stringify({
      timestamp: Date.now(),
      servers: allLines
    }));

    console.log(`[STUN] Fetched ${allLines.length} servers successfully.`);
    return buildConfig(allLines);

  } catch (err) {
    console.warn('[STUN] Failed to fetch dynamic list, using defaults only.', err);
    return { iceServers: DEFAULT_ICE_SERVERS, secure: true };
  }
};

const buildConfig = (dynamicList: string[]) => {
  const MAX_DYNAMIC = 5;

  const isValidStun = (addr: string) => {
    if (!addr) return false;
    if (!addr.includes('.')) return false;
    if (addr.length > 64) return false;
    return true;
  };

  const filtered = dynamicList.filter(isValidStun);

  const shuffled = [...filtered].sort(() => 0.5 - Math.random());

  const selected = shuffled.slice(0, MAX_DYNAMIC).map(addr => ({
    urls: `stun:${addr}`
  }));

  return {
    iceServers: [
      ...DEFAULT_ICE_SERVERS,
      ...selected
    ],
    secure: true
  };
};