export type ScreenShareBrowserProfile = {
  isIOSLike: boolean;
  isSafariLike: boolean;
  isWebKitLike: boolean;
  prefersCompatibilityCodecs: boolean;
  requiresExplicitViewerPlayback: boolean;
};

export type ScreenShareBrowserLike = {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
};

const WEBKIT_BROWSER_EXCLUSIONS =
  /CriOS|Chrome|Chromium|EdgiOS|EdgA|Edg\/|FxiOS|Firefox|OPiOS|OPR|SamsungBrowser|Android/i;

export const getScreenShareBrowserProfile = (
  browser: ScreenShareBrowserLike,
): ScreenShareBrowserProfile => {
  const userAgent = browser.userAgent || '';
  const platform = browser.platform || '';
  const maxTouchPoints = browser.maxTouchPoints || 0;

  const isIOSLike =
    /iPad|iPhone|iPod/i.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
  const isWebKitLike = /AppleWebKit/i.test(userAgent) && !/Chrome\/|Chromium\//i.test(userAgent);
  const isSafariLike =
    /Safari/i.test(userAgent) && /AppleWebKit/i.test(userAgent) && !WEBKIT_BROWSER_EXCLUSIONS.test(userAgent);

  return {
    isIOSLike,
    isSafariLike,
    isWebKitLike: isWebKitLike || isIOSLike,
    prefersCompatibilityCodecs: isIOSLike || isWebKitLike,
    requiresExplicitViewerPlayback: isIOSLike || isSafariLike,
  };
};

export const getPreferredScreenShareCodecOrder = (
  profile: ScreenShareBrowserProfile,
): string[] => {
  if (profile.prefersCompatibilityCodecs) {
    return ['video/H264', 'video/VP8', 'video/VP9', 'video/AV1'];
  }

  return ['video/AV1', 'video/VP9', 'video/H264', 'video/VP8'];
};

export const shouldEnableLayeredScreenShareEncoding = (
  profile: ScreenShareBrowserProfile,
): boolean => !profile.prefersCompatibilityCodecs;
