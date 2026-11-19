// Game server: the room in play. Relays events between players, keeps room
// and player properties and the event cache, and hands over the master
// client. All game logic stays in the clients (PUN).
import { Op, Param, Err, Ev, Cache, Receivers, JoinMode, GameProp, ActorProp } from "../../src/photon/codes.js";
import { Hashtable, Reader, Typed, num } from "../../src/photon/protocol18.js";
import { encodeEvent } from "../../src/photon/peer.js";
import { authenticate } from "./nameserver.js";
import { registry, Actor, RoomFlag, sameValue, int, encodedSize, PROPS_MAX_BYTES, CACHE_MAX_BYTES, CACHE_ENTRY_MAX_BYTES } from "./rooms.js";
import { enteredRoom, leftRoom } from "./presence.js";
import { applyCreateOptions, describe } from "./master.js";
import { log } from "../../src/log.js";

const CREATOR_WAIT_MS = 5000;

function byteKey(key) {
  return key instanceof Typed && key.type === "byte" ? key.v : null;
}

function asIntList(v) {
  if (v instanceof Int32Array) return [...v].slice(0, 64);
  if (Array.isArray(v)) return v.slice(0, 64).map((x) => int(x)).filter((n) => n !== null);
  const n = int(v);
  return n === null ? null : [n];
}

// --- joining -------------------------------------------------------------

function playerProps(room, actor) {
  const props = new Hashtable();
  for (const [k, v] of actor.props) props.set(k, v);
  if (room.flags & RoomFlag.PublishUserId) props.set(new Typed("byte", ActorProp.UserId), actor.userId);
  return props;
}

// A player matched into a room the master just made can reach the game
// server before the room's creator. They wait for the creator (who must be
// actor 1 and creates the room's properties) for up to CREATOR_WAIT_MS.
function waitingForCreator(room, userId) {
  return room && room.actors.size === 0 && room.creatorUserId && room.creatorUserId !== userId && room.reservations.has(room.creatorUserId);
}

function enter(peer, opCode, params) {
  if (peer.state.actor || peer.state.entering) return peer.respond(opCode, Err.OperationNotAllowedInCurrentState, new Map(), "Already in a room");
  const room = registry.get(params.get(Param.RoomName));
  if (opCode === Op.JoinGame && waitingForCreator(room, peer.state.userId)) {
    peer.state.entering = true;
    const started = Date.now();
    const poll = setInterval(() => {
      if (peer.closed || !waitingForCreator(room, peer.state.userId) || Date.now() - started > CREATOR_WAIT_MS) {
        clearInterval(poll);
        peer.state.entering = false;
        if (peer.closed) return;
        try {
          enterNow(peer, opCode, params);
        } catch (err) {
          log("op_error", { role: "game", op: opCode, error: String(err.stack || err) });
          peer.respond(opCode, Err.InternalServerError);
        }
      }
    }, 50);
    return;
  }
  enterNow(peer, opCode, params);
}

