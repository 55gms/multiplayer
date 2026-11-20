// The digdig.io world: terrain, diggers and the rules, run at 20 ticks a second.
// What the client shows is worked out in README.md; the numbers here (speeds,
// damage, rewards) are ours, tuned to feel like the original.
import { material } from "./terrain.js";

export const TICK_MS = 50;
export const TILE = 16; // world units per tile
export const CHUNK = 64; // tiles per chunk side
export const WORLD_TILES = 8640; // the client's map is 8640 x 8640 tiles

export const M = {
  AMETHYST: 1,
  GOLD: 2,
  DIRT: 3,
  BEDROCK: 5,
  URANIUM: 6,
  LAVA: 7,
  TEAL: 8,
  QUARTZ: 9,
};

// Score for digging one tile of each material.
const TILE_SCORE = { 1: 4, 2: 6, 3: 1, 6: 2, 7: 0, 8: 12, 9: 4 };

const BASE_RADIUS = 25; // a new digger; the client shows score as radius^2 - 625
const MAX_RADIUS = 220;
const BASE_SPEED = 11; // units per tick in an open tunnel, at base radius
const DIG_SLOWDOWN = 0.62; // speed in dirt
const ATTACK_SPEED = 1.35;
const DEFEND_SPEED = 0.6;
const REGEN_PER_TICK = 0.004;
const DEFEND_REGEN = 3;
const ATTACK_DRAIN_PER_TICK = 0.003;
const LAVA_DAMAGE_PER_TICK = 0.012;
const BOOST_TICKS = 20 * 12;
// a digger taking damage flashes red (and its player's screen shakes): one
// pulse at most every HURT_PULSE_TICKS, stronger for more damage
const HURT_PULSE_TICKS = 4;
const HURT_FULL = 0.15; // damage in one pulse that gives the strongest flash

export const INPUT_ATTACK = 1;
export const INPUT_DEFEND = 2;

export class Chunk {
  constructor(cx, cy) {
    this.cx = cx;
    this.cy = cy;
    this.dug = new Uint8Array(512); // bit set = dug
    this.version = 0;
  }
  isDug(lx, ly) {
    const i = ly * 64 + lx;
    return (this.dug[i >> 3] >> (i & 7)) & 1;
  }
  setDug(lx, ly) {
    const i = ly * 64 + lx;
    this.dug[i >> 3] |= 1 << (i & 7);
    this.version++;
  }
}

let nextDiggerId = 1;

export class Digger {
  constructor(world, { name, bot = false, squad = null }) {
    this.id = nextDiggerId++;
    this.world = world;
    this.name = name;
    this.bot = bot;
    this.squad = squad;
    this.x = 0;
    this.y = 0;
    this.angle = 0;
    this.score = 0;
    this.gold = 0;
    this.health = 1;
    this.alive = true;
    this.input = { angle: 0, throttle: 0, buttons: 0 };
    this.uranium = 0; // ticks of mass boost left
    this.amethyst = 0; // ticks of extra vision left
    this.quartz = 0; // ticks of shield left
    this.lastHitBy = null;
    this.hurt = 0; // damage since the last pulse
    this.hurtPulse = 0; // this tick's flash, 1-255 (0 none)
    this.lastPulse = -HURT_PULSE_TICKS;
    this.kills = 0;
    this.spawnTick = world.tick;
    // for the death screen
    this.spawnedAt = Date.now();
    this.diedAt = 0;
    this.maxScore = 0;
  }
  get radius() {
    const r = Math.sqrt(BASE_RADIUS * BASE_RADIUS + this.score);
    return Math.min(MAX_RADIUS, this.uranium > 0 ? r * 1.25 : r);
  }
  // what the client shows next to the name: radius^2 - 625
  get shownScore() {
    return Math.round(this.radius * this.radius - BASE_RADIUS * BASE_RADIUS);
  }
  get vision() {
    // tiles of dirt the digger can see into, beyond its own edge
    return 3 + (this.amethyst > 0 ? 6 : 0);
  }
}

export class World {
  constructor({ seed = (Math.random() * 2 ** 31) | 0, flags = 0, radiusTiles = 360 } = {}) {
    this.seed = seed;
    this.flags = flags;
    this.tick = 0;
    this.chunks = new Map();
    this.diggers = new Map();
    // the arena is a circle in the middle of the client's map
    this.center = (WORLD_TILES / 2) * TILE;
    this.radius = radiusTiles * TILE;
    this.listeners = new Set(); // (event) => void: kill, death
    this.materialCache = new Map();
    this.peaceful = false; // no damage (a Battle Royale countdown)
    this.killGold = true; // kills earn a share of the victim's gold (FFA, TDM)
  }

  chunk(cx, cy) {
    const key = cx * 65536 + cy;
    let c = this.chunks.get(key);
    if (!c) {
      c = new Chunk(cx, cy);
      this.chunks.set(key, c);
    }
    return c;
  }

