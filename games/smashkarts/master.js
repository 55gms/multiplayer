// Master server: matchmaking. Sends players to the game server with a room
// name; the room itself is played on /game.
//
// Smash Karts' PLAY is one JoinRandomGame that carries the room to create when
// none matches (Photon's "join random or create"). It is answered here in this
// order:
//
// 1. a room on this server that matches and has space;
// 2. the official Photon cloud (remote.js), with the player's own login, so a
//    lone player finds the people who play there;
// 3. a new room here, when the cloud cannot be reached.
//
// Private games ("Create", "Join" with a code) are JoinGame with a room name,
// and stay on this server: parties find their leader's room by its code.
import { Op, Param, Err, Ev, JoinMode } from "../../src/photon/codes.js";
import { Hashtable, StringArray, BoolArray } from "../../src/photon/protocol18.js";
import { address } from "./address.js";
import { authenticate } from "./nameserver.js";
import { registry, int, RoomFlag } from "./rooms.js";
import { isOnline, roomOf } from "./presence.js";
import { log } from "../../src/log.js";
import { REMOTE, openRemoteMaster } from "./remote.js";

const lobbyPeers = new Set();

// The settings Smash Karts' rooms get from PUN (CheckUserOnJoin, DeleteCache
// OnLeave, PublishUserId, BroadcastPropsChangeToAll): what its game server
// join asks for too.
const ROOM_FLAGS = RoomFlag.CheckUserOnJoin | RoomFlag.DeleteCacheOnLeave | RoomFlag.PublishUserId | RoomFlag.BroadcastPropsChangeToAll;

function appStats(peer) {
  // The game reads all three: 227 players on the master, 228 rooms, 229 players.
  peer.event(
    Ev.AppStats,
    new Map([
      [227, lobbyPeers.size],
      [228, registry.count()],
      [229, registry.players()],
    ]),
  );
}

function sendToRoom(peer, opCode, room) {
  room.reserve(peer.state.userId);
  peer.respond(
    opCode,
    Err.Ok,
    new Map([
      [Param.RoomName, room.name],
      [Param.Address, address(peer, "game")],
    ]),
  );
}

// Room settings sent with CreateGame / JoinGame (on the master and again on the game server).
export function applyCreateOptions(room, params) {
  room.applyProps(params.get(Param.GameProperties));
  const flags = int(params.get(Param.RoomOptionFlags), 0, 0xffff);
  if (flags !== null) room.flags = flags;
  const lobbyName = params.get(Param.LobbyName);
  if (typeof lobbyName === "string") room.lobbyName = lobbyName.slice(0, 64);
  const lobbyType = int(params.get(Param.LobbyType), 0, 255);
  if (lobbyType !== null) room.lobbyType = lobbyType;
}

// Rooms are made on the master before anyone is in them. One such room per
// connection (a new one replaces it) and a few per address, so nobody can
// fill the room table.
function createRoom(peer, name) {
  const previous = peer.state.pendingRoom;
  if (previous && previous.actors.size === 0 && registry.get(previous.name) === previous) registry.remove(previous.name);
  peer.state.pendingRoom = null;
  if (!registry.pendingAllowed(peer.ip)) return { error: "busy" };
  const made = registry.create(name);
  if (made.room) {
    made.room.creatorIp = peer.ip;
    peer.state.pendingRoom = made.room;
  }
  return made;
}

function createError(peer, opCode, error) {
  if (error === "taken") return peer.respond(opCode, Err.GameIdAlreadyExists, new Map(), "A game with this name exists");
  return peer.respond(opCode, Err.ServerFull, new Map(), "Server full");
}

// FindFriends: are these users online, and in which room.
function findFriends(peer, opCode, params) {
  const ids = params.get(1);
  const list = Array.isArray(ids) ? ids.slice(0, 64) : [];
  peer.respond(
    opCode,
    Err.Ok,
    new Map([
      [1, BoolArray.from(list.map((id) => typeof id === "string" && isOnline(id)))],
      [2, StringArray.from(list.map((id) => (typeof id === "string" ? roomOf(id) : "")))],
    ]),
  );
}

// A search that found nothing here: a room made on the spot, from the
// settings the search carried.
function createFromSearch(peer, opCode, params) {
  const made = createRoom(peer, params.get(Param.RoomName));
  if (!made.room) return createError(peer, opCode, made.error);
  const room = made.room;
  room.applyProps(params.get(Param.Properties) instanceof Hashtable ? params.get(Param.Properties) : params.get(Param.GameProperties));
  room.flags = ROOM_FLAGS;
  room.creatorUserId = peer.state.userId;
  log("create_room", { peer: peer.id, room: room.name, max: room.maxPlayers, props: describe(room.props) });
  return sendToRoom(peer, opCode, room);
}

