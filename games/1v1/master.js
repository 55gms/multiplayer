// Master server: lobby and matchmaking. Sends players to the game server
// with a room name; the room itself is played on /game.
import { Op, Param, Err, Ev, JoinMode } from "../../src/photon/codes.js";
import { Hashtable, StringArray, BoolArray, num } from "../../src/photon/protocol18.js";
import { address } from "./address.js";
import { authenticate } from "./nameserver.js";
import { registry, int } from "./rooms.js";
import { isOnline, roomOf } from "./presence.js";
import { log } from "../../src/log.js";
import { REMOTE, openRemoteMaster } from "./remote.js";

const lobbyPeers = new Set();

// Players whose search just failed and who are about to create a room, by
// what they searched for. A second player searching for the same thing in
// that moment waits for the room instead of creating a second one.
const CREATOR_WAIT_MS = 1500;
const creators = new Map(); // peer -> { key, at }

function searchKey(expected, lobbyName, sqlText) {
  return `${lobbyName}|${sqlText || ""}|${expected instanceof Hashtable ? describe(expected) : ""}`;
}

// A ranked player who waits in a room never searches again, so two ranked
// searches wait longer for each other's room: a slow client can take
// seconds between a failed search and creating its room.
const RANKED_CREATOR_WAIT_MS = 12000;

function creatorPending(key, self, waitMs = CREATOR_WAIT_MS) {
  const now = Date.now();
  for (const [peer, c] of creators) {
    if (now - c.at > RANKED_CREATOR_WAIT_MS || peer.closed) creators.delete(peer);
    else if (peer !== self && c.key === key && now - c.at <= waitMs) return true;
  }
  return false;
}

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

// --- ranked -------------------------------------------------------------
// Competitive modes ("…_Competitive") are for 55GMS accounts only, one ranked
// room at a time. The game's own rating range (its "N >= C1 AND N <= C2"
// filter) is not used: this build never widens it properly and a waiting
// player never searches again, so a refused searcher would wait forever in
// a room of its own. A ranked search joins the waiting ranked room closest
// to its rating instead; ratings come from 55GMS and change only by the
// results it applies.
const RANKED = /_Competitive$/;
const DEFAULT_RATING = 0; // as 55GMS: unranked players start at 0

function ratingFor(peer, mode) {
  const value = peer.state.account?.ratings?.[mode];
  return typeof value === "number" ? value : DEFAULT_RATING;
}

function modeOf(expected, sql) {
  const fromSql = sql?.find(([k, , op]) => k === "C0" && op === "=")?.[1];
  if (typeof fromSql === "string") return fromSql;
  const fromProps = expected instanceof Hashtable ? expected.get("C0") : null;
  return typeof fromProps === "string" ? fromProps : null;
}