  peekChunk(cx, cy) {
    return this.chunks.get(cx * 65536 + cy);
  }

  inArena(tx, ty) {
    const dx = (tx + 0.5) * TILE - this.center;
    const dy = (ty + 0.5) * TILE - this.center;
    return dx * dx + dy * dy < this.radius * this.radius;
  }

  material(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= WORLD_TILES || ty >= WORLD_TILES) return M.BEDROCK;
    return material(tx, ty, this.seed, this.flags);
  }

  isDug(tx, ty) {
    const c = this.peekChunk(tx >> 6, ty >> 6);
    return c ? c.isDug(tx & 63, ty & 63) : 0;
  }

  // solid and diggable / solid and not
  tileAt(tx, ty) {
    if (!this.inArena(tx, ty)) return M.BEDROCK;
    if (this.isDug(tx, ty)) return 0;
    return this.material(tx, ty);
  }

  dig(tx, ty) {
    this.chunk(tx >> 6, ty >> 6).setDug(tx & 63, ty & 63);
  }

  // A free spot: open tunnel or dirt, away from other diggers.
  spawnPoint() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * (this.radius - 400);
      const x = this.center + Math.cos(a) * d;
      const y = this.center + Math.sin(a) * d;
      const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
      const m = this.tileAt(tx, ty);
      if (m === M.BEDROCK || m === M.LAVA) continue;
      let near = false;
      for (const o of this.diggers.values()) if (Math.hypot(o.x - x, o.y - y) < 600) near = true;
      if (near && attempt < 150) continue;
      return { x, y };
    }
    return { x: this.center, y: this.center };
  }

  addDigger(opts) {
    const d = new Digger(this, opts);
    const p = this.spawnPoint();
    d.x = p.x;
    d.y = p.y;
    d.angle = Math.random() * Math.PI * 2;
    this.diggers.set(d.id, d);
    this.onAdd?.(d); // the mode's say: a team, a role
    this.digAround(d);
    return d;
  }

  removeDigger(d) {
    d.alive = false;
    this.diggers.delete(d.id);
  }

  emit(event) {
    for (const fn of this.listeners) fn(event);
  }

  // Dig every tile under the digger; returns how many solid tiles were in its way.
  digAround(d) {
    const r = d.radius;
    const t0x = Math.floor((d.x - r) / TILE), t1x = Math.floor((d.x + r) / TILE);
    const t0y = Math.floor((d.y - r) / TILE), t1y = Math.floor((d.y + r) / TILE);
    let solid = 0;
    let lava = false;
    for (let ty = t0y; ty <= t1y; ty++) {
      for (let tx = t0x; tx <= t1x; tx++) {
        const cx = (tx + 0.5) * TILE - d.x, cy = (ty + 0.5) * TILE - d.y;
        if (cx * cx + cy * cy > r * r) continue;
        const m = this.tileAt(tx, ty);
        if (!m || m === M.BEDROCK) continue;
        solid++;
        if (m === M.LAVA) lava = true;
        this.dig(tx, ty);
        this.reward(d, m);
      }
    }
    if (lava) this.damage(d, LAVA_DAMAGE_PER_TICK, null);
    return solid;
  }

  reward(d, m) {
    d.score += TILE_SCORE[m] || 0;
    if (m === M.GOLD) d.gold++;
    if (m === M.URANIUM) d.uranium = BOOST_TICKS;
    if (m === M.AMETHYST) d.amethyst = BOOST_TICKS * 2;
    if (m === M.QUARTZ) d.quartz = BOOST_TICKS;
  }

  damage(d, amount, from) {
    if (!d.alive || this.peaceful) return;
    if (d.quartz > 0) amount /= 2;
    if (d.input.buttons & INPUT_DEFEND) amount *= 0.6;
    d.health -= amount;
    d.hurt += amount;
    if (from) d.lastHitBy = from;
    if (d.health <= 0) this.kill(d);
  }

  kill(d) {
    d.health = 0;
    d.diedAt = Date.now();
    const killer = d.lastHitBy && d.lastHitBy.alive ? d.lastHitBy : null;
    if (killer) {
      killer.score += Math.round(d.score * 0.5) + 50;
      killer.kills++;
      // the client's changelog: a kill gives 10% of the gold the victim collected
      // (who keeps theirs); paid with the killer's own gold when its life ends
      if (this.killGold) killer.bonusGold = (killer.bonusGold || 0) + Math.floor((d.gold + (d.bonusGold || 0)) * 0.1);
    }
    this.removeDigger(d);
    this.emit({ type: "death", digger: d, killer });
  }

  // Would the digger hit bedrock (or the arena edge) at x, y?
  blocked(d, x, y) {
    const r = d.radius * 0.8;
    const t0x = Math.floor((x - r) / TILE), t1x = Math.floor((x + r) / TILE);
    const t0y = Math.floor((y - r) / TILE), t1y = Math.floor((y + r) / TILE);
    for (let ty = t0y; ty <= t1y; ty++) {
      for (let tx = t0x; tx <= t1x; tx++) {
        const cx = (tx + 0.5) * TILE - x, cy = (ty + 0.5) * TILE - y;
        if (cx * cx + cy * cy > r * r) continue;
        if (this.tileAt(tx, ty) === M.BEDROCK && !this.isDug(tx, ty)) return true;
      }
    }
    return false;
  }

  step() {
    this.tick++;
    const list = [...this.diggers.values()];
    for (const d of list) d.hurtPulse = 0;
    for (const d of list) this.move(d);
    this.collide(list);
    for (const d of list) {
      if (!d.alive) continue;
      if (d.uranium > 0) d.uranium--;
      if (d.amethyst > 0) d.amethyst--;
      if (d.quartz > 0) d.quartz--;
      const regen = REGEN_PER_TICK * (d.input.buttons & INPUT_DEFEND ? DEFEND_REGEN : 1);
      if (d.input.buttons & INPUT_ATTACK) d.health -= ATTACK_DRAIN_PER_TICK;
      else d.health = Math.min(1, d.health + regen);
      if (d.health <= 0) this.kill(d);
      if (d.alive) d.maxScore = Math.max(d.maxScore, d.shownScore);
      // big diggers slowly lose mass, so the board keeps moving
      if (d.score > 2000) d.score -= d.score * 0.0002;
      if (d.alive && d.hurt > 0 && this.tick - d.lastPulse >= HURT_PULSE_TICKS) {
        d.hurtPulse = Math.max(48, Math.min(255, Math.round(255 * Math.sqrt(d.hurt / HURT_FULL))));
        d.hurt = 0;
        d.lastPulse = this.tick;
      }
    }
  }

  move(d) {
    const { angle, throttle, buttons } = d.input;
    let speed = BASE_SPEED * Math.pow(BASE_RADIUS / d.radius, 0.35) * throttle;
    if (buttons & INPUT_ATTACK) speed *= ATTACK_SPEED;
    else if (buttons & INPUT_DEFEND) speed *= DEFEND_SPEED;
    // turn towards the input, quicker when small
    let diff = angle - d.angle;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const turn = 0.35 * Math.pow(BASE_RADIUS / d.radius, 0.3);
    d.angle += Math.max(-turn, Math.min(turn, diff));
    // dirt ahead slows the digger down
    const ahead = this.solidAhead(d);
    if (ahead) speed *= DIG_SLOWDOWN;
    let nx = d.x + Math.cos(d.angle) * speed;
    let ny = d.y + Math.sin(d.angle) * speed;
    if (this.blocked(d, nx, ny)) {
      // slide along bedrock
      if (!this.blocked(d, nx, d.y)) ny = d.y;
      else if (!this.blocked(d, d.x, ny)) nx = d.x;
      else return;
    }
    // stay inside the arena
    const dx = nx - this.center, dy = ny - this.center;
    const max = this.radius - d.radius;
    const dist = Math.hypot(dx, dy);
    if (dist > max) {
      nx = this.center + (dx / dist) * max;
      ny = this.center + (dy / dist) * max;
    }
    d.x = nx;
    d.y = ny;
    this.digAround(d);
  }

  // on the same side (a team, a squad): they push each other but do no damage
  friends(a, b) {
    return (a.team != null && a.team === b.team) || (a.squad != null && a.squad === b.squad);
  }

  solidAhead(d) {
    const r = d.radius;
    const px = d.x + Math.cos(d.angle) * (r + TILE * 0.5);
    const py = d.y + Math.sin(d.angle) * (r + TILE * 0.5);
    const m = this.tileAt(Math.floor(px / TILE), Math.floor(py / TILE));
    return m !== 0;
  }

  collide(list) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!b.alive) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const overlap = a.radius + b.radius - dist;
        if (overlap <= 0) continue;
        // push apart, the smaller one more
        const ma = a.radius * a.radius, mb = b.radius * b.radius;
        const nx = dx / dist, ny = dy / dist;
        a.x -= nx * overlap * (mb / (ma + mb));
        a.y -= ny * overlap * (mb / (ma + mb));
        b.x += nx * overlap * (ma / (ma + mb));
        b.y += ny * overlap * (ma / (ma + mb));
        this.onTouch?.(a, b);
        if (this.friends(a, b)) continue;
        // the bigger one does more damage; attacking does more
        const hit = (from, to) => {
          const ratio = from.radius / to.radius;
          let dmg = 0.02 * ratio * ratio;
          if (from.input.buttons & INPUT_ATTACK) dmg *= 1.8;
          this.damage(to, dmg, from);
        };
        hit(a, b);
        if (b.alive && a.alive) hit(b, a);
      }
    }
  }
}
