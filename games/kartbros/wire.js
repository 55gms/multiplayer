// Kart Bros's wire format, read from its build (Unity 6, IL2CPP, MemoryPack).
//
// Every WebSocket message from the server holds one or more frames, each
// prefixed with its length (uint16 LE). A client message is one frame with
// no prefix. A frame starts with its kind:
//   1 client -> server message   [1][id u32][payload]
//   2 server -> client message   [2][id u32][payload]
//   3 to every other member      [3][id u32][payload]
//   4 the game's own RPCs        [4][id u32][payload in the game's serializer], for every other member
//   5 relayed to a member        [5][sender player id][host epoch][the sender's frame]
//   6 sequenced                  [6][seq u32][frame]: counted per direction so a
//                                 reconnecting client can ask for what it missed
// A message id is FNV-1a (32-bit) of its registered name ("session_joined").
// Payloads are MemoryPack: a struct whose fields are all unmanaged is its raw
// memory (C# layout, padded); any other is a member-count byte and the fields
// in order. Strings are int32 ~utf8Length, int32 charLength, utf8 bytes (-1
// null, 0 empty); arrays are int32 count (-1 null) and the elements.

export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (const c of Buffer.from(text)) {
    h ^= c;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

// Field lists from the game's message structs, in declaration order.
const SCHEMAS = {
  ping: [],
  pong: [],
  protocol_hello: [["protocolHash", "ulong"], ["clientNetworkVersion", "string"]],
  client_capabilities: [["capabilities", "uint"]],
  create_session: [["sessionId", "string"], ["playerName", "string"], ["broId", "string"], ["flagId", "string"], ["networkVersion", "string"], ["gameId", "string"]],
  join_session: [["sessionId", "string"], ["playerName", "string"], ["broId", "string"], ["flagId", "string"], ["networkVersion", "string"], ["gameId", "string"]],
  session_created: [["sessionId", "string"], ["clientId", "string"], ["playerId", "byte"]],
  session_host_state: [["hostPlayerId", "byte"], ["hostEpoch", "uint"], ["sessionCapabilities", "uint"]],
  session_resume_token: [["token", "byte[]"]],
  session_roles: [["spectatorIds", "byte[]"], ["yourRole", "byte"]],
  session_joined: [["sessionId", "string"], ["clientId", "string"], ["playerId", "byte"], ["clientCount", "int"], ["players", "PlayerInfoEntry[]"], ["raceActive", "bool"], ["rematchInProgress", "bool"], ["isWaiting", "bool"], ["currentTrackId", "string"], ["currentBotDifficulty", "string"], ["currentBotCount", "int"]],
  client_joined: [["clientId", "string"], ["sessionId", "string"], ["clientCount", "int"], ["playerId", "byte"], ["playerName", "string"], ["broId", "string"], ["flagId", "string"], ["networkVersion", "string"], ["isWaiting", "bool"]],
  client_disconnected: [["clientId", "string"], ["sessionId", "string"], ["clientCount", "int"], ["playerId", "byte"], ["wasWaiting", "bool"]],
  host_changed: [["hostPlayerId", "byte"], ["hostEpoch", "uint"], ["previousHostPlayerId", "byte"], ["reason", "byte"]],
  resume_session: [["sessionId", "string"], ["gameId", "string"], ["token", "byte[]"], ["lastSeenSeq", "uint"], ["lastClientSeq", "uint"], ["networkVersion", "string"], ["reloaded", "bool"]],
  session_resumed: [["playerId", "byte"], ["gap", "bool"], ["replayCount", "uint"], ["seqBase", "uint"], ["lastClientSeq", "uint"], ["token", "byte[]"]],
  session_resume_failed: [["reason", "byte"]],
  session_replaced: [],
  leave_session: [],
  host_transfer_request: [["preferredPlayerId", "byte"]],
  host_claim: [],
  host_transfer_refused: [],
  set_member_role: [["role", "byte"]],
  member_role: [["playerId", "byte"], ["role", "byte"]],
  member_role_refused: [["reason", "byte"]],
  member_away_report: [["away", "bool"]],
  member_away: [["playerId", "byte"], ["away", "bool"]],
  member_connection: [["playerId", "byte"], ["connected", "bool"]],
  session_ended: [["reason", "string"], ["sessionId", "string"]],
  invalid_session: [],
  session_full: [],
  error: [["message", "string"]],
  protocol_mismatch: [["serverHash", "ulong"], ["serverInfo", "string"]],
  race_already_started: [],
  race_countdown_start: [["serverTime", "double"], ["startTime", "double"], ["trackId", "string"], ["botDifficulty", "string"], ["botCount", "int"], ["countdownDuration", "float"]],
  race_start_roster: [["startDelay", "float"], ["racerIds", "byte[]"]],
  player_finished: [["playerId", "byte"], ["finishTime", "double"]],
  race_finished: [["finishOrder", "byte[]"], ["disconnectedPlayers", "byte[]"]],
  rematch_ready: [["playerId", "byte"]],
  rematch_status_update: [["totalPlayers", "int"], ["readyPlayerIds", "byte[]"], ["allReady", "bool"], ["waitingPlayers", "int"]],
  race_timeout_update: [["remainingTime", "int"]],
  request_race_order: [["sessionId", "string"]],
  race_order_response: [["sessionId", "string"], ["finishOrder", "byte[]"]],
  game_start: [["startDelay", "float"]],
  config_received: [["playerId", "byte"], ["isReady", "bool"], ["clientTime", "double"]],
  lobby_ready: [["playerId", "byte"], ["ready", "bool"]],
  player_info: [["playerId", "byte"], ["playerName", "string"], ["broId", "string"], ["flagId", "string"], ["networkVersion", "string"]],
  member_retired: [["playerId", "byte"]],
  rematch_triggered: [["hostPlayerId", "byte"]],
  race_start_refused: [["reason", "byte"]],
  race_start_expired: [],
};
const STRUCTS = {
  PlayerInfoEntry: [["playerId", "byte"], ["playerName", "string"], ["broId", "string"], ["flagId", "string"], ["isWaiting", "bool"]],
};

export const ID = {};
export const NAME = {};
for (const name of Object.keys(SCHEMAS)) {
  ID[name] = fnv1a(name);
  NAME[ID[name]] = name;
}

const SIZE = { byte: 1, bool: 1, ushort: 2, int: 4, uint: 4, float: 4, long: 8, ulong: 8, double: 8 };
const isUnmanaged = (fields) => fields.every(([, t]) => SIZE[t]);

function layout(fields) {
  let offset = 0;
  let align = 1;
  const at = [];
  for (const [name, type] of fields) {
    const size = SIZE[type];
    offset = Math.ceil(offset / size) * size;
    at.push([name, type, offset]);
    offset += size;
    align = Math.max(align, size);
  }
  return { at, size: Math.max(1, Math.ceil(offset / align) * align) };
}

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  need(n) {
    if (n < 0 || this.pos + n > this.buf.length) throw new RangeError("short message");
  }
  prim(type, at = this.pos) {
    this.need(at - this.pos + SIZE[type]);
    const b = this.buf;
    switch (type) {
      case "byte": return b[at];
      case "bool": return b[at] !== 0;
      case "ushort": return b.readUInt16LE(at);
      case "int": return b.readInt32LE(at);
      case "uint": return b.readUInt32LE(at);
      case "float": return b.readFloatLE(at);
      case "long": return b.readBigInt64LE(at);
      case "ulong": return b.readBigUInt64LE(at);
      case "double": return b.readDoubleLE(at);
    }
  }
  int() {
    const v = this.prim("int");
    this.pos += 4;
    return v;
  }
  string() {
    const head = this.int();
    if (head === -1) return null;
    if (head === 0) return "";
    if (head < 0) {
      const bytes = ~head;
      this.int();
      this.need(bytes);
      const s = this.buf.toString("utf8", this.pos, this.pos + bytes);
      this.pos += bytes;
      return s;
    }
    this.need(head * 2);
    const s = this.buf.toString("utf16le", this.pos, this.pos + head * 2);
    this.pos += head * 2;
    return s;
  }
  value(type) {
    if (SIZE[type]) {
      const v = this.prim(type);
      this.pos += SIZE[type];
      return v;
    }
    if (type === "string") return this.string();
    if (type === "byte[]") {
      const n = this.int();
      if (n === -1) return null;
      this.need(n);
      const v = [...this.buf.subarray(this.pos, this.pos + n)];
      this.pos += n;
      return v;
    }
    throw new TypeError(`cannot read ${type}`);
  }
  fields(fields) {
    if (isUnmanaged(fields)) {
      const { at, size } = layout(fields);
      this.need(size);
      const out = {};
      for (const [name, type, offset] of at) out[name] = this.prim(type, this.pos + offset);
      this.pos += size;
      return out;
    }
    const count = this.buf[this.pos++];
    if (count === undefined) throw new RangeError("short message");
    const out = {};
    // A newer client may send more members than we know; the known ones come first.
    for (const [name, type] of fields.slice(0, count)) out[name] = this.value(type);
    return out;
  }
}