// Why this peer may not enter a ranked room for `mode`, or null.
function rankedRefusal(peer) {
  if (!peer.state.account) return "Sign in to 55GMS to play ranked";
  if (registry.inRankedRoom(peer.state.userId)) return "Already in a ranked match";
  return null;
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
  const flags = int(params.get(Param.RoomOptionFlags), 0, 0xffff);
  if (flags !== null) room.flags = flags;
  else if (params.get(Param.CleanupCacheOnLeave) === false) room.flags &= ~2;
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

// FindFriends: are these users online, and in which room. Parties follow
// their leader into a room by its name.
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

// --- the queue here, then the other server's ---------------------------
// A casual search that finds no room waits here up to REMOTE.afterMs. A
// second player searching for the same thing in that time meets the first
// here (the first creates the room, the second waits for it). Nobody → the
// search goes to the other server's queue (remote.js), and this connection
// passes the player's master operations through to it from then on.
const holders = new Map(); // search key -> { peer, local() }
const HOLD_POLL_MS = 250;

function hold(peer, key, find, answer, goRemote) {
  peer.state.searching = true;
  const started = Date.now();
  const h = {
    peer,
    local() {
      stop();
      answer(null, Date.now() - started);
    },
  };
  function stop() {
    clearInterval(timer);
    if (holders.get(key) === h) holders.delete(key);
  }
  const timer = setInterval(() => {
    try {
      if (peer.closed) {
        stop();
        peer.state.searching = false;
        return;
      }
      const found = find();
      if (found) {
        stop();
        return answer(found, Date.now() - started);
      }
      if (Date.now() - started >= REMOTE.afterMs) {
        stop();
        goRemote(Date.now() - started);
      }
    } catch (err) {
      stop();
      peer.state.searching = false;
      log("op_error", { role: "master", op: Op.JoinRandomGame, error: String(err.stack || err) });
      if (!peer.closed) peer.respond(Op.JoinRandomGame, Err.InternalServerError);
    }
  }, HOLD_POLL_MS);
  holders.set(key, h);
}

function goRemote(peer, buf, answer, waited) {
  peer.state.searching = true;
  openRemoteMaster(peer).then(
    (remote) => {
      if (peer.closed) return remote.close();
      peer.state.remote = remote;
      peer.state.searching = false;
      log("join_remote", { peer: peer.id, waited });
      remote.send(buf);
    },
    (err) => {
      log("remote_failed", { peer: peer.id, error: String(err.message || err) });
      answer(null, waited);
    },
  );
}

export function masterOp(peer, opCode, params, rawParams, buf) {
  // Matched on the other server: everything goes there now.
  if (peer.state.remote) {
    peer.state.remote.send(buf);
    return;
  }
  switch (opCode) {
    case Op.Authenticate:
    case Op.AuthenticateOnce: {
      const first = !peer.state.authenticated;
      // The other server's login (remote.js) uses the game's own.
      if (typeof params.get(Param.ApplicationId) === "string") peer.state.appId = params.get(Param.ApplicationId).slice(0, 64);
      if (typeof params.get(Param.AppVersion) === "string") peer.state.appVersion = params.get(Param.AppVersion).slice(0, 64);
      authenticate(peer, opCode, params, "master");
      if (!first) return;
      lobbyPeers.add(peer);
      peer.once("close", () => lobbyPeers.delete(peer));
      appStats(peer);
      return;
    }

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
      return findFriends(peer, opCode, params);

    case Op.JoinRandomGame: {
      if (peer.state.searching) return peer.respond(opCode, Err.OperationNotAllowedInCurrentState, new Map(), "Already searching");
      const expected = params.get(Param.GameProperties);
      const lobbyName = typeof params.get(Param.LobbyName) === "string" ? params.get(Param.LobbyName) : "";
      // Remembered for a CreateGame that follows: PUN creates the room with
      // the properties it searched for, but only tells the game server.
      peer.state.lastExpected = expected instanceof Hashtable ? expected : null;
      peer.state.lobby = lobbyName;
      const sqlText = typeof params.get(Param.Data) === "string" ? params.get(Param.Data) : null;
      const sql = sqlText ? parseSqlFilter(sqlText) : null;
      const mode = modeOf(expected, sql);
      const ranked = Boolean(mode && RANKED.test(mode));
      // Ranked searches differ by rating, and a waiting 1v1.lol player never
      // searches again, so two pressing PLAY together must still meet: they
      // wait for each other by mode alone.
      const key = ranked ? `ranked|${lobbyName}|${mode}` : searchKey(expected, lobbyName, sqlText);
      if (ranked) {
        const refusal = rankedRefusal(peer);
        if (refusal) return peer.respond(opCode, Err.OperationNotAllowedInCurrentState, new Map(), refusal);
      }
      const accept = (room) => Boolean(room.ranked) === ranked;
      const myRating = ranked ? ratingFor(peer, mode) : 0;
      const filter = ranked && sql ? sql.filter(([, , op]) => op === "=") : sql;
      const find = () =>
        ranked
          ? registry.closestRanked(expected, peer.state.userId, lobbyName, filter, myRating)
          : registry.findRandom(expected, peer.state.userId, lobbyName, sql, accept);
      const answer = (room, waited) => {
        peer.state.searching = false;
        if (peer.closed) return;
        log("join_random", { peer: peer.id, found: room?.name || null, waited, expected: describe(expected), params: paramSummary(params) });
        if (room) return sendToRoom(peer, opCode, room);
        creators.set(peer, { key, at: Date.now() });
        peer.respond(opCode, Err.NoRandomMatchFound, new Map(), "No match found");
      };
      const waitMs = ranked ? RANKED_CREATOR_WAIT_MS : CREATOR_WAIT_MS;
      const room = find();
      if (room) return answer(room, 0);
      if (!creatorPending(key, peer, waitMs)) {
        if (ranked || !REMOTE.enabled || !buf) return answer(null, 0);
        const other = holders.get(key);
        if (!other || other.peer === peer || other.peer.closed) {
          return hold(peer, key, find, answer, (waited) => goRemote(peer, buf, answer, waited));
        }
        // Someone is already waiting for this: they make the room, this
        // player joins it.
        other.local();
      }
      const started = Date.now();
      peer.state.searching = true;
      const poll = setInterval(() => {
        try {
          const found = find();
          if (found || peer.closed || Date.now() - started > waitMs || !creatorPending(key, peer, waitMs)) {
            clearInterval(poll);
            answer(found, Date.now() - started);
          }
        } catch (err) {
          clearInterval(poll);
          peer.state.searching = false;
          log("op_error", { role: "master", op: opCode, error: String(err.stack || err) });
          if (!peer.closed) peer.respond(opCode, Err.InternalServerError);
        }
      }, 50);
      return;
    }

    case Op.CreateGame: {
      creators.delete(peer);
      const props = params.get(Param.GameProperties) instanceof Hashtable ? params.get(Param.GameProperties) : peer.state.lastExpected;
      const mode = modeOf(props, null);
      const ranked = Boolean(mode && RANKED.test(mode));
      if (ranked) {
        const refusal = rankedRefusal(peer);
        if (refusal) return peer.respond(opCode, Err.OperationNotAllowedInCurrentState, new Map(), refusal);
      }
      const made = createRoom(peer, params.get(Param.RoomName));
      if (!made.room) return createError(peer, opCode, made.error);
      const room = made.room;
      if (ranked) {
        room.ranked = true;
        room.mode = mode;
        room.creatorRating = ratingFor(peer, mode);
      }
      // Until the creator reaches the game server, the room matches what they
      // searched for, so a player searching meanwhile joins it instead of
      // making a second room.
      if (!params.has(Param.GameProperties) && peer.state.lastExpected) room.applyProps(peer.state.lastExpected);
      // A room created without a lobby goes into the creator's current lobby.
      if (!params.has(Param.LobbyName) && peer.state.lobby) room.lobbyName = peer.state.lobby;
      applyCreateOptions(room, params);
      room.creatorUserId = peer.state.userId;
      log("create_room", { peer: peer.id, room: room.name, max: room.maxPlayers, props: describe(room.props), params: paramSummary(params) });
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
      }
      if (!room) return peer.respond(opCode, Err.GameDoesNotExist, new Map(), "Game does not exist");
      if (room.ranked) {
        const refusal = rankedRefusal(peer);
        if (refusal) return peer.respond(opCode, Err.OperationNotAllowedInCurrentState, new Map(), refusal);
      }
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

// SQL lobby filters as 1v1.lol sends them: "C0 = '1v1'", joined by AND.
// Returns [[key, value]...], or null when the filter has anything else
// (then only the expected properties are used).
export function parseSqlFilter(sql) {
  const out = [];
  for (const part of sql.split(/\s+AND\s+/i)) {
    const text = part.trim().replace(/^\(\s*/, "").replace(/\s*\)$/, "");
    const eq = text.match(/^(C\d)\s*=\s*(?:'((?:[^']|'')*)'|(-?\d+))$/i);
    if (eq) {
      out.push([eq[1].toUpperCase(), eq[2] !== undefined ? eq[2].replace(/''/g, "'") : Number(eq[3]), "="]);
      continue;
    }
    // Ranked searches: "<rating> >= C1 AND <rating> <= C2", the waiting
    // room's range (its creator widens it while it waits).
    const left = text.match(/^(-?\d+(?:\.\d+)?)\s*(>=|<=)\s*(C\d)$/i);
    if (left) {
      out.push([left[3].toUpperCase(), Number(left[1]), left[2] === ">=" ? "<=" : ">="]);
      continue;
    }
    const right = text.match(/^(C\d)\s*(>=|<=)\s*(-?\d+(?:\.\d+)?)$/i);
    if (right) {
      out.push([right[1].toUpperCase(), Number(right[3]), right[2]]);
      continue;
    }
    return null;
  }
  return out;
}
