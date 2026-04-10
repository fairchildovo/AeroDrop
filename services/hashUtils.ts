const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export const crc32Init = (): number => 0xffffffff;

export const crc32Update = (state: number, data: Uint8Array): number => {
  let crc = state >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return crc >>> 0;
};

export const crc32FinalHex = (state: number): string => {
  return ((state ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
};
