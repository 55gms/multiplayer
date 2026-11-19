// Mode rules on top of the shared world. FFA needs none; Battle Royale runs
// rounds: waiting, a countdown, a shrinking arena, a winner, then again.
//
// What the client is told (README.md): component 4 field 17 is 2 while a round
// runs, 8 during a countdown (field 21, ms left) and 0 for "Waiting for players";
// field 12 is the arena's diameter; view field 35 bit 8 shows "YOU HAVE WON".
import { TICK_MS } from "./world.js";

// DIGDIG_TIME_SCALE shortens the rounds for testing
const SCALE = Number(process.env.DIGDIG_TIME_SCALE) || 1;
const sec = (s) => Math.round((s * SCALE * 1000) / TICK_MS);

export const STATE_RUNNING = 2;
export const STATE_COUNTDOWN = 8;
export const STATE_WAITING = 0;

export class FreeForAll {
  constructor(lobby) {
    this.lobby = lobby;
  }
  canSpawn() {
    return true;
  }
  wantBots() {
    return true;
  }
  step() {}
  arena() {
    return { state: STATE_RUNNING, countdownMs: 0 };
  }
}

const BR_COUNTDOWN = sec(15);
const BR_SHRINK = sec(150); // from full size to the last circle
const BR_OVERTIME = sec(60); // then the biggest digger left wins
const BR_SHOW_WINNER = sec(7);
const BR_MIN_RADIUS = 30 * 16; // the last circle, in world units

export class BattleRoyale {
  constructor(lobby) {
    this.lobby = lobby;
    this.world = lobby.world;
    this.fullRadius = this.world.radius;
    this.state = "waiting";
    this.until = 0;
    this.startTick = 0;
    this.winner = null;
  }

  // Players join during the wait and the countdown; once the round runs they
  // wait for the next one.
  canSpawn() {
    return this.state === "waiting" || this.state === "countdown";
  }

  // bots join at the countdown and nobody replaces the ones that die
  wantBots() {
    return this.state === "countdown";
  }

  humans() {
    return [...this.lobby.connections].filter((c) => c.started);
  }

  // everyone starts a round the same size
  botScore() {
    return 0;
  }

  step() {
    const world = this.world;
    const t = world.tick;
    world.peaceful = this.state !== "running";
    if (this.state === "waiting") {
      if (this.humans().length) {
        this.state = "countdown";
        this.until = t + BR_COUNTDOWN;
        this.lobby.fillBots(true);
        for (const c of this.lobby.connections) if (c.wantsPlay) c.spawn();
      }
    } else if (this.state === "countdown") {
      if (!this.humans().length) return this.reset("waiting");
      if (t >= this.until) {
        this.state = "running";
        this.startTick = t;
      }
    } else if (this.state === "running") {
      const k = Math.min(1, (t - this.startTick) / BR_SHRINK);
      world.radius = this.fullRadius - (this.fullRadius - BR_MIN_RADIUS) * k;
      const alive = [...world.diggers.values()];
      const overtime = t - this.startTick > BR_SHRINK + BR_OVERTIME;
      if (alive.length <= 1 || overtime || !this.humans().length) {
        this.winner = alive.sort((a, b) => b.score - a.score)[0] || null;
        this.state = "over";
        this.until = t + BR_SHOW_WINNER;
      }
    } else if (this.state === "over" && t >= this.until) {
      this.reset(this.humans().length ? "countdown" : "waiting");
    }
  }

  // a fresh round: everyone out, the tunnels filled in, the arena full size
  reset(next) {
    const world = this.world;
    // whoever is still in plays the next round too
    for (const c of this.lobby.connections) if (c.digger?.alive) c.wantsPlay = true;
    for (const d of [...world.diggers.values()]) world.removeDigger(d);
    this.lobby.bots.clear();
    world.chunks.clear();
    world.radius = this.fullRadius;
    this.winner = null;
    this.state = next;
    if (next === "countdown") {
      this.until = world.tick + BR_COUNTDOWN;
      this.lobby.fillBots(true);
      for (const c of this.lobby.connections) if (c.wantsPlay) c.spawn();
    }
  }

  arena() {
    if (this.state === "countdown") return { state: STATE_COUNTDOWN, countdownMs: Math.max(0, (this.until - this.world.tick) * TICK_MS) };
    if (this.state === "waiting") return { state: STATE_WAITING, countdownMs: 0, needed: 1 };
    return { state: STATE_RUNNING, countdownMs: 0 };
  }

  won(digger) {
    return this.state === "over" && digger && digger === this.winner;
  }
}

export function rulesFor(mode, lobby) {
  if (mode === "br") return new BattleRoyale(lobby);
  return new FreeForAll(lobby);
}
