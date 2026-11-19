// Bots that keep a digdig.io lobby busy. Each one, about twice a second:
// runs from a much bigger digger it can sense, hunts a smaller one (players and
// other bots alike, attacking once close), or else farms: heads for the nearest
// ore it can sense, or wanders, steering clear of bedrock, lava and the edge.
import { TILE, M, INPUT_ATTACK, INPUT_DEFEND } from "./world.js";

const NAMES = [
  "Mole", "Drillbit", "Gopher", "Tunnel Rat", "Rocky", "Dusty", "Pebble", "Excavator", "Burrow",
  "Digby", "Shovel", "Nugget", "Quartzy", "Bedrock Bob", "Miner 49", "Spelunk", "Grit", "Clod",
  "Augur", "Dirt Devil", "Badger", "Wormy", "Gravel", "Pickaxe", "Lode", "Sandy", "Boulder",
];

const SENSE = 900; // units
const ORE_SENSE_TILES = 14;
const ORES = new Set([M.GOLD, M.TEAL, M.AMETHYST, M.QUARTZ, M.URANIUM]);

export function botName(taken) {
  const free = NAMES.filter((n) => !taken.has(n));
  const pool = free.length ? free : NAMES;
  return pool[Math.floor(Math.random() * pool.length)];
}

export class Bot {
  constructor(world, digger) {
    this.world = world;
    this.d = digger;
    this.next = 0;
    this.wander = Math.random() * Math.PI * 2;
    this.target = null;
    // a little personality: how brave and how greedy
    this.courage = 0.8 + Math.random() * 0.5;
    this.aggression = 0.6 + Math.random() * 0.6;
  }

  think() {
    const d = this.d;
    if (!d.alive) return;
    const world = this.world;
    if (world.tick < this.next) return this.steer();
    this.next = world.tick + 6 + Math.floor(Math.random() * 6);

    let threat = null, prey = null;
    let threatDist = Infinity, preyScore = -Infinity;
    for (const o of world.diggers.values()) {
      if (o === d || !o.alive) continue;
      const dist = Math.hypot(o.x - d.x, o.y - d.y) - o.radius - d.radius;
      if (dist > SENSE) continue;
      if (o.radius > d.radius * 1.12 * this.courage) {
        if (dist < threatDist) (threat = o), (threatDist = dist);
      } else if (o.radius * 1.12 < d.radius * this.aggression + d.radius * 0.4) {
        // prefer close, big-enough prey (more score), players a little more
        const s = o.radius * 2 - dist * 0.08 + (o.bot ? 0 : 15);
        if (s > preyScore) (prey = o), (preyScore = s);
      }
    }

    if (threat && threatDist < 500) {
      this.mode = "flee";
      this.angle = Math.atan2(d.y - threat.y, d.x - threat.x);
      this.buttons = threatDist < 120 ? (d.health > 0.35 ? INPUT_ATTACK : INPUT_DEFEND) : 0;
    } else if (prey && d.health > 0.35) {
      this.mode = "hunt";
      // lead the target a little
      const lead = Math.min(1, Math.hypot(prey.x - d.x, prey.y - d.y) / 600);
      const px = prey.x + Math.cos(prey.angle) * prey.radius * 2 * lead;
      const py = prey.y + Math.sin(prey.angle) * prey.radius * 2 * lead;
      this.angle = Math.atan2(py - d.y, px - d.x);
      const close = Math.hypot(prey.x - d.x, prey.y - d.y) < (d.radius + prey.radius) * 2.2;
      this.buttons = close && d.health > 0.5 ? INPUT_ATTACK : 0;
    } else {
      this.mode = "farm";
      this.buttons = d.health < 0.5 ? INPUT_DEFEND : 0;
      const ore = this.nearestOre();
      if (ore) {
        this.angle = Math.atan2(ore.y - d.y, ore.x - d.x);
      } else {
        this.wander += (Math.random() - 0.5) * 0.9;
        this.angle = this.wander;
      }
    }
    this.angle = this.avoid(this.angle);
    this.steer();
  }

  steer() {
    const d = this.d;
    d.input = { angle: this.angle ?? d.angle, throttle: 1, buttons: this.buttons || 0 };
  }

  nearestOre() {
    const d = this.d, world = this.world;
    const tx = Math.floor(d.x / TILE), ty = Math.floor(d.y / TILE);
    let best = null, bestDist = Infinity;
    // sample a ring of points rather than every tile
    for (let r = 2; r <= ORE_SENSE_TILES; r += 2) {
      for (let k = 0; k < r * 4; k++) {
        const a = (k / (r * 4)) * Math.PI * 2;
        const x = tx + Math.round(Math.cos(a) * r), y = ty + Math.round(Math.sin(a) * r);
        const m = world.tileAt(x, y);
        if (!ORES.has(m)) continue;
        const dist = Math.hypot(x - tx, y - ty);
        if (dist < bestDist) (bestDist = dist), (best = { x: (x + 0.5) * TILE, y: (y + 0.5) * TILE });
      }
      if (best) break;
    }
    return best;
  }

  // Turn away from bedrock, lava and the arena edge in front.
  avoid(angle) {
    const d = this.d, world = this.world;
    const bad = (a) => {
      for (const step of [1.5, 3]) {
        const x = d.x + Math.cos(a) * (d.radius + TILE * step * 2);
        const y = d.y + Math.sin(a) * (d.radius + TILE * step * 2);
        const m = world.tileAt(Math.floor(x / TILE), Math.floor(y / TILE));
        if (m === M.BEDROCK || m === M.LAVA) return true;
        if (Math.hypot(x - world.center, y - world.center) > world.radius - d.radius - 40) return true;
      }
      return false;
    };
    if (!bad(angle)) return angle;
    for (let k = 1; k <= 8; k++) {
      for (const s of [1, -1]) {
        const a = angle + s * k * 0.35;
        if (!bad(a)) {
          this.wander = a;
          return a;
        }
      }
    }
    return angle + Math.PI;
  }
}
