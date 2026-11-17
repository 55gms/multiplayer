// FootballBros: a lobby of up to six (three a side) that its host starts,
// then the same lockstep ticks as the classic games, with one entry per
// player instead of one per side.
//
// Client -> server (int32 type first):
//   1 join   (wire.js readJoin; an int 2 follows the name)
//   2 side   int side: move to the other side (at most 3 a side)
//   8 team   int team index: the team for the sender's side
//   7 start  (host only)
//   6 chat   int length, text
//   0 input  int left, int right, int up, int punch, int down (0 or 1 each)
// Server -> client:
//   1 player int clientId, int team, int wins, int losses, int perkCount,
//            perks, 6 outfit bytes, int isYou, int side, int nameLength, name
//   8 team   int clientId, int team; or clientId -1000 - side for a side's team
//   2 side   int clientId, int side
//   3 left   int clientId
//   9 host   (no body): you are the host
//   6 chat   int side, int length, "NAME : text"
//   7 start  then every player's 1 again, then ticks
//   0 tick   int frame, int count, then per player: int clientId, 5 input bytes
import { Writer, cleanText, readJoin, MAX_CHAT } from "./wire.js";
import { startTicking, stopTicking } from "./clock.js";

const PER_SIDE = 3;
const MAX_PLAYERS = PER_SIDE * 2;
const MAX_TEAM = 255;
const SIDE_TEAM_ID = -1000;

// Client ids only need to be unique while a lobby lives; start high, like the original.
let nextClientId = 200_000 + Math.floor(Math.random() * 100_000);

class Lobby {
  constructor(game, key) {
    this.game = game;
    this.key = key;
    this.players = [];
    this.teams = [0, 1];
    this.host = null;
    this.started = false;
    this.frame = 0;
  }

  onSide(side) {
    return this.players.filter((p) => p.side === side);
  }

  full() {
    return this.players.length >= MAX_PLAYERS;
  }

  send(msg, except = null) {
    for (const p of this.players) if (p !== except) p.send(msg);
  }

  playerMessage(player, isYou) {
    const { join } = player;
    return new Writer()
      .int(1)
      .int(player.clientId)
      .int(this.teams[player.side])
      .int(join.wins)
      .int(join.losses)
      .int(join.perks.length)
      .bytes(join.perks)
      .bytes(join.outfit)
      .int(isYou ? 1 : 0)
      .int(player.side)
      .string(join.name)
      .finish();
  }

  sideTeams() {
    return [0, 1].map((side) =>
      new Writer()
        .int(8)
        .int(SIDE_TEAM_ID - side)
        .int(this.teams[side])
        .finish(),
    );
  }

  add(client) {
    client.clientId = nextClientId++;
    client.side = this.onSide(0).length <= this.onSide(1).length ? 0 : 1;
    client.input = Buffer.alloc(5);
    client.match = this;
    // The first player on a side brings their team, unless the other side has it.
    const team = client.join.skin;
    if (!this.onSide(client.side).length && team >= 0 && team <= MAX_TEAM && team !== this.teams[1 - client.side]) {
      this.teams[client.side] = team;
    }
    this.players.push(client);
    this.host ??= client;

    client.send(this.playerMessage(client, true));
    for (const p of this.players) if (p !== client) client.send(this.playerMessage(p, false));
    for (const msg of this.sideTeams()) client.send(msg);
    this.send(this.playerMessage(client, false), client);
    if (this.full()) this.game.unlist(this);
    this.host.send(new Writer().int(9).finish());
  }

  message(client, type, r) {
    if (type === 0) {
      for (let i = 0; i < 5; i++) client.input[i] = r.intOr0() & 0xff;
      return;
    }
    if (type === 6) {
      const text = cleanText(r.bytes(Math.min(Math.max(r.int(), 0), r.left())), MAX_CHAT);
      if (text) this.send(new Writer().int(6).int(client.side).string(`${client.join.name} : ${text}`).finish());
      return;
    }
    if (this.started) return;
    if (type === 2) {
      const side = r.int() === 1 ? 1 : 0;
      if (side !== client.side && this.onSide(side).length < PER_SIDE) {
        client.side = side;
        this.send(new Writer().int(2).int(client.clientId).int(side).finish(), client);
      } else {
        // Refused: put the sender back where the others see it.
        client.send(new Writer().int(2).int(client.clientId).int(client.side).finish());
      }
    } else if (type === 8) {
      const team = r.int();
      if (team < 0 || team > MAX_TEAM || team === this.teams[1 - client.side]) {
        client.send(this.sideTeams()[client.side]);
        return;
      }
      this.teams[client.side] = team;
      this.send(new Writer().int(8).int(client.clientId).int(team).finish(), client);
    } else if (type === 7) {
      if (client === this.host && this.players.length >= 2) this.start();
    }
  }

  start() {
    this.started = true;
    this.game.unlist(this);
    this.send(new Writer().int(7).finish());
    for (const to of this.players) {
      for (const p of this.players) to.send(this.playerMessage(p, p === to));
    }
    startTicking(this);
  }

  tick() {
    this.frame++;
    const w = new Writer().int(0).int(this.frame).int(this.players.length);
    for (const p of this.players) w.int(p.clientId).bytes(p.input);
    this.send(w.finish());
  }

  leave(client) {
    const i = this.players.indexOf(client);
    if (i < 0) return;
    this.players.splice(i, 1);
    this.send(new Writer().int(3).int(client.clientId).finish());
    if (!this.players.length) {
      stopTicking(this);
      this.game.unlist(this);
      this.game.ended(this);
      return;
    }
    if (this.host === client) {
      this.host = this.players[0];
      if (!this.started) this.host.send(new Writer().int(9).finish());
    }
    if (!this.started && !this.full()) this.game.list(this);
  }
}

export function lobbyGame() {
  // Open lobbies by private game number (0 = public), several per number.
  const open = new Map();
  const playing = new Set();
  const game = {
    list(lobby) {
      if (!open.has(lobby.key)) open.set(lobby.key, new Set());
      open.get(lobby.key).add(lobby);
    },
    unlist(lobby) {
      const set = open.get(lobby.key);
      if (!set) return;
      set.delete(lobby);
      if (!set.size) open.delete(lobby.key);
      if (lobby.started) playing.add(lobby);
    },
    ended(lobby) {
      playing.delete(lobby);
    },
  };

  return {
    join(client, r) {
      client.join = readJoin(r, { trailingInt: true });
      client.join.name ||= `BRO${Math.floor(Math.random() * 1e5)}`;
      const key = client.join.room;
      let lobby = open.get(key)?.values().next().value;
      if (!lobby) {
        lobby = new Lobby(game, key);
        game.list(lobby);
      }
      lobby.add(client);
    },
    message(client, type, r) {
      client.match?.message(client, type, r);
    },
    leave(client) {
      client.match?.leave(client);
    },
    stats() {
      let waiting = 0;
      for (const set of open.values()) waiting += set.size;
      return { lobbies: waiting, matches: playing.size };
    },
  };
}
