// One digdig.io client: its packets, its reliable stream, and what it is shown.
import { ClientCipher, ServerCipher } from "./cipher.js";
import { unmaskClient, readVarint, readClientMessages } from "./stream.js";
import { Writer, writeEntity, entityId, snapshot } from "./snapshot.js";
import { TILE, CHUNK, INPUT_ATTACK, INPUT_DEFEND } from "./world.js";

const WORLD_ID = 1;
const VIEW = entityId(1);
const ARENA = entityId(2);
// Half the area a client can see, in world units (the client shows about
// 1500 x 1050 units on a 1000 x 700 window; bigger windows zoom out).
const VIEW_W = 1300;
const VIEW_H = 950;
const DEATH_SHOW_TICKS = 40;

const diggerEntity = (d) => entityId(100 + (d.id % 20000), 1 + (Math.floor(d.id / 20000) % 65000));
const chunkEntity = (cx, cy) => entityId(30000 + cy * 135 + cx);

const f32 = (v) => (w) => w.f32(v);
const f64 = (v) => (w) => w.f64(v);
const svar4 = (v) => (w) => w.zigzag(Math.round(v * 4));
const varint = (v) => (w) => w.varint(v);
const u8 = (v) => (w) => w.u8(v);
const str = (v) => (w) => w.string(v);
const ref = (id) => (w) => w.id(id);
// a sparse array field: [varint (index delta) ^ 1][value] per entry, then 1
const sparse = (list, write) => (w) => {
  let cum = 0;
  list.forEach((v, i) => {
    w.varint((i + 1 - cum) ^ 1);
    cum = i + 1;
    write(w, v);
  });
  w.varint(1);
};
const LEADERBOARD = 10;
const u16angle = (a) => (w) => w.u16(Math.round((((a % (Math.PI * 2)) + Math.PI * 2) / (Math.PI * 2)) * 65536) & 65535);

function encode(fn) {
  const w = new Writer();
  fn(w);
  return w.done();
}

export class Connection {
  constructor(ws, lobby, log) {
    this.ws = ws;
    this.lobby = lobby;
    this.world = lobby.world;
    this.log = log;
    this.rx = new ClientCipher();
    this.tx = new ServerCipher();
    this.started = false;
    this.acked = 0; // highest reliable seq received from the client
    this.tick = 0;
    this.digger = null;
    this.deadAt = 0;
    this.nickname = "";
    this.camera = { x: this.world.center, y: this.world.center };
    // what the client has: entity id -> Map(field -> Buffer)
    this.known = new Map();
    // chunk key -> { dug, reveal } as the client has them
    this.chunkState = new Map();
  }

  send(type, body) {
    if (this.ws.readyState !== 1) return;
    this.ws.send(this.tx.seal(type, body));
  }

  onPacket(buf) {
    const p = this.rx.open(buf);
    if (!p) return;
    if (p.type === 48) {
      this.started = true;
      return;
    }
    if (p.type !== 1) return; // 2 acknowledges our snapshots
    const body = unmaskClient(p.body);
    const [, pos] = readVarint(body, 0);
    for (const m of readClientMessages(body, pos)) {
      if (m.seq) {
        if (m.seq <= this.acked) continue;
        this.acked = m.seq;
      }
      this.onMessage(m);
    }
  }

  onMessage(m) {
    if (process.env.DIGDIG_DEBUG && m.name !== "input") this.log("digdig_msg", { msg: JSON.stringify(m).slice(0, 200) });
    if (m.name === "nickname") {
      this.nickname = (m.nickname || "").slice(0, 20).trim();
      // the client sends the name again as it settles; take it while the digger is new
      if (this.digger?.alive && this.world.tick - this.digger.spawnTick < 40) this.digger.name = this.nickname || "Unnamed";
    } else if (m.name === "play") {
      if (!this.digger || !this.digger.alive) this.spawn();
    } else if (m.name === "input" && this.digger?.alive) {
      const d = this.digger;
      const throttle = Math.max(0, Math.min(1, m.distance / Math.max(60, d.radius * 3)));
      d.input = {
        angle: m.angle,
        throttle,
        buttons: (m.flags & 1 ? INPUT_ATTACK : 0) | (m.flags & 2 ? INPUT_DEFEND : 0),
      };
    }
  }