class Writer {
  constructor() {
    this.parts = [];
  }
  raw(bytes) {
    this.parts.push(Buffer.from(bytes));
    return this;
  }
  prim(type, v = 0) {
    const b = Buffer.alloc(SIZE[type]);
    switch (type) {
      case "byte": b[0] = v; break;
      case "bool": b[0] = v ? 1 : 0; break;
      case "ushort": b.writeUInt16LE(v); break;
      case "int": b.writeInt32LE(v | 0); break;
      case "uint": b.writeUInt32LE(v >>> 0); break;
      case "float": b.writeFloatLE(v); break;
      case "long": b.writeBigInt64LE(BigInt(v)); break;
      case "ulong": b.writeBigUInt64LE(BigInt(v)); break;
      case "double": b.writeDoubleLE(v); break;
    }
    return this.raw(b);
  }
  string(s) {
    if (s == null) return this.prim("int", -1);
    if (s === "") return this.prim("int", 0);
    const bytes = Buffer.from(s);
    return this.prim("int", ~bytes.length).prim("int", s.length).raw(bytes);
  }
  value(type, v) {
    if (SIZE[type]) return this.prim(type, v ?? 0);
    if (type === "string") return this.string(v);
    if (v == null) return this.prim("int", -1);
    if (type === "byte[]") return this.prim("int", v.length).raw(v);
    const struct = STRUCTS[type.slice(0, -2)];
    this.prim("int", v.length);
    for (const item of v) this.fields(struct, item);
    return this;
  }
  fields(fields, obj = {}) {
    if (isUnmanaged(fields)) {
      const { at, size } = layout(fields);
      const b = Buffer.alloc(size);
      for (const [name, type, offset] of at) new Writer().prim(type, obj[name] ?? 0).finish().copy(b, offset);
      return this.raw(b);
    }
    this.raw([fields.length]);
    for (const [name, type] of fields) this.value(type, obj[name]);
    return this;
  }
  finish() {
    return Buffer.concat(this.parts);
  }
}

