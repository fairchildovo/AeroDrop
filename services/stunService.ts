

export const getIceConfig = async (): Promise<{ iceServers: { urls: string | string[] }[], secure: boolean, iceCandidatePoolSize: number }> => {
  return {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' }
    ],
    secure: true,
    // Increase pool size to proactively gather Host candidates (LAN IP) 
    // before the connection offer is sent. This significantly improves 
    // the chance of establishing a LAN connection instead of Reflexive.
    iceCandidatePoolSize: 10
  };
};