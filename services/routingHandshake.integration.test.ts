import test from 'node:test';
import assert from 'node:assert/strict';

import type { FileMetadata, P2PMessage } from '../types';
import { createReceiveRouteArbiter } from './receive/routeArbiter.ts';
import { createReceiverSessionRegistry } from './send/receiverSessionRegistry.ts';
import { createRouteCommitGate } from './send/routeCommitGate.ts';
import {
  createSenderRouteHandshakeHandler,
  type SenderRouteHandshakeConnection,
} from './send/routeHandshake.ts';

class FakeConnection implements SenderRouteHandshakeConnection {
  readonly sent: P2PMessage[] = [];
  closed = false;

  constructor(public readonly peer: string) {}

  send(message: P2PMessage) {
    this.sent.push(message);
  }

  close() {
    this.closed = true;
  }
}

const metadata: FileMetadata = {
  files: [],
  totalSize: 0,
  protocolVersion: 2,
};

const createHarness = () => {
  const registry = createReceiverSessionRegistry();
  const commitGate = createRouteCommitGate();
  const connectionIds = new Map<string, string>();
  const committedRoutes: Array<{
    peerId: string;
    receiverSessionId: string;
    selectedKind: 'all' | 'relay';
  }> = [];

  const handler = createSenderRouteHandshakeHandler({
    registry,
    commitGate,
    metadata,
    deviceName: 'sender-device',
    getConnectionId: (conn) => {
      const existing = connectionIds.get(conn.peer);
      if (existing) {
        return existing;
      }
      const created = `conn-${conn.peer}`;
      connectionIds.set(conn.peer, created);
      return created;
    },
    onRouteCommitted: ({ conn, receiverSessionId, selectedKind }) => {
      committedRoutes.push({
        peerId: conn.peer,
        receiverSessionId,
        selectedKind,
      });
    },
  });

  return {
    registry,
    commitGate,
    committedRoutes,
    handle(conn: FakeConnection, message: P2PMessage) {
      return handler.handleMessage(conn, message);
    },
  };
};

const sendRouteProbe = (
  handle: (conn: FakeConnection, message: P2PMessage) => boolean,
  conn: FakeConnection,
  payload: {
    receiverSessionId: string;
    attemptId: string;
    attemptKind: 'all' | 'relay';
  }
) => {
  const handled = handle(conn, {
    type: 'ROUTE_PROBE',
    payload: {
      ...payload,
      deviceName: 'receiver-device',
    },
  });

  assert.equal(handled, true);
};

const commitWinner = (
  handle: (conn: FakeConnection, message: P2PMessage) => boolean,
  conn: FakeConnection,
  payload: {
    receiverSessionId: string;
    attemptId: string;
    selectedKind: 'all' | 'relay';
  }
) => {
  const handled = handle(conn, {
    type: 'ROUTE_COMMIT',
    payload,
  });

  assert.equal(handled, true);
};

test('relay can open first but all still wins before the grace window expires', () => {
  const harness = createHarness();
  const receiverSessionId = 'receiver-a';
  const relayConn = new FakeConnection('peer-relay');
  const allConn = new FakeConnection('peer-all');

  sendRouteProbe(harness.handle, relayConn, {
    receiverSessionId,
    attemptId: 'relay-1',
    attemptKind: 'relay',
  });
  sendRouteProbe(harness.handle, allConn, {
    receiverSessionId,
    attemptId: 'all-1',
    attemptKind: 'all',
  });

  assert.deepEqual(relayConn.sent.map((message) => message.type), ['ROUTE_READY']);
  assert.deepEqual(allConn.sent.map((message) => message.type), ['ROUTE_READY']);

  const scheduledCommits: Array<() => void> = [];
  let winner: { kind: 'all' | 'relay'; attemptId: string } | null = null;

  const arbiter = createReceiveRouteArbiter({
    p2pGraceWindowMs: 1500,
    onCommit: (result) => {
      winner = result;
    },
    schedule: (_ms, fn) => {
      scheduledCommits.push(fn);
      return 1;
    },
    clearScheduled: () => {
      scheduledCommits.length = 0;
    },
  });

  arbiter.markAttemptReady('relay-1', 'relay', {
    isDirect: false,
    isLanDirect: false,
  });
  assert.equal(winner, null);
  assert.equal(scheduledCommits.length, 1);

  arbiter.markAttemptReady('all-1', 'all', {
    isDirect: true,
    isLanDirect: false,
  });

  assert.deepEqual(winner, {
    kind: 'all',
    attemptId: 'all-1',
  });
  assert.equal(scheduledCommits.length, 0);

  commitWinner(harness.handle, allConn, {
    receiverSessionId,
    attemptId: 'all-1',
    selectedKind: 'all',
  });

  assert.deepEqual(allConn.sent.map((message) => message.type), [
    'ROUTE_READY',
    'DEVICE_INFO',
    'METADATA',
  ]);
  assert.deepEqual(relayConn.sent.map((message) => message.type), ['ROUTE_READY']);
  assert.deepEqual(harness.committedRoutes, [
    {
      peerId: 'peer-all',
      receiverSessionId,
      selectedKind: 'all',
    },
  ]);
});