export function decode(name, payload) {
  return new Reader(payload).fields(SCHEMAS[name]);
}

export function encode(name, obj) {
  return new Writer().fields(SCHEMAS[name], obj).finish();
}

// [2][id][payload]: a server message.
export function serverFrame(name, obj) {
  const head = Buffer.alloc(5);
  head[0] = 2;
  head.writeUInt32LE(ID[name], 1);
  return Buffer.concat([head, encode(name, obj)]);
}

// [1][id][payload]: a client message, as the server passes some of them on.
export function clientFrame(name, obj) {
  return Buffer.concat([Buffer.from([1]), serverFrame(name, obj).subarray(1)]);
}

export function sequenced(seq, frame) {
  const head = Buffer.alloc(5);
  head[0] = 6;
  head.writeUInt32LE(seq >>> 0, 1);
  return Buffer.concat([head, frame]);
}

// [5][sender][epoch][the sender's own frame]
export function relayed(sender, epoch, frame) {
  return Buffer.concat([Buffer.from([5, sender, epoch & 0xff]), frame]);
}

// One WebSocket message carrying frames, each prefixed by its uint16 length.
export function pack(frames) {
  const parts = [];
  for (const f of frames) {
    const len = Buffer.alloc(2);
    len.writeUInt16LE(f.length);
    parts.push(len, f);
  }
  return Buffer.concat(parts);
}
