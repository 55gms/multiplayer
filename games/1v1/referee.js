// Decides 1v1.lol match results from what the players' clients send, for the
// modes whose result can be read (docs/1v1-match-events.md), and reports
// them to 55GMS (accounts.js). It only watches: nothing it sees changes what
// is relayed.
//
// A player's own client saying it died (GameManager.PlayerDied, RPC 24,
// [dead, killer], sent by the dead actor) is that player's loss: one client
// cannot make another's say it died. The killer is credited with the kill
// only when its client hit that player shortly before (TakeHit, RPC 7, on the
// victim's view), and a hit counts only when the shooter fired just before it
// (ShotOccured, RPC 17). A shooter landing more hits a second than any weapon
// fires voids the match. 1v1 is one life each; a player who leaves a started
// match before its end loses it; a match that runs out its time with nobody
// dead is a draw, and one a client ends early with nobody dead counts for
// nobody.
import { Hashtable, num } from "../../src/photon/protocol18.js";
import { postMatch } from "./accounts.js";
import { log } from "../../src/log.js";

const RPC_EVENT = 200;
const RPC_TAKE_HIT = 7;
const RPC_PLAYER_DIED = 24;
const RPC_SHOT_OCCURED = 17;
const HIT_WINDOW_MS = 15000;
const SHOT_BEFORE_HIT_MS = 2000;
const MAX_HITS_PER_SECOND = 15;
// A 1v1 round lasts 3 minutes; a draw needs most of it to have run.
const ROUND_MS = 170000;
// Modes whose winner can be read; the rest give nothing (no result posted).
const READABLE = new Set(["1v1", "1v1_Competitive"]);

const matches = new WeakMap(); // room -> state

function stateOf(room) {
  let s = matches.get(room);
  if (!s) {
    s = { started: false, startedAt: 0, over: false, posted: false, void: null, players: new Map(), hits: new Map(), shots: new Map(), rate: new Map(), deaths: [], left: new Set() };
    matches.set(room, s);
  }
  return s;
}

function intOf(v) {
  const n = num(v);
  return Number.isInteger(n) ? n : null;
}

function byteKeyed(table, k) {
  if (!(table instanceof Hashtable)) return undefined;
  for (const [key, value] of table) {
    const id = typeof key === "object" && key !== null && key.type === "byte" ? key.v : key;
    if (id === k) return value;
  }
  return undefined;
}

function modeOf(room) {
  const mode = room.props.get("C0");
  return typeof mode === "string" ? mode : null;
}

export function onJoin(room, actor) {
  const s = stateOf(room);
  s.players.set(actor.actorNr, { uuid: actor.peer.state.account?.uuid || null });
}

export function onEvent(room, actor, code, data) {
  if (code !== RPC_EVENT || !(data instanceof Hashtable)) return;
  const s = stateOf(room);
  if (!s.started || s.over) return;
  const rpc = intOf(byteKeyed(data, 5));
  const args = byteKeyed(data, 4);
  const now = Date.now();
  if (rpc === RPC_SHOT_OCCURED) {
    s.shots.set(actor.actorNr, now);
    return;
  }
  if (rpc === RPC_TAKE_HIT) {
    const view = intOf(byteKeyed(data, 0));
    if (view === null) return;
    const victim = Math.floor(view / 1000);
    if (!victim || victim === actor.actorNr) return;
    const rate = s.rate.get(actor.actorNr);
    if (rate && now - rate.since < 1000) rate.count++;
    else s.rate.set(actor.actorNr, { since: now, count: 1 });
    if (s.rate.get(actor.actorNr).count > MAX_HITS_PER_SECOND && !s.void) {
      s.void = `hit_rate:${actor.actorNr}`;
      log("referee_void", { room: room.name, reason: s.void });
    }
    // A hit with no shot fired just before it is not believed.
    if (now - (s.shots.get(actor.actorNr) || 0) <= SHOT_BEFORE_HIT_MS) s.hits.set(`${actor.actorNr}>${victim}`, now);
    return;
  }
  if (rpc === RPC_PLAYER_DIED && Array.isArray(args) && args.length >= 2) {
    const dead = intOf(args[0]);
    const killer = intOf(args[1]);
    // Only the dead player's own client is believed about its death.
    if (dead !== actor.actorNr) {
      log("referee_ignored", { room: room.name, from: actor.actorNr, dead, killer });
      return;
    }
    const hitAt = s.hits.get(`${killer}>${dead}`) || 0;
    const backed = killer !== dead && now - hitAt <= HIT_WINDOW_MS;
    s.deaths.push({ dead, killer, backed });
    log("referee_death", { room: room.name, dead, killer, backed });
  }
}

export function onRoomProps(room, actor, props) {
  if (!(props instanceof Hashtable)) return;
  const s = stateOf(room);
  if (props.get("gameStarted") === true && !s.started) {
    s.started = true;
    s.startedAt = Date.now();
    for (const a of room.actors.values()) onJoin(room, a);
  }
  if (props.get("gameOver") === true && s.started && !s.over) {
    s.over = true;
    decide(room, "game_over");
  }
}

export function onLeave(room, actor) {
  const s = stateOf(room);
  if (!s.started || s.over || s.posted) return;
  s.left.add(actor.actorNr);
  decide(room, "left");
}

function decide(room, reason) {
  const s = stateOf(room);
  if (s.posted) return;
  const mode = modeOf(room);
  if (!mode || !READABLE.has(mode)) return;
  const actors = [...s.players.keys()].sort((a, b) => a - b);
  if (actors.length !== 2) return;
  s.posted = true;

  const [a, b] = actors;
  if (s.void) {
    log("referee_result", { room: room.name, reason, mode, winner: null, void: s.void, posted: false });
    return;
  }
  // The first death a player's own client reports is that player's loss.
  let loser = s.deaths[0]?.dead ?? null;
  if (loser === null && reason === "left") loser = [...s.left][0];
  if (loser === null && Date.now() - s.startedAt < ROUND_MS) {
    // Ended early with nobody dead: a client set gameOver. Nobody's match.
    log("referee_result", { room: room.name, reason, mode, winner: null, void: "early_over", posted: false });
    return;
  }
  const winner = loser === null ? null : loser === a ? 1 : 0;

  const kills = new Map(actors.map((nr) => [nr, 0]));
  const deaths = new Map(actors.map((nr) => [nr, 0]));
  for (const d of s.deaths) {
    deaths.set(d.dead, (deaths.get(d.dead) || 0) + 1);
    if (d.backed && kills.has(d.killer)) kills.set(d.killer, kills.get(d.killer) + 1);
  }

  const uuid = (nr) => s.players.get(nr)?.uuid || null;
  const teams = [a, b].map((nr) => (uuid(nr) ? [uuid(nr)] : []));
  const players = actors
    .filter((nr) => uuid(nr))
    .map((nr) => ({ uuid: uuid(nr), kills: kills.get(nr), deaths: deaths.get(nr), left: s.left.has(nr) && nr === loser }));
  const result = { matchId: `${room.name}:${room.created}`, mode, rated: Boolean(room.ranked), teams, winner, players };
  log("referee_result", { room: room.name, reason, mode, winner, accounts: players.length });
  if (players.length) postMatch(result);
}
