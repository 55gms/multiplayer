// The rooms of this process, shared by the master server (matchmaking) and
// the game server (play). Memory only.
import { randomUUID } from "node:crypto";
import { GameProp } from "../../src/photon/codes.js";
import { Hashtable, Writer, byte, num, keyId } from "../../src/photon/protocol18.js";
import { MAX_ROOM_PLAYERS } from "../../src/limits.js";

const RESERVE_MS = 10_000; // a slot handed out by the master, kept until the player arrives
const EMPTY_ROOM_MS = 20_000; // a room created on the master that nobody joined
const MAX_ROOMS = 2000;
const MAX_PENDING_PER_IP = 8; // rooms made on the master that nobody has entered yet

// Memory budgets per room. A PUN game needs a small fraction of these.
export const PROPS_MAX_BYTES = 64 * 1024; // room and player properties together
export const CACHE_MAX_BYTES = 1024 * 1024; // the event cache
export const CACHE_ENTRY_MAX_BYTES = 16 * 1024;

// A whole number in [min, max], or null for anything else (floats, longs, strings).
export function int(v, min = -0x80000000, max = 0x7fffffff) {
  const n = typeof v === "number" ? v : v?.type === "byte" || v?.type === "short" ? v.v : null;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export function encodedSize(v) {
  return new Writer(64).value(v).pos;
}

// RoomOptionFlags (Param.RoomOptionFlags)
export const RoomFlag = {
  CheckUserOnJoin: 1,
  DeleteCacheOnLeave: 2,
  SuppressRoomEvents: 4,
  PublishUserId: 8,
  DeleteNullProps: 16,
  BroadcastPropsChangeToAll: 32,
};

function encoded(v) {
  return Buffer.from(new Writer(32).value(v).finish()).toString("hex");
}

// Photon compares property values by type and value.
// A room property against a lobby filter value: "=" any type, "<=" / ">="
// numbers only.
function compare(value, op, want) {
  if (op === "=") return sameValue(value, want);
  const n = typeof value === "object" && value !== null && "v" in value ? Number(value.v) : Number(value);
  if (!Number.isFinite(n)) return false;
  return op === "<=" ? n <= want : n >= want;
}

export function sameValue(a, b) {
  return encoded(a) === encoded(b);
}

export class Actor {
  constructor(actorNr, peer, props) {
    this.actorNr = actorNr;
    this.peer = peer;
    this.props = props || new Hashtable();
    this.propBytes = encodedSize(this.props);
    this.userId = peer.state.userId || "";
    this.groups = new Set();
  }
}

export class Room {
  constructor(name) {
    this.name = name;
    this.props = new Hashtable(); // custom properties (non-byte keys) and anything else the clients set
    this.maxPlayers = 0; // 0 = no limit (capped by MAX_ROOM_PLAYERS)
    this.isOpen = true;
    this.isVisible = true;
    this.listed = null; // string[] of custom keys shown in the lobby
    this.flags = RoomFlag.DeleteCacheOnLeave;
    this.lobbyName = "";
    this.lobbyType = 0;
    this.actors = new Map();
    this.nextActorNr = 1;
    this.masterActorNr = 0;
    this.cache = []; // { actorNr, code, data: Uint8Array | null (encoded value), value (decoded, for filters), global }
    this.cacheBytes = 0;
    this.propBytes = 0; // encoded size of this.props
    this.creatorIp = null;
    this.reservations = new Map(); // userId -> expiry ms
    this.created = Date.now();
    this.creatorUserId = null; // who made it on the master, until they arrive
  }

  get cap() {
    const max = this.maxPlayers > 0 ? this.maxPlayers : MAX_ROOM_PLAYERS;
    return Math.min(max, MAX_ROOM_PLAYERS);
  }

  liveReservations(exceptUserId) {
    const now = Date.now();
    let n = 0;
    for (const [userId, until] of this.reservations) {
      if (until < now) this.reservations.delete(userId);
      else if (userId !== exceptUserId) n++;
    }
    return n;
  }

  hasSpaceFor(userId) {
    return this.actors.size + this.liveReservations(userId) < this.cap;
  }

  reserve(userId, ms = RESERVE_MS) {
    if (userId) this.reservations.set(userId, Math.max(this.reservations.get(userId) || 0, Date.now() + ms));
  }

  // Room for every one of these users (a party), counting places already
  // kept for them once.
  hasSpaceForAll(userIds) {
    const now = Date.now();
    let others = 0;
    for (const [userId, until] of this.reservations) if (until >= now && !userIds.includes(userId)) others++;
    return this.actors.size + others + userIds.length <= this.cap;
  }

  // Applies a GameProperties hashtable: well-known byte keys go to fields,
  // the rest are custom properties. A null value deletes a custom property.
  applyProps(table) {
    if (!(table instanceof Hashtable)) return;
    for (const [key, value] of table) {
      const k = typeof key === "object" && key?.type === "byte" ? key.v : null;
      if (k === GameProp.MaxPlayers) {
        const max = int(value, 0, 255);
        if (max !== null) this.maxPlayers = max;
      }
      else if (k === GameProp.IsOpen) this.isOpen = value !== false;
      else if (k === GameProp.IsVisible) this.isVisible = value !== false;
      else if (k === GameProp.PropsListedInLobby) this.listed = Array.isArray(value) ? value.filter((s) => typeof s === "string") : null;
      else if (k === GameProp.MasterClientId) {
        const nr = int(value, 1);
        if (nr && this.actors.has(nr)) this.masterActorNr = nr;
      } else if (k === GameProp.PlayerCount || k === GameProp.Removed) continue;
      else if (value === null) this.props.delete(key);
      else this.props.set(key, value);
    }
    this.propBytes = encodedSize(this.props) + (this.listed ? encodedSize(this.listed) : 0);
  }

  // Would applying `table` keep the room's properties within budget?
  propsFit(table) {
    const trial = new Room("");
    for (const [k, v] of this.props) trial.props.set(k, v);
    trial.applyProps(table);
    return trial.propBytes + this.actorPropBytes() <= PROPS_MAX_BYTES;
  }

  actorPropBytes() {
    let n = 0;
    for (const a of this.actors.values()) n += a.propBytes;
    return n;
  }

  // The room's properties as clients see them in the room.
  gameProperties() {
    const out = new Hashtable();
    for (const [k, v] of this.props) out.set(k, v);
    out.set(byte(GameProp.MaxPlayers), byte(Math.min(this.maxPlayers, 255)));
    out.set(byte(GameProp.IsOpen), this.isOpen);
    out.set(byte(GameProp.IsVisible), this.isVisible);
    out.set(byte(GameProp.PlayerCount), byte(this.actors.size));
    if (this.listed) out.set(byte(GameProp.PropsListedInLobby), this.listed);
    if (this.masterActorNr) out.set(byte(GameProp.MasterClientId), this.masterActorNr);
    return out;
  }

  // The room as the lobby lists it: well-known keys and the listed custom ones.
  lobbyProperties() {
    const out = new Hashtable();
    out.set(byte(GameProp.MaxPlayers), byte(Math.min(this.maxPlayers, 255)));
    out.set(byte(GameProp.IsOpen), this.isOpen);
    out.set(byte(GameProp.PlayerCount), byte(this.actors.size));
    if (this.listed) for (const key of this.listed) if (this.props.has(key)) out.set(key, this.props.get(key));
    return out;
  }

  // Does this room satisfy JoinRandomGame's expected properties?
  matches(expected) {
    if (!(expected instanceof Hashtable)) return true;
    for (const [key, want] of expected) {
      const k = typeof key === "object" && key?.type === "byte" ? key.v : null;
      if (k === GameProp.MaxPlayers) {
        if ((num(want) ?? 0) !== 0 && num(want) !== this.maxPlayers) return false;
        continue;
      }
      if (k === GameProp.IsOpen || k === GameProp.IsVisible) continue;
      if (!this.props.has(key) || !sameValue(this.props.get(key), want)) return false;
    }
    return true;
  }
}

class Registry {
  constructor() {
    this.rooms = new Map();
    setInterval(() => this.sweep(), 5_000).unref();
  }

  count() {
    return this.rooms.size;
  }

  get(name) {
    return this.rooms.get(name) || null;
  }

  // { room } or { error: "full" | "taken" }.
  create(name) {
    if (this.rooms.size >= MAX_ROOMS) return { error: "full" };
    const roomName = typeof name === "string" && name ? name.slice(0, 128) : randomUUID();
    if (this.rooms.has(roomName)) return { error: "taken" };
    const room = new Room(roomName);
    this.rooms.set(roomName, room);
    return { room };
  }

  // Rooms an address made on the master that nobody has entered yet.
  pendingFor(ip) {
    let n = 0;
    for (const r of this.rooms.values()) if (r.creatorIp === ip && r.actors.size === 0) n++;
    return n;
  }

  pendingAllowed(ip) {
    return this.pendingFor(ip) < MAX_PENDING_PER_IP;
  }

  remove(name) {
    this.rooms.delete(name);
  }

  // The oldest open, visible room with space whose properties match.
  findRandom(expected, userId, lobbyName = "", sql = null, accept = null) {
    for (const room of this.rooms.values()) {
      if (!room.isOpen || !room.isVisible) continue;
      if (accept && !accept(room)) continue;
      if ((room.lobbyName || "") !== (lobbyName || "")) continue;
      if (room.actors.size === 0 && room.liveReservations() === 0) continue;
      if (!room.hasSpaceFor(userId)) continue;
      if (!room.matches(expected)) continue;
      // A range a room's creator has not set yet (they are still on their
      // way to it) does not keep a searcher out.
      if (sql && !sql.every(([k, v, op = "="]) => (room.props.has(k) ? compare(room.props.get(k), op, v) : op !== "=" && room.actors.size === 0))) continue;
      return room;
    }
    return null;
  }

  // The open ranked room whose creator's rating is closest to `rating`.
  closestRanked(expected, userId, lobbyName, sql, rating) {
    let best = null;
    for (const room of this.rooms.values()) {
      if (!room.ranked) continue;
      if (this.findRandom(expected, userId, lobbyName, sql, (r) => r === room) !== room) continue;
      if (!best || Math.abs(room.creatorRating - rating) < Math.abs(best.creatorRating - rating)) best = room;
    }
    return best;
  }

  // Whether this user is in, or on the way to, a ranked room.
  inRankedRoom(userId) {
    for (const room of this.rooms.values()) {
      if (!room.ranked) continue;
      if ((room.reservations.get(userId) || 0) >= Date.now()) return true;
      for (const actor of room.actors.values()) if (actor.userId === userId) return true;
    }
    return false;
  }

  visibleRooms(lobbyName = "") {
    return [...this.rooms.values()].filter((r) => r.isVisible && r.actors.size > 0 && (r.lobbyName || "") === (lobbyName || ""));
  }

  players() {
    let n = 0;
    for (const r of this.rooms.values()) n += r.actors.size;
    return n;
  }

  // Rooms made on the master that nobody reached, and empty rooms, go.
  sweep() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (room.actors.size === 0 && room.liveReservations() === 0 && now - room.created > EMPTY_ROOM_MS) this.rooms.delete(room.name);
    }
  }
}

export const registry = new Registry();
export { keyId };
