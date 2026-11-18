// Referees a match on the other server (remote.js) for the 55GMS player in
// it, from the messages its relay passes through, so the match still counts
// for XP, stats and the battle pass. The rules are referee.js's own: it is
// fed the same RPCs, room properties and leaves as a room here would give
// it. The player's own events are read on the way out (the other server
// does not echo them); everyone else's on the way in, where the other
// server names the sender, so the player cannot speak for their opponent.
// These matches are never rated: ranked stays on this server.
//
// It only watches: nothing it sees changes what is relayed.
import { randomBytes } from "node:crypto";
import { Hashtable, Reader, num } from "../../src/photon/protocol18.js";
import { MsgType, Op, Param, Err, Ev } from "../../src/photon/codes.js";
import * as referee from "./referee.js";
import { accountsEnabled } from "./accounts.js";
import { log } from "../../src/log.js";

const MAGIC = 0xf3;
const RPC_EVENT = 200;

function intOf(v) {
  const n = num(v);
  return Number.isInteger(n) ? n : null;
}

// Returns { out(buf), in(buf), end() }, or null when there is nobody to
// credit (a guest, or 55GMS accounts off).
export function remoteReferee(account) {
  if (!accountsEnabled || !account?.uuid) return null;
  let room = null;
  let own = null;
  let asked = null; // the room name the player asked for

  function actorOf(nr) {
    let actor = room.actors.get(nr);
    if (!actor) {
      actor = { actorNr: nr, peer: { state: nr === own ? { account } : {} } };
      room.actors.set(nr, actor);
    }
    return actor;
  }

  function roomProps(props, nr) {
    if (!room || !(props instanceof Hashtable)) return;
    for (const [k, v] of props) {
      if (typeof k !== "string") continue;
      if (v === null) room.props.delete(k);
      else room.props.set(k, v);
    }
    referee.onRoomProps(room, actorOf(nr ?? own), props);
  }

  // A joined or created room: a fresh match.
  function joined(params) {
    const nr = intOf(params.get(Param.ActorNr));
    if (!nr) return;
    if (room) left(own);
    own = nr;
    const name = params.get(Param.RoomName) ?? asked;
    room = {
      name: `remote:${typeof name === "string" && name ? name.slice(0, 64) : randomBytes(9).toString("base64url")}`,
      created: Date.now(),
      ranked: false,
      props: new Hashtable(),
      actors: new Map(),
    };
    actorOf(own);
    const players = params.get(Param.PlayerProperties);
    if (players instanceof Hashtable) {
      for (const [k] of players) {
        const other = intOf(k);
        if (other > 0) actorOf(other);
      }
    }
    roomProps(params.get(Param.GameProperties), own);
  }

  function left(nr) {
    if (!room || !room.actors.has(nr)) return;
    referee.onLeave(room, room.actors.get(nr));
    room.actors.delete(nr);
  }

  // The player's operations, on the way out.
  function out(buf) {
    if (buf.length < 3 || buf[0] !== MAGIC || buf[1] !== MsgType.Operation) return;
    const op = buf[2];
    if (op === Op.JoinGame || op === Op.CreateGame) {
      const name = new Reader(buf, 3).params().get(Param.RoomName);
      asked = typeof name === "string" ? name : null;
      return;
    }
    if (!room) return;
    if (op === Op.Leave) return left(own);
    if (op === Op.RaiseEvent) {
      const params = new Reader(buf, 3).params();
      const code = intOf(params.get(Param.Code));
      if (code === RPC_EVENT) referee.onEvent(room, actorOf(own), code, params.get(Param.Data));
      return;
    }
    if (op === Op.SetProperties) {
      const params = new Reader(buf, 3).params();
      if (!intOf(params.get(Param.ActorNr))) roomProps(params.get(Param.Properties), own);
    }
  }

  // The other server's answers and events, on the way in.
  function into(buf) {
    if (buf.length < 3 || buf[0] !== MAGIC) return;
    const type = buf[1];
    const code = buf[2];
    if (type === MsgType.OperationResponse) {
      if (code !== Op.JoinGame && code !== Op.CreateGame && code !== Op.JoinRandomGame) return;
      if (buf.length < 6 || buf.readInt16LE(3) !== Err.Ok) return;
      const r = new Reader(buf, 5);
      r.value(); // debug message
      return joined(r.params());
    }
    if (type !== MsgType.Event || !room) return;
    if (code !== RPC_EVENT && code !== Ev.Join && code !== Ev.Leave && code !== Ev.PropertiesChanged) return;
    const params = new Reader(buf, 3).params();
    const sender = intOf(params.get(Param.ActorNr));
    if (code === RPC_EVENT) {
      // The player's own come from the way out.
      if (sender && sender !== own && room.actors.has(sender)) referee.onEvent(room, room.actors.get(sender), code, params.get(Param.Data));
      return;
    }
    if (code === Ev.Join) {
      if (sender && sender !== own) actorOf(sender);
      return;
    }
    if (code === Ev.Leave) {
      if (sender && sender !== own) left(sender);
      return;
    }
    if (!intOf(params.get(Param.TargetActorNr))) roomProps(params.get(Param.Properties), sender);
  }

  function guard(fn) {
    return (buf) => {
      try {
        fn(buf);
      } catch (err) {
        log("remote_referee_error", { error: String(err.message || err) });
      }
    };
  }

  return { out: guard(out), in: guard(into), end: guard(() => left(own)) };
}