function enterNow(peer, opCode, params) {
  const name = params.get(Param.RoomName);
  const userId = peer.state.userId;
  let room = registry.get(name);
  if (opCode === Op.CreateGame) {
    if (room && room.actors.size > 0) return peer.respond(opCode, Err.GameIdAlreadyExists, new Map(), "A game with this name exists");
    if (!room) {
      const made = registry.create(name);
      if (!made.room) return peer.respond(opCode, Err.ServerFull, new Map(), "Server full");
      room = made.room;
    }
    applyCreateOptions(room, params);
  } else {
    if (!room && int(params.get(Param.JoinMode)) === JoinMode.CreateIfNotExists) {
      room = registry.create(name).room || null;
      if (room) applyCreateOptions(room, params);
    }
    if (!room) return peer.respond(opCode, Err.GameDoesNotExist, new Map(), "Game does not exist");
    const reserved = room.reservations.has(userId);
    if (!room.isOpen && !reserved) return peer.respond(opCode, Err.GameClosed, new Map(), "Game closed");
    if (!room.hasSpaceFor(userId)) return peer.respond(opCode, Err.GameFull, new Map(), "Game full");
  }

  const joinProps = params.get(Param.PlayerProperties) instanceof Hashtable ? params.get(Param.PlayerProperties) : new Hashtable();
  if (joinProps && encodedSize(joinProps) + room.propBytes + room.actorPropBytes() > PROPS_MAX_BYTES) {
    return peer.respond(opCode, Err.InvalidOperation, new Map(), "Player properties too large");
  }
  const actor = new Actor(room.nextActorNr++, peer, joinProps);
  room.reservations.delete(userId);
  room.actors.set(actor.actorNr, actor);
  if (!room.masterActorNr || !room.actors.has(room.masterActorNr)) room.masterActorNr = actor.actorNr;
  peer.state.room = room;
  peer.state.actor = actor;
  peer.once("close", () => leave(peer, false));

  const actorList = Int32Array.from(room.actors.keys());
  const others = new Hashtable();
  for (const other of room.actors.values()) if (other !== actor) others.set(other.actorNr, playerProps(room, other));

  try {
    peer.respond(
      opCode,
      Err.Ok,
      new Map([
        [Param.ActorNr, actor.actorNr],
        [Param.ActorList, actorList],
        [Param.PlayerProperties, others],
        [Param.GameProperties, room.gameProperties()],
        [Param.RoomOptionFlags, room.flags],
      ]),
    );
  } catch (err) {
    // Never leave a player in a room they were told they could not join.
    leave(peer, false);
    throw err;
  }
  enteredRoom(userId, room.name);
  log("join_room", { peer: peer.id, room: room.name, actor: actor.actorNr, name: peer.state.name, players: room.actors.size, max: room.maxPlayers, props: describe(room.props) });

  // Everyone, the joiner too, gets the Join event; then the joiner gets the cache.
  if (!(room.flags & RoomFlag.SuppressRoomEvents)) {
    const join = encodeEvent(
      Ev.Join,
      new Map([
        [Param.ActorNr, actor.actorNr],
        [Param.ActorList, actorList],
        [Param.PlayerProperties, playerProps(room, actor)],
      ]),
    );
    for (const other of room.actors.values()) other.peer.eventRaw(join);
  }
  for (const entry of room.cache) peer.eventRaw(cachedEvent(entry));
}

function leave(peer, sendResponse, opCode) {
  const room = peer.state.room;
  const actor = peer.state.actor;
  if (sendResponse) peer.respond(opCode, Err.Ok);
  if (!room || !actor) return;
  peer.state.room = null;
  peer.state.actor = null;
  room.actors.delete(actor.actorNr);
  leftRoom(actor.userId, room.name);

  if (room.flags & RoomFlag.DeleteCacheOnLeave) setCache(room, room.cache.filter((e) => e.global || e.actorNr !== actor.actorNr));

  if (room.actors.size === 0) {
    registry.remove(room.name);
    log("room_closed", { room: room.name });
    return;
  }

  const params = new Map([
    [Param.ActorNr, actor.actorNr],
    [Param.ActorList, Int32Array.from(room.actors.keys())],
  ]);
  if (room.masterActorNr === actor.actorNr) {
    room.masterActorNr = Math.min(...room.actors.keys());
    params.set(Param.MasterClientId, room.masterActorNr);
  }
  log("leave_room", { peer: peer.id, room: room.name, actor: actor.actorNr, players: room.actors.size, master: room.masterActorNr });
  if (!(room.flags & RoomFlag.SuppressRoomEvents)) {
    const ev = encodeEvent(Ev.Leave, params);
    for (const other of room.actors.values()) other.peer.eventRaw(ev);
  }
}

// --- events --------------------------------------------------------------

function cachedEvent(entry) {
  if (!entry.bytes) {
    const raw = new Map();
    if (entry.data) raw.set(Param.Data, entry.data);
    entry.bytes = encodeEvent(entry.code, new Map([[Param.ActorNr, entry.actorNr]]), raw);
  }
  return entry.bytes;
}

function decoded(bytes) {
  if (!bytes) return null;
  try {
    return new Reader(bytes).value();
  } catch {
    return undefined;
  }
}

function entryBytes(e) {
  return (e.data ? e.data.length : 0) * 2 + 64; // data, plus the encoded event kept for replay
}

