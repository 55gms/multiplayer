// The digdig.io client scrambles every packet it sends; the server's own packets
// are plain. This undoes the client's side. Worked out against the client build
// 2749f7ba (see games/digdig/README.md).
//
// A packet is [type][body]. The type goes through a fixed substitution. Types in
// RAW are sent as they are, body included (48 is the hello). For every other type
// the body is XORed with a 7-byte key that repeats, and the connection's state
// moves on one step for each such packet.

const TYPE_TO_WIRE = [
  94, 4, 34, 3, 40, 8, 19, 46, 84, 51, 45, 91, 56, 57, 72, 73, 18, 26, 10, 28, 74, 55, 85, 24, 47, 61, 42, 76, 22, 49, 78,
  43, 60, 99, 36, 83, 12, 88, 38, 39, 1, 81, 54, 13, 52, 62, 7, 86, 48, 50, 17, 27, 53, 70, 98, 9, 2, 15, 30, 23, 32, 90,
  63, 82, 64, 65, 66, 67, 44, 97, 80, 89, 96, 37, 20, 69, 75, 11, 6, 79, 59, 29, 95, 71, 16, 33, 35, 87, 21, 5, 58, 77,
  14, 25, 0, 41, 92, 93, 68, 31,
];
const WIRE_TO_TYPE = new Array(256).fill(-1);
TYPE_TO_WIRE.forEach((w, t) => (WIRE_TO_TYPE[w] = t));
export const RAW = new Set([3, 48, 64, 65, 66, 67]);

// The state is a number below M; each scrambled packet moves it to next(state).
const M = 0x7ffffffen;
const STEP_ADD = 0x42d5c88fn;
const STEP_MUL = 0x72af1866n;
export const INITIAL_STATE = 0x1cf43c04;

// Key byte j is the top byte of (BETA[j] + ALPHA[j] * state) mod (2^30 - 1), low bit set.
const N = (1n << 30n) - 1n;
const ALPHA = [0x171f0ac3n, 0x290015adn, 0x2424bddcn, 0x82f53b8n, 0x2c2f80d6n, 0x19f2af18n, 0x1b35269n];
const BETA = [0x58461a7n, 0x2ec2da5cn, 0x9c5d11an, 0x3acbc641n, 0x1944386en, 0x23c2d5c8n, 0xa001d4bn];

export function nextState(state) {
  return Number((STEP_ADD + STEP_MUL * (BigInt(state >>> 0) % M)) % M);
}

export function keyFor(state) {
  const s = BigInt(state >>> 0) % M;
  const key = Buffer.alloc(7);
  for (let j = 0; j < 7; j++) key[j] = Number((((BETA[j] + ALPHA[j] * s) % N) >> 22n) & 255n) | 1;
  return key;
}

// One per client connection: call open() on each packet the client sends, in order.
export class ClientCipher {
  constructor(state = INITIAL_STATE) {
    this.state = state;
  }

  // Returns { type, body } with the body unscrambled (a new Buffer), or null for a
  // type byte the client never sends.
  open(packet) {
    if (!packet.length) return null;
    const type = WIRE_TO_TYPE[packet[0]];
    if (type < 0) return null;
    if (RAW.has(type)) return { type, body: Buffer.from(packet.subarray(1)) };
    const key = keyFor(this.state);
    this.state = nextState(this.state);
    const body = Buffer.allocUnsafe(packet.length - 1);
    for (let i = 0; i < body.length; i++) body[i] = packet[i + 1] ^ key[i % 7];
    return { type, body };
  }

  // The client's own direction, for tools that act as a client.
  seal(type, body) {
    const out = Buffer.allocUnsafe(body.length + 1);
    out[0] = TYPE_TO_WIRE[type];
    if (RAW.has(type)) {
      body.copy(out, 1);
      return out;
    }
    const key = keyFor(this.state);
    this.state = nextState(this.state);
    for (let i = 0; i < body.length; i++) out[i + 1] = body[i] ^ key[i % 7];
    return out;
  }
}

