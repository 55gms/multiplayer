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

  // The client's own direction, for tools that speak as a client.
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
