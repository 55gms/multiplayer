// The Maze map (map flag 16), as client build 2749f7ba makes it (f1008, read by
// f846): a 1080 x 1080 grid of open cells, one per 8 x 8 tiles of the 8640 x
// 8640 map, carved by 150 shrinking worms from the map seed. A tile in a cell
// that is not open is bedrock; an open one has the usual terrain.
//
// The client draws the maze from its own copy, so this must match it exactly:
// the random numbers are std::minstd_rand's and the worm positions are rounded
// to 32 bits where the client rounds them. Checked bit for bit against the
// client's own generator on 8 seeds.
const f = Math.fround;
export const MAZE_SIZE = 1080;
const M = 2147483647;
const TWO_PI = 2 * Math.PI;

// minstd_rand (48271), as libc++ steps it
function next(s) {
  const hi = Math.floor(s / 44488);
  const lo = s - hi * 44488;
  const a = lo * 48271;
  const b = hi * 3399;
  return a < b ? a - b + M : a - b;
}

const cache = new Map();

// The open cells for a seed: a bit per cell, index row * 1080 + column.
export function mazeFor(seed) {
  seed >>>= 0;
  let bits = cache.get(seed);
  if (bits) return bits;
  bits = new Uint8Array((MAZE_SIZE * MAZE_SIZE) / 8);
  let s = seed ? seed % M : 1;
  // each worm takes six numbers: heading, turn rate, turn side, column, row, angle
  for (let worm = 0; worm < 150; worm++) {
    const r1 = (s = next(s)), r2 = (s = next(s)), r3 = (s = next(s)), r4 = (s = next(s));
    const r5 = (s = next(s)), r6 = (s = next(s));
    let angle = (r6 / M + r6 / M) * Math.PI;
    let y = Math.min(r5 / M, 1) * 1080;
    let x = Math.min(r4 / M, 1) * 1080;
    const t = Math.min(r2 / M, 1);
    const turn = (1 - t) * 0.001 + t * 0.005;
    const drift = r3 & 1 ? turn : -turn;
    const heading = (r1 / M + r1 / M) * Math.PI;
    for (let radius = 7.5; radius > 0.125; ) {
      angle += drift;
      const cx = f(x), cy = f(y), r = f(radius);
      const r2d = r * r;
      const c0 = f(f(f(cx - r) - 1)), c1 = f(f(r + cx) + 1);
      const w0 = f(f(f(cy - r) - 1)), w1 = f(f(r + cy) + 1);
      if (c0 < c1 && w0 < w1) {
        for (let u = c0; u < c1; u = f(u + 1)) {
          const col = Math.trunc(u);
          if (col >= 0 && col <= 1079) {
            const dx = cx - u;
            for (let v = w0; v < w1; v = f(v + 1)) {
              const dy = cy - v;
              if (dx * dx + dy * dy > r2d) continue;
              const row = Math.trunc(v);
              if (row < 0 || row > 1079) continue;
              const i = row * 1080 + col;
              bits[i >> 3] |= 1 << (i & 7);
            }
          }
        }
      }
      const dir = Math.sin(fmod(angle, TWO_PI)) * 2.199114857512855 + heading;
      y = radius * Math.sin(dir) * 0.05 + y;
      x = radius * Math.cos(dir) * 0.05 + x;
      radius -= 0.0025;
    }
  }
  cache.set(seed, bits);
  if (cache.size > 8) cache.delete(cache.keys().next().value);
  return bits;
}

// C's fmod (the sign follows the dividend), which JS's % already is
const fmod = (a, b) => a % b;

// Is the tile at tile coordinates tx, ty in an open cell?
export function mazeOpen(tx, ty, seed) {
  const bits = mazeFor(seed);
  const col = Math.min((tx * 1080) / 8640, 1079) | 0;
  const row = Math.min((ty * 1080) / 8640, 1079) | 0;
  const i = row * 1080 + col;
  return (bits[i >> 3] >> (i & 7)) & 1;
}
