// The reliable stream inside type-1 packets, both directions.
//
// Packet body (after the cipher): [0][varint ack]{[varint seq][message]}*, every byte
// after the first XORed with STREAM_MASK[i & 255] where i counts from that byte.
// seq 0 marks an unreliable message; a reliable one carries 1, 2, 3...
// The server sends [1][varint ack][stream...] the same way, unencrypted.

// Client memory 49632 in build 2749f7ba: XORed over the client's stream bytes.
export const STREAM_MASK = Buffer.from([
  32, 3, 233, 163, 177, 114, 240, 119, 30, 29, 61, 191, 92, 78, 179, 42, 225, 18, 217, 166,
  153, 194, 98, 86, 246, 68, 190, 210, 104, 181, 4, 38, 147, 244, 113, 153, 10, 127, 179, 1,
  210, 54, 222, 182, 14, 159, 49, 68, 143, 71, 0, 158, 185, 161, 31, 221, 241, 111, 230, 118,
  39, 20, 98, 93, 77, 80, 241, 161, 125, 236, 197, 0, 25, 187, 45, 134, 176, 65, 33, 98,
  243, 246, 86, 181, 191, 124, 62, 98, 85, 109, 133, 157, 151, 98, 7, 65, 230, 155, 145, 125,
  120, 134, 111, 193, 65, 117, 140, 162, 179, 111, 80, 64, 249, 210, 146, 164, 197, 22, 182, 236,
  7, 17, 202, 222, 182, 195, 146, 140, 50, 36, 161, 156, 160, 235, 208, 8, 89, 158, 0, 253,
  116, 222, 136, 101, 153, 164, 219, 43, 246, 118, 114, 175, 81, 2, 248, 146, 239, 62, 122, 43,
  160, 22, 57, 201, 39, 112, 85, 59, 176, 160, 139, 236, 137, 216, 64, 220, 215, 104, 105, 18,
  245, 73, 171, 46, 169, 10, 100, 241, 62, 151, 60, 105, 165, 117, 220, 187, 137, 107, 61, 249,
  251, 69, 153, 253, 106, 93, 162, 173, 100, 149, 148, 156, 253, 244, 123, 30, 211, 104, 215, 64,
  67, 81, 44, 13, 59, 97, 255, 46, 11, 108, 51, 0, 187, 82, 255, 70, 33, 25, 110, 77,
  114, 117, 226, 205, 41, 81, 49, 198, 117, 34, 251, 245, 16, 80, 147, 185,
]);

// The client's type-1 body with its stream unmasked (a new Buffer).
export function unmaskClient(body) {
  const out = Buffer.from(body);
  for (let i = 1; i < out.length; i++) out[i] ^= STREAM_MASK[(i - 1) & 255];
  return out;
}

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

function cstring(buf, pos) {
  const end = buf.indexOf(0, pos);
  if (end < 0) return [null, buf.length];
  return [buf.toString("utf8", pos, end), end + 1];
}

// The client's messages known so far, by id: how to read the payload.
const CLIENT_MESSAGES = {
  10: (buf, pos) => [{ name: "start" }, pos],
  1: (buf, pos) => [{ name: "play" }, pos],
  3: (buf, pos) => [{ name: "m3" }, pos],
  4: (buf, pos) => [{ name: "leave" }, pos], // sent when the client gives up a dead digger
  24: (buf, pos) => [{ name: "m24" }, pos],
  34: (buf, pos) => [{ name: "m34" }, pos],
  21: (buf, pos) => [{ name: "m21", byte: buf[pos] }, pos + 1],
  // the shop's Buy: the skin's id (skins.js)
  2: (buf, pos) => {
    let item;
    [item, pos] = cstring(buf, pos);
    return [{ name: "buy", item }, pos];
  },
  7: (buf, pos) => {
    let v;
    [v, pos] = readVarint(buf, pos);
    return [{ name: "m7", v }, pos];
  },
  14: (buf, pos) => {
    let text;
    [text, pos] = cstring(buf, pos);
    return [{ name: "m14", text }, pos];
  },
  15: (buf, pos) => {
    const parts = [];
    for (let i = 0; i < 4; i++) {
      let t;
      [t, pos] = cstring(buf, pos);
      parts.push(t);
    }
    return [{ name: "report", parts }, pos];
  },
  // the login the client keeps (localStorage oauth2_data_DO_NOT_SHARE), sent on
  // connect: provider, token, user id, and the expiry (ms)
  28: (buf, pos) => {
    const parts = [];
    for (let i = 0; i < 3; i++) {
      let t;
      [t, pos] = cstring(buf, pos);
      parts.push(t);
    }
    const expires = pos + 8 <= buf.length ? buf.readDoubleLE(pos) : 0;
    return [{ name: "login", parts, expires }, pos + 8];
  },
  13: (buf, pos) => {
    const platform = buf[pos++];
    let userAgent, token, language;
    [userAgent, pos] = cstring(buf, pos);
    [token, pos] = cstring(buf, pos);
    [language, pos] = cstring(buf, pos);
    return [{ name: "client", platform, userAgent, token, language }, pos];
  },
  // the skins the client has equipped: face and spinner indexes (skins.js), 0 for none
  20: (buf, pos) => [{ name: "equip", face: buf[pos] ?? 0, spinner: buf[pos + 1] ?? 0 }, pos + 2],
  // mouse/keys, sent unreliably every packet: [varint flags][f32 angle][f32 distance]
  // flags: 65536 always, 1 left button
  5: (buf, pos) => {
    let flags;
    [flags, pos] = readVarint(buf, pos);
    if (pos + 8 > buf.length) return [{ name: "input", flags, angle: 0, distance: 0 }, buf.length];
    const angle = buf.readFloatLE(pos);
    const distance = buf.readFloatLE(pos + 4);
    return [{ name: "input", flags, angle: Number.isFinite(angle) ? angle : 0, distance: Number.isFinite(distance) ? distance : 0 }, pos + 8];
  },
  23: (buf, pos) => [{ name: "keepalive" }, pos], // every few seconds
  29: (buf, pos) => [{ name: "m29" }, pos], // after a saved login arrives (message 12)
  16: (buf, pos) => {
    let nickname;
    [nickname, pos] = cstring(buf, pos);
    return [{ name: "nickname", nickname }, pos];
  },
};

// Read the messages of an unmasked client stream body (after its first byte, the ack).
// Stops at the first message whose id is not known yet.
export function readClientMessages(buf, pos) {
  const out = [];
  while (pos < buf.length) {
    let seq, id;
    [seq, pos] = readVarint(buf, pos);
    [id, pos] = readVarint(buf, pos);
    const read = CLIENT_MESSAGES[id];
    if (!read) {
      out.push({ seq, id, unknown: buf.subarray(pos).toString("hex") });
      break;
    }
    let msg;
    [msg, pos] = read(buf, pos);
    out.push({ seq, id, ...msg });
  }
  return out;
}
