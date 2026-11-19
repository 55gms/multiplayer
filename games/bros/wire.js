// Byte layout shared by Blue Wizard's sports games (BasketBros, SoccerBros,
// BaseballBros, FootballBros, HockeyBros). They are Haxe builds: every message is one
// binary WebSocket frame of little-endian int32s, bytes and raw strings,
// starting with an int32 message type. See README.md for each message.

export const MAX_NAME = 20;
export const MAX_CHAT = 100;
const MAX_PERKS = 64;

export class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }

  left() {
    return this.buf.length - this.pos;
  }

  int() {
    if (this.left() < 4) throw new RangeError("short message");
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  // A missing trailing int reads as 0 (inputs are sometimes cut short).
  intOr0() {
    return this.left() >= 4 ? this.int() : 0;
  }

  bytes(n) {
    if (n < 0 || this.left() < n) throw new RangeError("short message");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  rest(keep = 0) {
    return this.bytes(Math.max(0, this.left() - keep));
  }
}

export class Writer {
  constructor() {
    this.parts = [];
  }

  int(v) {
    const b = Buffer.allocUnsafe(4);
    b.writeInt32LE(v | 0);
    this.parts.push(b);
    return this;
  }

  bytes(b) {
    this.parts.push(Buffer.from(b));
    return this;
  }

  // Length-prefixed, as the games read names and chat (readInt32 then readString).
  string(s) {
    const b = Buffer.from(s, "utf8");
    return this.int(b.length).bytes(b);
  }

  finish() {
    return Buffer.concat(this.parts);
  }
}

// Printable ASCII only: the games draw text with bitmap fonts, and the
// original server upper-cases names in the classic games.
export function cleanText(bytes, max) {
  return Buffer.from(bytes)
    .toString("latin1")
    .replace(/[^\x20-\x7e]/g, "")
    .trim()
    .slice(0, max);
}

// The join message (type 1) every game sends when its socket opens:
//   int skin (team index in BaseballBros/FootballBros/HockeyBros), int wins, int losses,
//   int perkCount, perkCount bytes, 6 outfit bytes, 4 ints of the player's
//   guid, int privateGameNumber (0 = public), raw name bytes to the end
//   (FootballBros and HockeyBros add an int 2 after the name).
// The server echoes everything up to the guid to the other players as is.
export function readJoin(r, { trailingInt = false } = {}) {
  const skin = r.int();
  const wins = r.int();
  const losses = r.int();
  const perkCount = r.int();
  if (perkCount < 0 || perkCount > MAX_PERKS) throw new RangeError("bad perk count");
  const perks = Buffer.from(r.bytes(perkCount));
  const outfit = Buffer.from(r.bytes(6));
  r.bytes(16); // guid: unused here
  const room = r.int() & 0xffffff;
  const name = cleanText(r.rest(trailingInt && r.left() >= 4 ? 4 : 0), MAX_NAME);
  return { skin, wins, losses, perks, outfit, room, name };
}
