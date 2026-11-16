// Master server: lobby and matchmaking. Sends players to the game server
// with a room name; the room itself is played on /game.
import { Op, Param, Err, Ev, JoinMode } from "../../src/photon/codes.js";
import { Hashtable, num } from "../../src/photon/protocol18.js";
import { address } from "./address.js";
import { authenticate } from "./nameserver.js";
import { registry } from "./rooms.js";
import { log } from "../../src/log.js";

const lobbyPeers = new Set();

function appStats(peer) {
  const players = registry.players();
  peer.event(
    Ev.AppStats,
    new Map([
      [Param.MasterPeerCount, lobbyPeers.size],
      [Param.PeerCount, players],
      [Param.GameCount, registry.count()],
    ]),
  );
}

function gameList(lobbyName) {
  const list = new Hashtable();
  for (const room of registry.visibleRooms(lobbyName)) list.set(room.name, room.lobbyProperties());
  return list;
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

// Room settings sent with CreateGame (on the master and again on the game server).
export function applyCreateOptions(room, params) {
  room.applyProps(params.get(Param.GameProperties));
  const flags = num(params.get(Param.RoomOptionFlags));
  if (flags !== null) room.flags = flags;
  else if (params.get(Param.CleanupCacheOnLeave) === false) room.flags &= ~2;
  if (typeof params.get(Param.LobbyName) === "string") room.lobbyName = params.get(Param.LobbyName);
  if (num(params.get(Param.LobbyType)) !== null) room.lobbyType = num(params.get(Param.LobbyType));
}

export function masterOp(peer, opCode, params) {
  switch (opCode) {
    case Op.Authenticate:
    case Op.AuthenticateOnce:
      authenticate(peer, opCode, params, "master");
      lobbyPeers.add(peer);
      peer.once("close", () => lobbyPeers.delete(peer));
      appStats(peer);
      return;

    case Op.JoinLobby: {
      const lobbyName = typeof params.get(Param.LobbyName) === "string" ? params.get(Param.LobbyName) : "";
      peer.state.lobby = lobbyName;
      peer.respond(opCode, Err.Ok);
      peer.event(Ev.GameList, new Map([[Param.GameList, gameList(lobbyName)]]));
      return;
    }

    case Op.LeaveLobby:
      peer.state.lobby = null;
      peer.respond(opCode, Err.Ok);
      return;

    case Op.GetLobbyStats:
    case Op.ServerSettings:
      peer.respond(opCode, Err.Ok);
      return;

    case Op.FindFriends:
      peer.respond(opCode, Err.Ok);
      return;

    case Op.JoinRandomGame: {
      const expected = params.get(Param.GameProperties);
      const lobbyName = typeof params.get(Param.LobbyName) === "string" ? params.get(Param.LobbyName) : "";
      const room = registry.findRandom(expected, peer.state.userId, lobbyName);
      log("join_random", { peer: peer.id, found: room?.name || null, expected: describe(expected) });
      if (!room) return peer.respond(opCode, Err.NoRandomMatchFound, new Map(), "No match found");
      return sendToRoom(peer, opCode, room);
    }

    case Op.CreateGame: {
      const room = registry.create(params.get(Param.RoomName));
      if (!room) return peer.respond(opCode, Err.GameIdAlreadyExists, new Map(), "A game with this name exists");
      applyCreateOptions(room, params);
      log("create_room", { peer: peer.id, room: room.name, max: room.maxPlayers, props: describe(room.props) });
      return sendToRoom(peer, opCode, room);
    }

    case Op.JoinGame: {
      const name = params.get(Param.RoomName);
      let room = registry.get(name);
      if (!room && num(params.get(Param.JoinMode)) === JoinMode.CreateIfNotExists) {
        room = registry.create(name);
        if (room) applyCreateOptions(room, params);
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
