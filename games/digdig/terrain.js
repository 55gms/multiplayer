// The digdig.io map, worked out from client build 2749f7ba (f846, f601). The
// client draws every tile from this, so the server must agree with it exactly:
// floats are rounded to 32 bits at the same steps as the client.
//
// Tiles are 16 world units. material(x, y) gives the tile at tile coordinates
// x, y for a map seed (component 4 field 27) and map flags (field 11).

import { mazeOpen } from "./maze.js";

const f = Math.fround;

// Perlin's permutation as the client has it (memory 48608, stored twice there).
const PERM = [
  23, 125, 161, 52, 103, 117, 70, 37, 247, 101, 203, 169, 124, 126, 44, 123, 152, 238, 145, 45, 171, 114, 253, 10, 192, 136, 4, 157, 249, 30, 35, 72,
  175, 63, 77, 90, 181, 16, 96, 111, 133, 104, 75, 162, 93, 56, 66, 240, 8, 50, 84, 229, 49, 210, 173, 239, 141, 1, 87, 18, 2, 198, 143, 57,
  225, 160, 58, 217, 168, 206, 245, 204, 199, 6, 73, 60, 20, 230, 211, 233, 94, 200, 88, 9, 74, 155, 33, 15, 219, 130, 226, 202, 83, 236, 42, 172,
  165, 218, 55, 222, 46, 107, 98, 154, 109, 67, 196, 178, 127, 158, 13, 243, 65, 79, 166, 248, 25, 224, 115, 80, 68, 51, 184, 128, 232, 208, 151, 122,
  26, 212, 105, 43, 179, 213, 235, 148, 146, 89, 14, 195, 28, 78, 112, 76, 250, 47, 24, 251, 140, 108, 186, 190, 228, 170, 183, 139, 39, 188, 244, 246,
  132, 48, 119, 144, 180, 138, 134, 193, 82, 182, 120, 121, 86, 220, 209, 3, 91, 241, 149, 85, 205, 150, 113, 216, 31, 100, 41, 164, 177, 214, 153, 231,
  38, 71, 185, 174, 97, 201, 29, 95, 7, 92, 54, 254, 191, 118, 34, 221, 131, 11, 163, 99, 234, 81, 227, 147, 156, 176, 17, 142, 69, 12, 110, 62,
  27, 255, 0, 194, 59, 116, 242, 252, 19, 21, 187, 53, 207, 129, 64, 135, 61, 40, 167, 237, 102, 223, 106, 159, 197, 189, 215, 137, 36, 32, 22, 5,
];
// Gradient for each lattice hash (memory 49120): an index into GRAD.
const HASH_GRAD = [
  7, 9, 5, 0, 11, 1, 6, 9, 3, 9, 11, 1, 8, 10, 4, 7, 8, 6, 1, 5, 3, 10, 9, 10, 0, 8, 4, 1, 5, 2, 7, 8,
  7, 11, 9, 10, 1, 0, 4, 7, 5, 0, 11, 6, 1, 4, 2, 8, 8, 10, 4, 9, 9, 2, 5, 7, 9, 1, 7, 2, 2, 6, 11, 5,
  5, 4, 6, 9, 0, 1, 1, 0, 7, 6, 9, 8, 4, 10, 3, 1, 2, 8, 8, 9, 10, 11, 5, 11, 11, 2, 6, 10, 3, 4, 2, 4,
  9, 10, 3, 2, 6, 3, 6, 10, 5, 3, 4, 10, 11, 2, 9, 11, 1, 11, 10, 4, 9, 4, 11, 0, 4, 11, 4, 0, 0, 0, 7, 6,
  10, 4, 1, 3, 11, 5, 3, 4, 2, 9, 1, 3, 0, 1, 8, 0, 6, 7, 8, 7, 0, 4, 6, 10, 8, 2, 3, 11, 11, 8, 0, 2,
  4, 8, 3, 0, 0, 10, 6, 1, 2, 2, 4, 5, 6, 0, 1, 3, 11, 9, 5, 5, 9, 6, 9, 8, 3, 8, 1, 8, 9, 6, 9, 11,
  10, 7, 5, 6, 5, 9, 1, 3, 7, 0, 2, 10, 11, 2, 6, 1, 3, 11, 7, 7, 2, 1, 7, 3, 0, 8, 1, 1, 5, 0, 6, 10,
  11, 11, 0, 2, 7, 0, 10, 8, 3, 5, 7, 1, 11, 1, 0, 7, 9, 0, 11, 5, 10, 3, 2, 3, 5, 9, 7, 9, 8, 4, 6, 5,
  7, 9, 5, 0, 11, 1, 6, 9, 3, 9, 11, 1, 8, 10, 4, 7, 8, 6, 1, 5, 3, 10, 9, 10, 0, 8, 4, 1, 5, 2, 7, 8,
  7, 11, 9, 10, 1, 0, 4, 7, 5, 0, 11, 6, 1, 4, 2, 8, 8, 10, 4, 9, 9, 2, 5, 7, 9, 1, 7, 2, 2, 6, 11, 5,
  5, 4, 6, 9, 0, 1, 1, 0, 7, 6, 9, 8, 4, 10, 3, 1, 2, 8, 8, 9, 10, 11, 5, 11, 11, 2, 6, 10, 3, 4, 2, 4,
  9, 10, 3, 2, 6, 3, 6, 10, 5, 3, 4, 10, 11, 2, 9, 11, 1, 11, 10, 4, 9, 4, 11, 0, 4, 11, 4, 0, 0, 0, 7, 6,
  10, 4, 1, 3, 11, 5, 3, 4, 2, 9, 1, 3, 0, 1, 8, 0, 6, 7, 8, 7, 0, 4, 6, 10, 8, 2, 3, 11, 11, 8, 0, 2,
  4, 8, 3, 0, 0, 10, 6, 1, 2, 2, 4, 5, 6, 0, 1, 3, 11, 9, 5, 5, 9, 6, 9, 8, 3, 8, 1, 8, 9, 6, 9, 11,
  10, 7, 5, 6, 5, 9, 1, 3, 7, 0, 2, 10, 11, 2, 6, 1, 3, 11, 7, 7, 2, 1, 7, 3, 0, 8, 1, 1, 5, 0, 6, 10,
  11, 11, 0, 2, 7, 0, 10, 8, 3, 5, 7, 1, 11, 1, 0, 7, 9, 0, 11, 5, 10, 3, 2, 3, 5, 9, 7, 9, 8, 4, 6, 5,
];
const GRAD = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1],
  [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

const P = (i) => PERM[i & 255];

function floorI(v) {
  const t = Math.trunc(v);
  return f(t) > v ? t - 1 : t;
}

function grad(h, dx, dy, dz) {
  const g = GRAD[HASH_GRAD[h]];
  return f(f(g[2] * dz) + f(f(g[0] * dx) + f(dy * g[1])));
}

const fade = (t) => f(t * f(t * f(t * f(f(t * f(f(t * 6) - 15)) + 10))));
const lerp = (a, b, t) => f(f(f(b - a) * t) + a);

// 3D Perlin noise in 32-bit floats; seed is the low byte of the map seed.
export function noise(x, y, z, seed) {
  x = f(x); y = f(y); z = f(z);
  const xi = floorI(x), yi = floorI(y), zi = floorI(z);
  const Y = yi & 255, Y1 = (yi + 1) & 255, Z = zi & 255, Z1 = (zi + 1) & 255;
  const a = P((xi & 255) + seed), b = P(((xi + 1) & 255) + seed);
  const AA = P(Y + a), AB = P(a + Y1), BA = P(Y + b), BB = P(Y1 + b);
  const xf = f(x - xi), yf = f(y - yi), zf = f(z - zi);
  const x1 = f(xf - 1), y1 = f(yf - 1), z1 = f(zf - 1);
  const fx = fade(xf), fy = fade(yf), fz = fade(zf);
  const l1 = lerp(grad(Z + BB, x1, y1, zf), grad(Z1 + BB, x1, y1, z1), fz);
  const l2 = lerp(grad(Z + BA, x1, yf, zf), grad(Z1 + BA, x1, yf, z1), fz);
  const m1 = lerp(grad(Z + AB, xf, y1, zf), grad(Z1 + AB, xf, y1, z1), fz);
  const m2 = lerp(grad(Z + AA, xf, yf, zf), grad(Z1 + AA, xf, yf, z1), fz);
  return lerp(lerp(m2, m1, fy), lerp(l2, l1, fy), fx);
}

// Map flags (component 4 field 11).
export const FLAG_NO_BIG_VEINS = 1;
export const FLAG_NO_ROCK_PATCHES = 2;
export const FLAG_NO_MATERIAL_2 = 4;
export const FLAG_NO_MATERIAL_9 = 8;
export const FLAG_MAZE = 16; // walls of bedrock outside the maze (maze.js)

// Tile material at tile coordinates x, y. 3 is plain dirt; the others are worked
// out from how the client draws them (see README.md).
export function material(x, y, seed, flags = 0) {
  if (flags & FLAG_MAZE && !mazeOpen(x, y, seed)) return 5;
  const s = seed & 255;
  const n = (sx, sy, z) => noise(f(x * sx), f(y * sy), z, s);
  if (!(flags & FLAG_NO_BIG_VEINS)) {
    const v = n(0.01, 0.01, 10);
    if (v > 0.75) return 8;
    if (v > 0.6) return 5;
  }
  if (!(flags & FLAG_NO_ROCK_PATCHES) && n(0.1, 0.1, 0) > 0 && n(0.01, 0.01, 2) > 0.5) return 8;
  if (n(0.05, 0.05, 4) > 0 && n(0.015, 0.015, 6) > 0.47) return 7;
  const sx = f(x * 0.03), sy = f(y * 0.03);
  if (!(flags & FLAG_NO_MATERIAL_2)) {
    if (noise(sx, sy, 8, s) > 0.72) return 2;
    if (noise(sx, sy, 16, s) > 0.72) return 2;
  }
  if (noise(sx, sy, 12, s) > 0.72) return 6;
  if (!(flags & FLAG_NO_MATERIAL_9) && n(0.01, 0.01, 14) > 0.5) return 9;
  if (noise(sx, sy, 18, s) > 0.72) return 1;
  // thin lines along a curve
  const w = f(Math.cos(x * 0.001) * -0.5 + 0.5);
  const fy = f((y / 1000) % 1);
  const t = w < 0.5 ? (fy > 0.9 ? f(fy - 1) : fy) : fy;
  return Math.abs(f(w - t)) < 0.005 ? 7 : 3;
}