test('relay wins when all never becomes ready before the grace window expires', () => {
  const harness = createHarness();
  const receiverSessionId = 'receiver-b';
  const relayConn = new FakeConnection('peer-relay-only');

  sendRouteProbe(harness.handle, relayConn, {
    receiverSessionId,
    attemptId: 'relay-1',
    attemptKind: 'relay',
  });

  const scheduledCommits: Array<() => void> = [];
  let winner: { kind: 'all' | 'relay'; attemptId: string } | null = null;

  const arbiter = createReceiveRouteArbiter({
    p2pGraceWindowMs: 900,
    onCommit: (result) => {
      winner = result;
    },
    schedule: (_ms, fn) => {
      scheduledCommits.push(fn);
      return 1;
    },
    clearScheduled: () => {
      scheduledCommits.length = 0;
    },
  });

  arbiter.markAttemptReady('relay-1', 'relay', {
    isDirect: false,
    isLanDirect: false,
  });
  assert.equal(winner, null);
  assert.equal(scheduledCommits.length, 1);

  scheduledCommits[0]!();

  assert.deepEqual(winner, {
    kind: 'relay',
    attemptId: 'relay-1',
  });

  commitWinner(harness.handle, relayConn, {
    receiverSessionId,
    attemptId: 'relay-1',
    selectedKind: 'relay',
  });

  assert.deepEqual(relayConn.sent.map((message) => message.type), [
    'ROUTE_READY',
    'DEVICE_INFO',
    'METADATA',
  ]);
  assert.deepEqual(harness.committedRoutes, [
    {
      peerId: 'peer-relay-only',
      receiverSessionId,
      selectedKind: 'relay',
    },
  ]);
});

test('different receiver sessions can commit different route kinds in the same share', () => {
  const harness = createHarness();
  const receiverAConn = new FakeConnection('peer-a');
  const receiverBConn = new FakeConnection('peer-b');

  sendRouteProbe(harness.handle, receiverAConn, {
    receiverSessionId: 'receiver-a',
    attemptId: 'all-a',
    attemptKind: 'all',
  });
  sendRouteProbe(harness.handle, receiverBConn, {
    receiverSessionId: 'receiver-b',
    attemptId: 'relay-b',
    attemptKind: 'relay',
  });

  commitWinner(harness.handle, receiverAConn, {
    receiverSessionId: 'receiver-a',
    attemptId: 'all-a',
    selectedKind: 'all',
  });
  commitWinner(harness.handle, receiverBConn, {
    receiverSessionId: 'receiver-b',
    attemptId: 'relay-b',
    selectedKind: 'relay',
  });

  assert.deepEqual(receiverAConn.sent.map((message) => message.type), [
    'ROUTE_READY',
    'DEVICE_INFO',
    'METADATA',
  ]);
  assert.deepEqual(receiverBConn.sent.map((message) => message.type), [
    'ROUTE_READY',
    'DEVICE_INFO',
    'METADATA',
  ]);
  assert.equal(harness.commitGate.canSendMetadata('receiver-a'), true);
  assert.equal(harness.commitGate.canSendMetadata('receiver-b'), true);
  assert.deepEqual(harness.committedRoutes, [
    {
      peerId: 'peer-a',
      receiverSessionId: 'receiver-a',
      selectedKind: 'all',
    },
    {
      peerId: 'peer-b',
      receiverSessionId: 'receiver-b',
      selectedKind: 'relay',
    },
  ]);
});
