export type CandidatePathType = 'LAN' | 'WAN' | 'TURN';

type CandidatePairAddress = {
  localAddress?: string;
  remoteAddress?: string;
  localCandidateType?: string;
  remoteCandidateType?: string;
};

const normalizeAddress = (value: string) => {
  let address = value.trim().toLowerCase();
  const bracketed = address.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) {
    address = bracketed[1];
  } else {
    const ipv4WithPort = address.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
    if (ipv4WithPort) {
      address = ipv4WithPort[1];
    }
  }

  return address.replace(/%[^%]+$/, '');
};

const parseIpv4 = (address: string) => {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  const octets = parts.map((part) => Number(part));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
};

export const isPrivateIP = (value: string): boolean => {
  if (!value) return false;
  const address = normalizeAddress(value);

  if (address === 'localhost' || address.endsWith('.local')) return true;
  if (address === '::1') return true;

  if (address.startsWith('::ffff:')) {
    return isPrivateIP(address.slice('::ffff:'.length));
  }

  const ipv4 = parseIpv4(address);
  if (ipv4) {
    const [first, second] = ipv4;
    return first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }

  const firstHextet = Number.parseInt(address.split(':')[0], 16);
  if (!Number.isFinite(firstHextet)) return false;
  return (firstHextet & 0xffc0) === 0xfe80 || (firstHextet & 0xfe00) === 0xfc00;
};

export const classifyCandidatePair = ({
  localAddress = '',
  remoteAddress = '',
  localCandidateType = '',
  remoteCandidateType = '',
}: CandidatePairAddress): CandidatePathType => {
  if (localCandidateType.toLowerCase() === 'relay' || remoteCandidateType.toLowerCase() === 'relay') {
    return 'TURN';
  }

  return isPrivateIP(localAddress) && isPrivateIP(remoteAddress) ? 'LAN' : 'WAN';
};
