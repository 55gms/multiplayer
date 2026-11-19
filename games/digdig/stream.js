// The reliable stream inside type-1 packets, both directions.
//
// Packet body (after the cipher): [0][varint ack]{[varint seq][message]}*, every byte
// after the first XORed with STREAM_MASK[i & 255] where i counts from that byte.
// seq 0 marks an unreliable message; a reliable one carries 1, 2, 3...
// The server sends [1][varint ack][stream...] the same way, unencrypted.

export function varint(n) {
  const out = [];
  do {
    let b = n & 127;
    n >>>= 7;
    if (n) b |= 128;
    out.push(b);
  } while (n);
  return out;
}

export function readVarint(buf, pos) {
  let v = 0, shift = 0;
  for (;;) {
    if (pos >= buf.length) return [v >>> 0, pos];
    const b = buf[pos++];
    v |= (b & 127) << shift;
    if (b < 128 || shift >= 28) return [v >>> 0, pos];
    shift += 7;
  }
}