function setCache(room, entries) {
  room.cache = entries;
  room.cacheBytes = entries.reduce((n, e) => n + entryBytes(e), 0);
}

// Does cached data match a RemoveFromRoomCache filter? A Hashtable filter
// matches data that holds every one of its keys with the same value. Data
// is decoded once, when it is cached.
function dataMatches(entry, filter) {
  if (filter === null || filter === undefined) return true;
  const data = entry.value;
  if (filter instanceof Hashtable) {
    if (!(data instanceof Hashtable)) return false;
    for (const [k, v] of filter) if (!data.has(k) || !sameValue(data.get(k), v)) return false;
    return true;
  }
  return data !== undefined && sameValue(data, filter);
}

function raiseEvent(peer, params, rawParams) {
  const room = peer.state.room;
  const actor = peer.state.actor;
  if (!room || !actor) return;

  const code = int(params.get(Param.Code), 0, 255) ?? 0;
  const cache = int(params.get(Param.Cache), 0, 255) ?? Cache.DoNotCache;
  const data = rawParams.get(Param.Data) || null;
  const targets = params.has(Param.TargetActorNr) ? asIntList(params.get(Param.TargetActorNr)) : null;

  if (cache === Cache.RemoveFromRoomCache) {
    const filter = params.has(Param.Data) ? params.get(Param.Data) : null;
    setCache(
      room,
      room.cache.filter((e) => {
        if (code !== 0 && e.code !== code) return true;
        if (targets && !targets.includes(e.actorNr)) return true;
        return !dataMatches(e, filter);
      }),
    );
    return;
  }
  if (cache === Cache.RemoveFromRoomCacheForActorsLeft) {
    setCache(
      room,
      room.cache.filter((e) => e.global || room.actors.has(e.actorNr)),
    );
    return;
  }
  if (cache === Cache.AddToRoomCache || cache === Cache.AddToRoomCacheGlobal) {
    const entry = { actorNr: actor.actorNr, code, data, value: decoded(data), global: cache === Cache.AddToRoomCacheGlobal, bytes: null };
    // PUN caches small things (instantiations, buffered RPCs). Anything
    // past the budget is not a real game: drop the connection.
    if ((data && data.length > CACHE_ENTRY_MAX_BYTES) || room.cacheBytes + entryBytes(entry) > CACHE_MAX_BYTES) {
      log("cache_budget_close", { room: room.name, peer: peer.id, ip: peer.ip, cacheBytes: room.cacheBytes });
      return peer.close();
    }
    room.cache.push(entry);
    room.cacheBytes += entryBytes(entry);
  }


  const raw = new Map();
  if (data) raw.set(Param.Data, data);
  const bytes = encodeEvent(code, new Map([[Param.ActorNr, actor.actorNr]]), raw);
  const group = int(params.get(Param.Group), 0, 255) ?? 0;
  const inGroup = (a) => group === 0 || a.groups.has("all") || a.groups.has(group);

  if (targets) {
    for (const nr of targets) {
      const a = room.actors.get(nr);
      if (a && inGroup(a)) a.peer.eventRaw(bytes);
    }
    return;
  }
  const receivers = int(params.get(Param.ReceiverGroup), 0, 255) ?? Receivers.Others;
  for (const a of room.actors.values()) {
    if (receivers === Receivers.Others && a === actor) continue;
    if (receivers === Receivers.MasterClient && a.actorNr !== room.masterActorNr) continue;
    if (inGroup(a)) a.peer.eventRaw(bytes);
  }
}

// --- properties ----------------------------------------------------------

function roomValue(room, key) {
  const k = byteKey(key);
  if (k === GameProp.MasterClientId) return room.masterActorNr;
  if (k === GameProp.IsOpen) return room.isOpen;
  if (k === GameProp.IsVisible) return room.isVisible;
  if (k === GameProp.MaxPlayers) return new Typed("byte", room.maxPlayers);
  return room.props.get(key);
}

function casHolds(current, expected) {
  if (!(expected instanceof Hashtable) || expected.size === 0) return true;
  for (const [k, want] of expected) {
    const have = current(k);
    if (have === undefined && want === null) continue;
    if (have === undefined || !sameValue(have, want)) {
      // ints sent as other int widths still count as equal
      if (num(have) === null || num(have) !== num(want)) return false;
    }
  }
  return true;
}

