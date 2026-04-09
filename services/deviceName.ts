const inferDefaultDeviceName = (): string => {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('iphone')) return 'iPhone';
  if (ua.includes('ipad')) return 'iPad';
  if (ua.includes('android')) return 'Android';
  if (ua.includes('mac os') || ua.includes('macintosh')) return 'Mac';
  if (ua.includes('windows')) return 'Windows';
  if (ua.includes('linux')) return 'Linux';
  return 'Unknown';
};

export const getInitialDeviceName = (): string => {
  if (typeof window === 'undefined') return 'Unknown';
  return inferDefaultDeviceName();
};
