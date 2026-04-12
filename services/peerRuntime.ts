let peerRuntimePromise: Promise<typeof import('peerjs')> | null = null;

export const loadPeerRuntime = (): Promise<typeof import('peerjs')> => {
  if (!peerRuntimePromise) {
    peerRuntimePromise = import('peerjs');
  }

  return peerRuntimePromise;
};

export const preloadPeerRuntime = (): void => {
  void loadPeerRuntime();
};
