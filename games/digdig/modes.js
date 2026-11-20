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
    this.world.autoArena = false; // the round shrinks it
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
        if (this.winner) world.emit({ type: "win", digger: this.winner, mode: "br" });
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
    // whoever is still in plays the next round too; this life ends here
    for (const c of this.lobby.connections) {
      if (!c.digger?.alive) continue;
      c.wantsPlay = true;
      c.endLife(c.digger);
    }
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

// Team Deathmatch (the client's "teams": "3"): each digger joins the team with
// the fewest diggers, wears its colour (component 10 field 66) and cannot hurt
// its own side. The colours are M28's team colours.
export const TEAM_COLORS = [
  [0, 178, 225],
  [241, 78, 84],
  [0, 225, 110],
];

export class TeamDeathmatch extends FreeForAll {
  constructor(lobby) {
    super(lobby);
    this.world = lobby.world;
    this.world.onAdd = (d) => {
      // a squad plays on one team
      const mate = d.squad && [...this.world.diggers.values()].find((o) => o !== d && o.squad === d.squad && o.team != null);
      if (mate) return void (d.team = mate.team);
      const counts = TEAM_COLORS.map(() => 0);
      for (const o of this.world.diggers.values()) if (o !== d && o.team != null) counts[o.team]++;
      d.team = counts.indexOf(Math.min(...counts));
    };
  }
  colorOf(d) {
    return TEAM_COLORS[d.team] || null;
  }
}

// Tag (the client's changelog: tagging someone gives 10 gold, winning as a
// hider 100). Rounds of 5 minutes; nobody is hurt. A few diggers start as
// seekers; a seeker that touches a hider makes it a seeker too. When every
// hider is caught, or time runs out, the round ends and the hiders left win.
// Component 4 field 19 is the time into the round, which the client counts
// down from 300000 ms ("Game restarting").
const TAG_ROUND = sec(300);
const TAG_SHOW = sec(6);
export const SEEKER_COLOR = [230, 60, 60];
const HIDER_COLOR = [153, 153, 153];

export class Tag extends FreeForAll {
  constructor(lobby) {
    super(lobby);
    this.world = lobby.world;
    this.world.peaceful = true;
    this.world.killGold = false;
    this.startTick = this.world.tick;
    this.over = 0;
    // newcomers hide, unless nobody seeks
    this.world.onAdd = (d) => {
      d.seeker = ![...this.world.diggers.values()].some((o) => o !== d && o.seeker);
    };
    this.world.onTouch = (a, b) => {
      if (this.over) return;
      if (a.seeker && !b.seeker) this.tag(a, b);
      else if (b.seeker && !a.seeker) this.tag(b, a);
    };
  }

  tag(seeker, hider) {
    hider.seeker = true;
    seeker.bonusGold = (seeker.bonusGold || 0) + 10;
    seeker.kills++;
    seeker.life.tags++;
  }

  step() {
    const world = this.world;
    const t = world.tick;
    if (this.over) {
      if (t >= this.over) this.restart();
      return;
    }
    const diggers = [...world.diggers.values()];
    const hiders = diggers.filter((d) => !d.seeker);
    // keep at least one seeker for every eight diggers
    const seekers = diggers.length - hiders.length;
    if (diggers.length > 1 && seekers < Math.ceil(diggers.length / 8)) {
      const pick = hiders.sort((a, b) => b.score - a.score)[0];
      if (pick) pick.seeker = true;
    }
    if (diggers.length > 1 && (!diggers.some((d) => !d.seeker) || t - this.startTick >= TAG_ROUND)) {
      for (const d of diggers) if (!d.seeker) d.bonusGold = (d.bonusGold || 0) + 100;
      this.winners = new Set(diggers.filter((d) => !d.seeker));
      for (const d of this.winners) world.emit({ type: "win", digger: d, mode: "tag" });
      this.over = t + TAG_SHOW;
    }
  }

  // everyone hides again and a new seeker is picked
  restart() {
    const diggers = [...this.world.diggers.values()];
    for (const d of diggers) d.seeker = false;
    if (diggers.length) diggers[Math.floor(Math.random() * diggers.length)].seeker = true;
    this.startTick = this.world.tick;
    this.over = 0;
    this.winners = null;
  }

  roundMs() {
    return Math.min(TAG_ROUND, this.world.tick - this.startTick) * TICK_MS;
  }

  colorOf(d) {
    return d.seeker ? SEEKER_COLOR : HIDER_COLOR;
  }

  won(d) {
    return !!this.winners?.has(d);
  }
}

export function rulesFor(mode, lobby) {
  if (mode === "br") return new BattleRoyale(lobby);
  if (mode === "teams") return new TeamDeathmatch(lobby);
  if (mode === "tag") return new Tag(lobby);
  return new FreeForAll(lobby);
}