function goRemote(peer, opCode, params, buf) {
  peer.state.searching = true;
  openRemoteMaster(peer).then(
    (remote) => {
      peer.state.searching = false;
      if (peer.closed) return remote.close();
      peer.state.remote = remote;
      log("join_remote", { peer: peer.id });
      remote.send(buf);
    },
    (err) => {
      peer.state.searching = false;
      if (peer.closed) return;
      log("remote_failed", { peer: peer.id, error: String(err.message || err) });
      createFromSearch(peer, opCode, params);
    },
  );
}

export function masterOp(peer, opCode, params, rawParams, buf) {
  // Matched on the official cloud: everything goes there now.
  if (peer.state.remote) {
    peer.state.remote.send(buf);
    return;
  }
  switch (opCode) {
    case Op.Authenticate:
    case Op.AuthenticateOnce: {
      const first = !peer.state.authenticated;
      authenticate(peer, opCode, params, "master", buf);
      if (!first) return;
      lobbyPeers.add(peer);
      peer.once("close", () => lobbyPeers.delete(peer));
      appStats(peer);
      return;
    }

    case Op.JoinLobby:
    case Op.LeaveLobby:
    case Op.GetLobbyStats:
    case Op.ServerSettings:
      peer.respond(opCode, Err.Ok);
      return;

    case Op.FindFriends:
      return findFriends(peer, opCode, params);

    case Op.JoinRandomGame: {
      if (peer.state.searching) return peer.respond(opCode, Err.OperationNotAllowedInCurrentState, new Map(), "Already searching");
      const expected = params.get(Param.GameProperties);
      const lobbyName = typeof params.get(Param.LobbyName) === "string" ? params.get(Param.LobbyName) : "";
      const room = registry.findRandom(expected, peer.state.userId, lobbyName, null, (r) => r.hasSpaceFor(peer.state.userId));
      log("join_random", { peer: peer.id, found: room?.name || null, expected: describe(expected) });
      if (room) return sendToRoom(peer, opCode, room);
      if (REMOTE.enabled && buf) return goRemote(peer, opCode, params, buf);
      return createFromSearch(peer, opCode, params);
    }

    case Op.CreateGame: {
      const made = createRoom(peer, params.get(Param.RoomName));
      if (!made.room) return createError(peer, opCode, made.error);
      const room = made.room;
      applyCreateOptions(room, params);
      room.creatorUserId = peer.state.userId;
      log("create_room", { peer: peer.id, room: room.name, max: room.maxPlayers, props: describe(room.props) });
      return sendToRoom(peer, opCode, room);
    }

    case Op.JoinGame: {
      const name = params.get(Param.RoomName);
      let room = registry.get(name);
      if (!room && int(params.get(Param.JoinMode)) === JoinMode.CreateIfNotExists) {
        const made = createRoom(peer, name);
        if (!made.room) return createError(peer, opCode, made.error);
        room = made.room;
        applyCreateOptions(room, params);
        room.creatorUserId = peer.state.userId;
        log("create_room", { peer: peer.id, room: room.name, max: room.maxPlayers, private: true, props: describe(room.props) });
      }
      if (!room) return peer.respond(opCode, Err.GameDoesNotExist, new Map(), "Game does not exist");
      if (!room.isOpen) return peer.respond(opCode, Err.GameClosed, new Map(), "Game closed");
      if (!room.hasSpaceFor(peer.state.userId)) return peer.respond(opCode, Err.GameFull, new Map(), "Game full");
      return sendToRoom(peer, opCode, room);
    }

    default:
      return false;
  }
}

// For logs: a Hashtable as plain key=value text.
export function describe(table) {
  if (!(table instanceof Hashtable)) return null;
  const out = {};
  for (const [k, v] of table) out[typeof k === "object" ? `${k.type}:${k.v}` : String(k)] = typeof v === "object" && v !== null ? (v.v ?? "[obj]") : v;
  return JSON.stringify(out, (_, x) => (typeof x === "bigint" ? String(x) : x));
}

// For logs: every parameter of a request, values shortened.
export function paramSummary(params) {
  const out = {};
  for (const [k, v] of params) {
    if (v instanceof Hashtable) out[k] = describe(v);
    else if (v && typeof v === "object") out[k] = v.constructor?.name + (v.v !== undefined ? ":" + v.v : "");
    else out[k] = v;
  }
  return out;
}
