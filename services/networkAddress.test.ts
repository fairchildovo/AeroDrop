import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyCandidatePair, isPrivateIP } from './networkAddress.ts';

test('classifies private IPv4, IPv6, and mDNS addresses without truncating IPv6', () => {
  const cases: Array<[string, boolean]> = [
    ['10.1.2.3', true],
    ['172.31.255.1:5000', true],
    ['192.168.1.1', true],
    ['127.0.0.2', true],
    ['169.254.4.2', true],
    ['[fe80::1]:5000', true],
    ['febf::1', true],
    ['fc00::1', true],
    ['fd12:3456::1%eth0', true],
    ['::ffff:192.168.1.5', true],
    ['peer-123.local', true],
    ['8.8.8.8', false],
    ['2001:4860:4860::8888', false],
  ];

  for (const [address, expected] of cases) {
    assert.equal(isPrivateIP(address), expected, address);
  }
});

test('relay wins route classification before address checks', () => {
  assert.equal(classifyCandidatePair({
    localAddress: '192.168.1.2',
    remoteAddress: '192.168.1.3',
    localCandidateType: 'host',
    remoteCandidateType: 'relay',
  }), 'TURN');

  assert.equal(classifyCandidatePair({
    localAddress: 'fd00::1',
    remoteAddress: 'peer.local',
    localCandidateType: 'host',
    remoteCandidateType: 'host',
  }), 'LAN');

  assert.equal(classifyCandidatePair({
    localAddress: '192.168.1.2',
    remoteAddress: '203.0.113.1',
    localCandidateType: 'host',
    remoteCandidateType: 'srflx',
  }), 'WAN');
});
