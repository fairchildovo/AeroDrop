const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export const getIceConfig = async (): Promise<{ iceServers: { urls: string | string[] }[], secure: boolean }> => {
  return {
    iceServers: DEFAULT_ICE_SERVERS,
    secure: true
  };
};