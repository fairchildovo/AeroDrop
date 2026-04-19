export const SCREEN_SHARE_VIEW_SESSION_KEY = 'aerodrop_screen_view_id';

const normalizeSharerId = (value: string | null | undefined): string => value?.trim() ?? '';

export const readScreenShareViewSession = (
  read: (key: string) => string | null,
): string => normalizeSharerId(read(SCREEN_SHARE_VIEW_SESSION_KEY));

export const writeScreenShareViewSession = (
  write: (key: string, value: string) => void,
  sharerId: string,
): string => {
  const normalizedSharerId = normalizeSharerId(sharerId);
  if (!normalizedSharerId) {
    return '';
  }
  write(SCREEN_SHARE_VIEW_SESSION_KEY, normalizedSharerId);
  return normalizedSharerId;
};

export const clearScreenShareViewSession = (
  remove: (key: string) => void,
): void => {
  remove(SCREEN_SHARE_VIEW_SESSION_KEY);
};
