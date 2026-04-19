import { TransferState } from '../types/index.ts';

export const DIAGNOSTICS_QUERY_KEY = 'debugLogs';
export const DIAGNOSTICS_STORAGE_KEY = 'aerodrop_debug_logs';

export interface DiagnosticsModeInput {
  envEnabled?: boolean;
  search?: string;
  storedValue?: string | null;
}

export interface NoisyPeerErrorInput {
  errorType?: string | null;
  transferState: TransferState;
  activeConnections: number;
}

export const resolveDiagnosticsMode = (input: DiagnosticsModeInput = {}): boolean => {
  if (input.envEnabled === true) {
    return true;
  }

  const search = input.search ?? '';
  const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
  const queryValue = params.get(DIAGNOSTICS_QUERY_KEY)?.trim().toLowerCase();
  if (queryValue === '1' || queryValue === 'true' || queryValue === 'yes') {
    return true;
  }

  const storedValue = input.storedValue?.trim().toLowerCase();
  return storedValue === '1' || storedValue === 'true' || storedValue === 'yes';
};

export const isDiagnosticsConsoleEnabled = (): boolean => {
  try {
    const search = typeof window !== 'undefined' ? window.location.search : '';
    const storedValue =
      typeof window !== 'undefined' ? window.localStorage.getItem(DIAGNOSTICS_STORAGE_KEY) : null;

    return resolveDiagnosticsMode({
      envEnabled: import.meta.env.DEV && import.meta.env.VITE_VERBOSE_DIAGNOSTICS === '1',
      search,
      storedValue,
    });
  } catch {
    return false;
  }
};

const consoleByLevel = {
  info: console.info,
  warn: console.warn,
  error: console.error,
  log: console.log,
} as const;

export const logDebug = (
  level: keyof typeof consoleByLevel,
  ...args: Parameters<typeof console.log>
) => {
  if (!isDiagnosticsConsoleEnabled()) {
    return;
  }

  consoleByLevel[level](...args);
};

export const shouldSuppressNoisyPeerError = (input: NoisyPeerErrorInput): boolean => {
  if (input.errorType !== 'peer-unavailable') {
    return false;
  }

  if (input.activeConnections > 0) {
    return true;
  }

  return (
    input.transferState === TransferState.PEER_CONNECTED ||
    input.transferState === TransferState.TRANSFERRING ||
    input.transferState === TransferState.COMPLETED
  );
};
