export const isSupersededPeerId = (
  peerId: string,
  peerSessionIds: Map<string, string>,
  sessionToPeer: Map<string, string>
) => {
  const receiverSessionId = peerSessionIds.get(peerId);
  if (!receiverSessionId) {
    return false;
  }

  const activePeerId = sessionToPeer.get(receiverSessionId);
  return !!activePeerId && activePeerId !== peerId;
};

export const getVisiblePeerIds = (
  peerIds: string[],
  peerSessionIds: Map<string, string>,
  sessionToPeer: Map<string, string>
) => peerIds.filter((peerId) => !isSupersededPeerId(peerId, peerSessionIds, sessionToPeer));
