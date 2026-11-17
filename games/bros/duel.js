// BasketBros, SoccerBros and BaseballBros: one human against one human,
// lockstep. Nothing is simulated here. The server pairs two players, tells
// both who is on which side, then sends both the same tick 60 times a second
// with each side's latest buttons, and each game steps once per tick.
//
// Client -> server (int32 type first):
//   1 join   (wire.js readJoin)
//   0 input  int a, int b, int c, int d: button bitmasks; the low byte of each is relayed
//   5 score  int mine, int theirs: reported after each goal; not needed here
//   6 chat   int length, text
// Server -> client:
//   1 player int side (0 left, 1 right), int skin, int wins, int losses,
//            int perkCount, perks, 6 outfit bytes, int isYou, int nameLength, name
//   0 tick   int frame, then 4 input bytes for the left side and 4 for the right
//   6 chat   int side, int length, "NAME : text"
import { Writer, cleanText, readJoin, MAX_CHAT } from "./wire.js";
import { startTicking, stopTicking } from "./clock.js";

class Duel {
  constructor(lobby, key) {
    // lobby: delete(key, match) when it stops waiting, ended(match) when everyone has gone
    this.lobby = lobby;
    this.key = key;
    this.sides = [null, null];
    this.inputs = [Buffer.alloc(4), Buffer.alloc(4)];
    this.frame = 0;
    this.started = false;
  }

  players() {
    return this.sides.filter(Boolean);
  }

  add(client) {
    const side = this.sides[0] ? 1 : 0;
    this.sides[side] = client;
    client.side = side;
    client.match = this;
    if (this.sides[0] && this.sides[1]) this.start();
  }

  playerMessage(player, isYou) {
    const { join } = player;
    return new Writer()
      .int(1)
      .int(player.side)
      .int(join.skin)
      .int(join.wins)
      .int(join.losses)
      .int(join.perks.length)
      .bytes(join.perks)
      .bytes(join.outfit)
      .int(isYou ? 1 : 0)
      .string(join.name)
      .finish();
  }

  start() {
    this.started = true;
    this.lobby.delete(this.key, this);
    for (const to of this.sides) {
      for (const player of this.sides) to.send(this.playerMessage(player, player === to));
    }
    startTicking(this);
  }

  tick() {
    this.frame++;
    const msg = new Writer().int(0).int(this.frame).bytes(this.inputs[0]).bytes(this.inputs[1]).finish();
    for (const client of this.sides) client?.send(msg);
  }

  message(client, type, r) {
    if (type === 0) {
      const input = this.inputs[client.side];
      for (let i = 0; i < 4; i++) input[i] = r.intOr0() & 0xff;
    } else if (type === 6) {
      if (!this.started) return;
      const text = cleanText(r.bytes(Math.min(Math.max(r.int(), 0), r.left())), MAX_CHAT);
      if (!text) return;
      const msg = new Writer().int(6).int(client.side).string(`${client.join.name} : ${text}`).finish();
      for (const to of this.sides) to?.send(msg);
    }
    // 5 (score) and anything else: ignored.
  }

  // The one left keeps getting ticks with the other side's buttons released,
  // as on the original servers; the match ends when both have gone.
  leave(client) {
    if (this.sides[client.side] !== client) return;
    this.sides[client.side] = null;
    this.inputs[client.side].fill(0);
    if (!this.started) this.lobby.delete(this.key, this);
    if (!this.players().length) {
      stopTicking(this);
      this.lobby.ended(this);
    }
  }
}

export function duelGame() {
  // Waiting matches by private game number (0 = public matchmaking).
  const waiting = new Map();
  const playing = new Set();
  const lobby = {
    delete(key, match) {
      if (waiting.get(key) === match) waiting.delete(key);
      if (match.started) playing.add(match);
    },
    ended(match) {
      playing.delete(match);
    },
  };

  return {
    join(client, r) {
      client.join = readJoin(r);
      client.join.name = client.join.name.toUpperCase() || "BRO";
      const key = client.join.room;
      let match = waiting.get(key);
      if (!match) {
        match = new Duel(lobby, key);
        waiting.set(key, match);
      }
      match.add(client);
    },
    message(client, type, r) {
      client.match?.message(client, type, r);
    },
    leave(client) {
      client.match?.leave(client);
    },
    stats() {
      return { waiting: waiting.size, matches: playing.size };
    },
  };
}
