
// Hardcoded reliable servers (Cloudflare, Google, Twilio)
const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.finsterwalder.com:3478' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
];

const STUN_LIST_URL = 'https://raw.githubusercontent.com/pradt2/always-online-stun/master/valid_hosts.txt';
const CACHE_KEY = 'aerodrop_stun_cache';
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

interface StunCache {
  timestamp: number;
  servers: string[];
}

/**
 * Fetches and parses the dynamic STUN list.
 * Includes timeout, caching, and randomization logic.
 */
export const getIceConfig = async (): Promise<{ iceServers: { urls: string | string[] }[], secure: boolean }> => {
  // 1. Try to get from LocalStorage cache first
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

  // 2. Fetch new list with a timeout
  try {
    console.log('[STUN] Fetching dynamic server list...');
    
    // Create a timeout promise (e.g., 2 seconds max wait)
    const timeout = new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error('Fetch timeout')), 2000)
    );

    const fetchRequest = fetch(STUN_LIST_URL).then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    });

    // Race connection vs timeout
    const rawText = await Promise.race([fetchRequest, timeout]) as string;
    
    // 3. Parse and Filter
    const allLines = rawText.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#')); // Remove comments and empty lines

    // Cache the raw list
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      timestamp: Date.now(),
      servers: allLines
    }));

    console.log(`[STUN] Fetched ${allLines.length} servers successfully.`);
    return buildConfig(allLines);

  } catch (err) {
    console.warn('[STUN] Failed to fetch dynamic list, using defaults only.', err);
    // Fallback to defaults
    return { iceServers: DEFAULT_ICE_SERVERS, secure: true };
  }
};

/**
 * Helper to mix default servers with a random selection of dynamic servers.
 * We limit the total number to avoid overly large SDP packets which can fail WebRTC.
 */
const buildConfig = (dynamicList: string[]) => {
  // Pick X random servers from the dynamic list
  const MAX_DYNAMIC = 15;
  const shuffled = [...dynamicList].sort(() => 0.5 - Math.random());
  const selected = shuffled.slice(0, MAX_DYNAMIC).map(addr => ({
    urls: `stun:${addr}`
  }));

  // Combine Default (High Quality) + Random (Diversity)
  // Put defaults first as they are usually fastest
  return {
    iceServers: [
      ...DEFAULT_ICE_SERVERS,
      ...selected
    ],
    secure: true
  };
};
