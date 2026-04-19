import { readScreenShareViewSession } from './screenShareViewerSession.ts';

export type Mode = 'send' | 'receive' | 'screen';

export type InitialRouteState = {
  code: string;
  hadDeepLink: boolean;
  mode: Mode;
  viewId: string;
};

type ResolveInitialRouteStateInput = {
  search: string;
  readSessionValue: (key: string) => string | null;
};

export { SCREEN_SHARE_VIEW_SESSION_KEY } from './screenShareViewerSession.ts';

export const resolveInitialRouteState = (
  input: ResolveInitialRouteStateInput,
): InitialRouteState => {
  const params = new URLSearchParams(input.search);
  const code = params.get('code')?.trim() ?? '';
  const urlViewId = params.get('view')?.trim() ?? '';

  if (code) {
    return { mode: 'receive', code, viewId: '', hadDeepLink: true };
  }

  const restoredViewId = urlViewId || readScreenShareViewSession(input.readSessionValue);
  if (restoredViewId) {
    return {
      mode: 'screen',
      code: '',
      viewId: restoredViewId,
      hadDeepLink: Boolean(urlViewId),
    };
  }

  return { mode: 'send', code: '', viewId: '', hadDeepLink: false };
};

export const getInitialRouteState = (): InitialRouteState => {
  if (typeof window === 'undefined') {
    return { mode: 'send', code: '', viewId: '', hadDeepLink: false };
  }

  return resolveInitialRouteState({
    search: window.location.search,
    readSessionValue: (key) => window.sessionStorage.getItem(key),
  });
};