  spawn() {
    this.digger = this.world.addDigger({ name: this.nickname || "Unnamed" });
    if (process.env.DIGDIG_DEBUG) this.log("digdig_spawn", { id: this.digger.id });
    this.deadAt = 0;
  }

  onDeath(d) {
    if (d === this.digger) this.deadAt = this.world.tick;
  }

  close() {
    if (this.digger?.alive) this.world.removeDigger(this.digger);
  }

  // ---- what this client is shown, every tick ----

  update() {
    if (!this.started || this.ws.readyState !== 1) return;
    const world = this.world;
    const me = this.digger;
    if (me && (me.alive || world.tick - this.deadAt < DEATH_SHOW_TICKS)) {
      this.camera = { x: me.x, y: me.y };
    } else if (me && !me.alive) {
      this.digger = null;
    }
    const cam = this.camera;
    const entities = new Map(); // id -> { components, fields: [[index, fn]] }

    const ranked = [...world.diggers.values()].sort((a, b) => b.shownScore - a.shownScore);
    const top = ranked.slice(0, LEADERBOARD);
    entities.set(ARENA, {
      components: [4, 12],
      fields: [
        [9, u8(top.length)],
        [11, u8(world.flags)],
        [12, f32(world.radius * 2)],
        [13, f32(world.center)],
        [15, f32(world.center)],
        [16, varint(ranked.length)],
        [17, varint(2)],
        [18, sparse(top, (w, d) => (d === me ? w.u8(255).u8(214).u8(64) : w.u8(150).u8(150).u8(150)))],
        [20, sparse(top, (w, d) => w.string(d.name))],
        [22, sparse(top, (w, d) => w.id(diggerEntity(d)))],
        [25, f32(1)],
        [27, varint(world.seed >>> 0)],
        [28, sparse(top, (w, d) => w.varint(Math.max(0, d.shownScore)))],
      ],
    });

    const visible = [];
    for (const d of world.diggers.values()) {
      if (Math.abs(d.x - cam.x) < VIEW_W + d.radius && Math.abs(d.y - cam.y) < VIEW_H + d.radius) visible.push(d);
    }
    if (me && !me.alive && !visible.includes(me)) visible.push(me);
    for (const d of visible) {
      entities.set(diggerEntity(d), {
        components: [0, 1, 2, 3, 7, 10],
        fields: [
          [1, svar4(d.x)],
          [2, svar4(d.y)],
          [3, u16angle(d.angle)],
          [4, f32(1)],
          [5, f32(d.alive ? Math.max(0.001, d.health) : 0)],
          [6, f32(1)],
          [8, f32(d.radius)],
          [34, str(d.name)],
          [69, f32(d.shownScore)],
        ],
      });
    }

    entities.set(VIEW, {
      components: [8],
      fields: [
        [37, svar4(cam.x)],
        // the death screen: diggers destroyed, gold, time alive (52 - 49, ms), max points
        ...(me
          ? [
              [38, varint(me.kills)],
              [41, f32(me.gold)],
              [47, svar4(cam.y)],
              [49, f64(me.spawnedAt)],
              [52, f64(me.diedAt || me.spawnedAt)],
              [53, ref(diggerEntity(me))],
              [55, f32(Math.max(me.maxScore, me.shownScore))],
            ]
          : [
              [47, svar4(cam.y)],
              [53, ref(0)],
            ]),
      ],
    });

    // terrain around the camera
    const reveal = this.revealAround(cam, me);
    const cx0 = Math.max(0, Math.floor((cam.x - VIEW_W - 200) / (TILE * CHUNK)));
    const cx1 = Math.floor((cam.x + VIEW_W + 200) / (TILE * CHUNK));
    const cy0 = Math.max(0, Math.floor((cam.y - VIEW_H - 200) / (TILE * CHUNK)));
    const cy1 = Math.floor((cam.y + VIEW_H + 200) / (TILE * CHUNK));
    const chunkFields = new Map();
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const id = chunkEntity(cx, cy);
        const chunk = world.peekChunk(cx, cy);
        const dug = chunk ? chunk.dug : new Uint8Array(512);
        const rev = reveal.get(cx * 65536 + cy) || new Uint8Array(512);
        entities.set(id, { components: [6], fields: [[32, varint(cx)], [33, varint(cy)]] });
        chunkFields.set(id, { key: cx * 65536 + cy, dug, rev });
      }
    }

    this.sendSnapshot(entities, chunkFields);
  }

  // Tiles this client sees: a disc around its digger, and tunnels it can see
  // down (dug tiles reached from it, and the walls next to them).
  revealAround(cam, me) {
    const world = this.world;
    const out = new Map();
    const set = (tx, ty) => {
      if (tx < 0 || ty < 0) return;
      const key = (tx >> 6) * 65536 + (ty >> 6);
      let arr = out.get(key);
      if (!arr) out.set(key, (arr = new Uint8Array(512)));
      const i = (ty & 63) * 64 + (tx & 63);
      arr[i >> 3] |= 1 << (i & 7);
    };
    if (!me) return out;
    const ctx = Math.floor(me.x / TILE), cty = Math.floor(me.y / TILE);
    const disc = Math.ceil(me.radius / TILE) + me.vision;
    for (let dy = -disc; dy <= disc; dy++) {
      for (let dx = -disc; dx <= disc; dx++) if (dx * dx + dy * dy <= disc * disc) set(ctx + dx, cty + dy);
    }
    const maxX = Math.ceil(VIEW_W / TILE), maxY = Math.ceil(VIEW_H / TILE);
    const seen = new Set();
    const queue = [[ctx, cty]];
    seen.add(ctx * 65536 + cty);
    while (queue.length && seen.size < 12000) {
      const [tx, ty] = queue.pop();
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nx = tx + ox, ny = ty + oy;
        if (Math.abs(nx - ctx) > maxX || Math.abs(ny - cty) > maxY) continue;
        const k = nx * 65536 + ny;
        if (seen.has(k)) continue;
        seen.add(k);
        set(nx, ny);
        if (world.isDug(nx, ny)) queue.push([nx, ny]);
      }
    }
    return out;
  }

  sendSnapshot(entities, chunkFields) {
    const w = new Writer();
    w.varint(WORLD_ID).varint(++this.tick).varint(this.acked).varint(0);
    const deleted = [...this.known.keys()].filter((id) => !entities.has(id));
    w.varint(deleted.length).u16(0);
    for (const id of deleted) {
      w.id(id);
      this.known.delete(id);
      this.chunkState.delete(id);
    }
    w.u16(0);
    for (const [id, e] of entities) {
      let had = this.known.get(id);
      const isNew = !had;
      if (isNew) this.known.set(id, (had = new Map()));
      const fields = [];
      for (const [index, fn] of e.fields) {
        const bytes = encode(fn);
        const prev = had.get(index);
        if (!isNew && prev && prev.equals(bytes)) continue;
        had.set(index, bytes);
        fields.push([index, (wr) => wr.bytes(bytes)]);
      }
      const chunk = chunkFields.get(id);
      if (chunk) {
        let state = this.chunkState.get(id);
        if (!state) this.chunkState.set(id, (state = { dug: new Uint8Array(512), rev: new Uint8Array(512) }));
        const changes = [];
        for (let i = 0; i < 512; i++) if (state.dug[i] !== chunk.dug[i]) changes.push([i, chunk.dug[i]]);
        for (let i = 0; i < 512; i++) if (state.rev[i] !== chunk.rev[i]) changes.push([3060 + i, chunk.rev[i]]);
        if (changes.length) {
          state.dug.set(chunk.dug);
          state.rev.set(chunk.rev);
          fields.push([
            31,
            (wr) => {
              let cum = 0;
              for (const [i, v] of changes) {
                wr.varint((i + 1 - cum) ^ 1).u8(v);
                cum = i + 1;
              }
              wr.varint(1);
            },
          ]);
          fields.sort((a, b) => a[0] - b[0]);
        }
      }
      if (!isNew && !fields.length) continue;
      writeEntity(w, id, isNew ? e.components : null, fields);
    }
    w.u32(0);
    w.varint(0);
    w.bytes([0, 0, 0]);
    this.send(1, w.done());
  }
}

export { VIEW, ARENA, diggerEntity };