// The server's direction uses the same key and step, from its own state, but the
// type byte goes through one of three permutations picked by state % 3. Wire bytes
// in SERVER_RAW pass through untouched (body too) and leave the state alone; type 0
// is the disconnect.
const SERVER_WIRE_TO_TYPE = [
  [
    0, 13, 16, 67, 4, 87, 86, 33, 38, 51, 99, 77, 56, 3, 12, 15, 14, 62, 90, 46, 84, 36, 65, 70, 83, 61, 76, 19, 11, 96, 42,
    22, 74, 31, 34, 89, 1, 37, 88, 30, 18, 24, 93, 98, 43, 52, 55, 59, 8, 20, 66, 60, 79, 53, 6, 73, 2, 80, 58, 10, 81, 75,
    26, 82, 64, 97, 35, 27, 40, 69, 25, 49, 45, 9, 32, 5, 17, 28, 95, 91, 78, 72, 85, 41, 71, 63, 29, 47, 68, 50, 48, 21, 7,
    39, 44, 57, 92, 23, 94, 54,
  ],
  [
    0, 55, 14, 9, 4, 86, 22, 25, 68, 79, 7, 83, 2, 73, 56, 37, 12, 93, 8, 81, 76, 19, 5, 59, 82, 99, 30, 60, 24, 97, 20, 75,
    74, 61, 34, 98, 46, 69, 40, 49, 48, 63, 84, 78, 80, 13, 72, 96, 88, 26, 44, 91, 3, 53, 31, 45, 16, 50, 58, 92, 21, 54,
    39, 28, 64, 87, 43, 51, 90, 15, 10, 62, 1, 52, 32, 6, 42, 41, 35, 67, 66, 36, 11, 85, 17, 77, 65, 29, 18, 94, 38, 27,
    70, 71, 57, 89, 23, 47, 95, 33,
  ],
  [
    0, 45, 56, 79, 4, 65, 5, 99, 90, 67, 25, 85, 14, 52, 16, 69, 2, 71, 68, 36, 42, 81, 86, 92, 11, 33, 20, 21, 82, 47, 76,
    6, 32, 54, 34, 95, 72, 15, 48, 26, 88, 28, 17, 35, 66, 73, 1, 23, 18, 30, 80, 27, 9, 53, 75, 13, 12, 44, 58, 70, 19, 31,
    49, 24, 64, 29, 78, 91, 38, 37, 7, 39, 55, 3, 74, 22, 84, 63, 98, 51, 43, 46, 83, 77, 93, 41, 87, 97, 8, 57, 40, 60, 10,
    62, 50, 94, 59, 96, 89, 61,
  ],
];
const SERVER_TYPE_TO_WIRE = SERVER_WIRE_TO_TYPE.map((p) => {
  const inv = new Array(100);
  p.forEach((t, w) => (inv[t] = w));
  return inv;
});
export const SERVER_RAW = new Set([0, 4, 64]);
export const SERVER_INITIAL_STATE = 0x09bc0703;

export class ServerCipher {
  constructor(state = SERVER_INITIAL_STATE) {
    this.state = state;
  }

  seal(type, body = Buffer.alloc(0)) {
    const out = Buffer.allocUnsafe(body.length + 1);
    if (SERVER_RAW.has(type)) {
      out[0] = type;
      body.copy(out, 1);
      return out;
    }
    out[0] = SERVER_TYPE_TO_WIRE[this.state % 3][type];
    const key = keyFor(this.state);
    this.state = nextState(this.state);
    for (let i = 0; i < body.length; i++) out[i + 1] = body[i] ^ key[i % 7];
    return out;
  }

  // What the client does with a server packet, for tools that act as a client.
  open(packet) {
    if (!packet.length) return null;
    if (SERVER_RAW.has(packet[0])) return { type: packet[0], body: Buffer.from(packet.subarray(1)) };
    if (packet[0] >= 100) return null;
    const type = SERVER_WIRE_TO_TYPE[this.state % 3][packet[0]];
    const key = keyFor(this.state);
    this.state = nextState(this.state);
    const body = Buffer.allocUnsafe(packet.length - 1);
    for (let i = 0; i < body.length; i++) body[i] = packet[i + 1] ^ key[i % 7];
    return { type, body };
  }
}