function setProperties(peer, opCode, params) {
  const room = peer.state.room;
  const actor = peer.state.actor;
  if (!room || !actor) return peer.respond(opCode, Err.OperationNotAllowedInCurrentState);
  const props = params.get(Param.Properties);
  if (!(props instanceof Hashtable)) return peer.respond(opCode, Err.InvalidOperation, new Map(), "Properties missing");
  const expected = params.get(Param.ExpectedValues);
  const targetNr = int(params.get(Param.ActorNr), 0) ?? 0;

  if (targetNr > 0) {
    const target = room.actors.get(targetNr);
    if (!target) return peer.respond(opCode, Err.InvalidOperation, new Map(), "No such player");
    if (!casHolds((k) => target.props.get(k), expected)) return peer.respond(opCode, Err.InvalidOperation, new Map(), "CAS update failed");
    const next = new Hashtable();
    for (const [k, v] of target.props) next.set(k, v);
    for (const [k, v] of props) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    // The game sometimes clears the name; keep the one we know.
    const nextBytes = encodedSize(next);
    if (room.propBytes + room.actorPropBytes() - target.propBytes + nextBytes > PROPS_MAX_BYTES) {
      return peer.respond(opCode, Err.InvalidOperation, new Map(), "Properties too large");
    }
    target.props = next;
    target.propBytes = nextBytes;
  } else {
    if (!casHolds((k) => roomValue(room, k), expected)) return peer.respond(opCode, Err.InvalidOperation, new Map(), "CAS update failed");
    if (!room.propsFit(props)) return peer.respond(opCode, Err.InvalidOperation, new Map(), "Properties too large");
    room.applyProps(props);
  }
  peer.respond(opCode, Err.Ok);

  if (params.get(Param.Broadcast) === false) return;
  const toAll = Boolean(room.flags & RoomFlag.BroadcastPropsChangeToAll) || (expected instanceof Hashtable && expected.size > 0);
  const ev = encodeEvent(
    Ev.PropertiesChanged,
    new Map([
      [Param.TargetActorNr, targetNr],
      [Param.Properties, props],
      [Param.ActorNr, actor.actorNr],
    ]),
  );
  for (const a of room.actors.values()) if (toAll || a !== actor) a.peer.eventRaw(ev);
}

function getProperties(peer, opCode) {
  const room = peer.state.room;
  if (!room) return peer.respond(opCode, Err.OperationNotAllowedInCurrentState);
  const players = new Hashtable();
  for (const a of room.actors.values()) players.set(a.actorNr, playerProps(room, a));
  peer.respond(
    opCode,
    Err.Ok,
    new Map([
      [Param.GameProperties, room.gameProperties()],
      [Param.PlayerProperties, players],
    ]),
  );
}

function changeGroups(peer, opCode, params) {
  const actor = peer.state.actor;
  if (!actor) return peer.respond(opCode, Err.OperationNotAllowedInCurrentState);
  const groups = (v) => (v instanceof Uint8Array ? [...v] : null);
  const remove = groups(params.get(Param.Remove));
  const add = groups(params.get(Param.Add));
  if (remove) {
    if (remove.length === 0) actor.groups.clear();
    else for (const g of remove) actor.groups.delete(g);
  }
  if (add) {
    if (add.length === 0) actor.groups.add("all");
    else for (const g of add) actor.groups.add(g);
  }
  peer.respond(opCode, Err.Ok);
}

export function gameOp(peer, opCode, params, rawParams) {
  switch (opCode) {
    case Op.Authenticate:
    case Op.AuthenticateOnce:
      return authenticate(peer, opCode, params, "game");
    case Op.CreateGame:
    case Op.JoinGame:
      return enter(peer, opCode, params);
    case Op.Leave:
      return leave(peer, true, opCode);
    case Op.RaiseEvent:
      return raiseEvent(peer, params, rawParams);
    case Op.SetProperties:
      return setProperties(peer, opCode, params);
    case Op.GetProperties:
      return getProperties(peer, opCode);
    case Op.ChangeGroups:
      return changeGroups(peer, opCode, params);
    default:
      return false;
  }
}
