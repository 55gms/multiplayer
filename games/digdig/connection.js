// One digdig.io client: its packets, its reliable stream, and what it is shown.
import { ClientCipher, ServerCipher } from "./cipher.js";
import { unmaskClient, readVarint, readClientMessages, varint as varintBytes, STREAM_MASK } from "./stream.js";
import { Writer, writeEntity, entityId, snapshot } from "./snapshot.js";
import { TILE, CHUNK, INPUT_ATTACK, INPUT_DEFEND } from "./world.js";
import { STATE_RUNNING, STATE_WAITING } from "./modes.js";
import { verifyToken, buySkin, grantGold } from "./accounts.js";
import { SKINS, skinAt, FACE, SPINNER } from "./skins.js";
import { Squad, SQUAD_SIZE, SQUAD_MODES, leaveSquad, findSquad, publicSquad } from "./squads.js";

const WORLD_ID = 1;
const VIEW = entityId(1);
const ARENA = entityId(2);
const ROLE = entityId(3);
const SQUAD = entityId(4);
// Half the area a client can see, in world units (the client shows about
// 1500 x 1050 units on a 1000 x 700 window; bigger windows zoom out).
const VIEW_W = 1300;
const VIEW_H = 950;
const DEATH_SHOW_TICKS = 40;
// Server messages (type 5) the client runs: 6 signs the client out (it forgets
// its saved login); 18 and 27 show why a squad request failed; 26 says
// squads work here.
const MSG_SIGN_OUT = 6;
const MSG_SQUAD = 18;
const MSG_SQUAD_JOINED = 27;
const MSG_SQUADS_READY = 26;
const MSG_HURT = 25; // [entity][u8 strength]: the digger flashes red; the player's own also shakes the screen
// gold grants need ids no other run of this server uses
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const GREY = [153, 153, 153];

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
// field 44, the skins an account owns: [varint count], then (if any) a sparse
// list of strings
const stringList = (list) => (w) => {
  w.varint(list.length);
  if (list.length) sparse(list, (wr, v) => wr.string(v))(w);
};
const rgb = (c) => (w) => w.u8(c[0]).u8(c[1]).u8(c[2]);
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
    this.outSeq = 0; // the last reliable message sent
    // the 55GMS account (accounts.js), null for a guest
    this.account = null;
    this.skins = [0, 0]; // what the client has equipped, as far as the account owns it
    this.squad = null; // squads.js
    this.tick = 0;
    this.digger = null;
    this.deadAt = 0;
    this.wantsPlay = false; // pressed Play while the mode let nobody in
    this.nickname = "";
    this.camera = { x: this.world.center, y: this.world.center };
    // what the client has: entity id -> Map(field -> Buffer)
    this.known = new Map();
    // chunk key -> { dug, reveal } as the client has them
    this.chunkState = new Map();
  }

  // Reliable messages for the client: a type-5 packet, [varint world id] then,
  // masked like the client's stream, [varint seq][varint id][payload] for each.
  // The client runs those with a seq above the last it ran (0: always).
  sendMessages(list) {
    if (!list.length) return;
    const parts = [];
    for (const [id, payload] of list) parts.push(Buffer.from(varintBytes(++this.outSeq)), Buffer.from(varintBytes(id)), payload);
    const body = Buffer.concat(parts);
    for (let i = 0; i < body.length; i++) body[i] ^= STREAM_MASK[i & 255];
    this.send(5, Buffer.concat([Buffer.from(varintBytes(WORLD_ID)), body]));
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
      // message 26: squads are ready (the Squad panel waits for it)
      this.sendMessages([[MSG_SQUADS_READY, Buffer.alloc(0)]]);
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
      if (this.digger?.alive) return;
      if (this.lobby.rules.canSpawn()) return this.spawn();
      // out of a running round: on to one that has not started
      const next = this.lobby.lobbyFor(this.lobby.mode);
      if (next !== this.lobby && next.rules.canSpawn()) {
        next.take(this);
        this.spawn();
      } else this.wantsPlay = true;
    } else if (m.name === "login") {
      this.signIn(m.parts[2]);
    } else if (m.name === "buy") {
      this.buy(m.item);
    } else if (m.name === "equip") {
      this.wanted = [m.face, m.spinner];
      this.applySkins();
    } else if (m.name === "squad" || m.name === "squadNew" || m.name === "squadJoin") {
      this.onSquad(m);
    } else if (m.name === "squadPublic") {
      if (this.squad) this.squad.public = m.on;
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

  // The client's saved login is a 55GMS game token (the page puts it there).
  async signIn(token) {
    const result = await verifyToken(token);
    if (this.ws.readyState !== 1 || !result) return;
    if (result.invalid) {
      this.account = null;
      this.sendMessages([[MSG_SIGN_OUT, Buffer.alloc(0)]]);
    } else {
      this.account = result.account;
      this.log("digdig_signed_in", { uuid: this.account.uuid });
    }
    this.applySkins();
  }

  async buy(item) {
    const skin = SKINS.get(item);
    if (!this.account || !skin?.price || this.account.items.includes(item) || this.buying) return;
    this.buying = true;
    try {
      const result = await buySkin(this.account.uuid, item);
      if (result.error) this.log("digdig_buy_refused", { uuid: this.account?.uuid, item, error: result.error });
      else if (this.account?.uuid === result.uuid) this.account = result;
    } finally {
      this.buying = false;
    }
    this.applySkins();
  }

  // Skins are worn only when the account owns them.
  applySkins() {
    const owned = (slot, index) => {
      const skin = skinAt(slot, index);
      return skin && this.account?.items.includes(skin.id) ? index : 0;
    };
    const [face, spinner] = this.wanted || [0, 0];
    this.skins = [owned(FACE, face), owned(SPINNER, spinner)];
    if (this.digger?.alive) this.digger.skins = this.skins;
  }

  // Squad requests (squads.js). The client watches the squad entity: a
  // request has worked once its code (field 57) changes, a join once it is
  // the code typed, and the panel then shows the members. Messages 18 and 27
  // (with the request number) put up a text instead, for what went wrong.
  onSquad(m) {
    const mode = this.lobby.mode;
    const refuse = (id, text) => this.sendMessages([[id, Buffer.concat([Buffer.from(varintBytes(m.request)), Buffer.from(`${text}\0`)])]]);
    if (!SQUAD_MODES.has(mode)) return refuse(m.name === "squadJoin" ? MSG_SQUAD_JOINED : MSG_SQUAD, "Squads not allowed in this game mode");
    if (m.name === "squadJoin") {
      const squad = findSquad(m.code, mode);
      if (!squad) return refuse(MSG_SQUAD_JOINED, "Squad doesn't exist");
      if (squad.full && squad !== this.squad) return refuse(MSG_SQUAD_JOINED, "Squad is full");
      return this.joinSquad(squad);
    }
    // New, or the first request: a squad of the player's own. Find Public,
    // from a squad: another public squad with room, else a new public one.
    if (m.name === "squadNew" || !this.squad) this.joinSquad(new Squad(mode));
    else this.joinSquad(publicSquad(mode, this.squad) || new Squad(mode, true));
  }

  // into a squad, and into its members' lobby
  joinSquad(squad) {
    squad.add(this);
    this.log("digdig_squad", { code: squad.code, mode: squad.mode, members: squad.members.length });
    const mate = squad.members.find((c) => c !== this);
    if (mate && mate.lobby !== this.lobby && mate.lobby.mode === this.lobby.mode) mate.lobby.take(this);
  }

  leaveSquad() {
    leaveSquad(this);
  }

  // A life's gold goes to the account when it ends.
  payOut(d) {
    if (!d || d.paid || !this.account) return;
    d.paid = true;
    const account = this.account;
    const amount = d.gold + (d.bonusGold || 0);
    if (!(amount > 0)) return;
    grantGold(account.uuid, amount, `digdig:${RUN}:${d.id}`).then((gold) => {
      if (gold !== null && this.account?.uuid === account.uuid) this.account.gold = gold;
    });
  }

  spawn() {
    this.wantsPlay = false;
    this.digger = this.world.addDigger({ name: this.nickname || "Unnamed", squad: this.squad });
    this.digger.skins = this.skins;
    if (process.env.DIGDIG_DEBUG) this.log("digdig_spawn", { id: this.digger.id });
    this.deadAt = 0;
  }

  onDeath(d) {
    if (d !== this.digger) return;
    this.deadAt = this.world.tick;
    this.payOut(d);
  }

  // into another lobby's world; what the client has is diffed against the new one
  moveTo(lobby) {
    this.lobby = lobby;
    this.world = lobby.world;
    this.digger = null;
    this.deadAt = 0;
    this.camera = { x: this.world.center, y: this.world.center };
  }

  close() {
    if (this.digger?.alive) {
      this.payOut(this.digger);
      this.world.removeDigger(this.digger);
    }
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
    const rules = this.lobby.rules;
    const arena = rules.arena();
    // someone out of a running round waits for the next one
    const state = arena.state === STATE_RUNNING && !me?.alive && !rules.canSpawn() ? STATE_WAITING : arena.state;
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
        [17, varint(state)],
        [18, sparse(top, (w, d) => rgb(d === me && !d.team ? [255, 214, 64] : rules.colorOf?.(d) || [150, 150, 150])(w))],
        [20, sparse(top, (w, d) => w.string(d.name))],
        [21, f32(arena.countdownMs)],
        [24, varint(arena.needed || 0)],
        [22, sparse(top, (w, d) => w.id(diggerEntity(d)))],
        [25, f32(1)],
        [27, varint(world.seed >>> 0)],
        [28, sparse(top, (w, d) => w.varint(Math.max(0, d.shownScore)))],
        // Tag: ms into the round
        ...(rules.roundMs ? [[19, f32(rules.roundMs())]] : []),
      ],
    });

    const visible = [];
    for (const d of world.diggers.values()) {
      if (Math.abs(d.x - cam.x) < VIEW_W + d.radius && Math.abs(d.y - cam.y) < VIEW_H + d.radius) visible.push(d);
    }
    if (me && !me.alive && !visible.includes(me)) visible.push(me);
    // squad mates wherever they are: the client's squad list shows their health
    for (const c of this.squad?.members || []) {
      const d = c.digger;
      if (d?.alive && c.lobby === this.lobby && !visible.includes(d)) visible.push(d);
    }
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
          [66, rgb(rules.colorOf?.(d) || GREY)],
          [68, sparse(d.skins || [0, 0], (w, v) => w.u8(v))],
          [69, f32(d.shownScore)],
        ],
      });
    }

    // Tag: an entity with component 11 while the player plays, field 71 its
    // role (0 a seeker, else a hider); the client shows "You are a
    // seeker/hider" for 10 s whenever it changes
    // The squad: component 9, four slots each of status (56: 0 empty, 1 in the
    // menu, 2 playing), face (59), name (60) and digger (61); 57 its code,
    // 63 whether it is public
    if (this.squad) {
      const slots = Array.from({ length: SQUAD_SIZE }, (_, i) => this.squad.members[i] || null);
      const alive = (c) => c?.digger?.alive && c.lobby === this.lobby;
      entities.set(SQUAD, {
        components: [9],
        fields: [
          [56, sparse(slots, (w, c) => w.u8(!c ? 0 : alive(c) ? 2 : 1))],
          [57, str(this.squad.code)],
          [59, sparse(slots, (w, c) => w.u8(c ? c.skins[0] : 0))],
          [60, sparse(slots, (w, c) => w.string(c ? c.nickname || "Unnamed" : ""))],
          [61, sparse(slots, (w, c) => w.id(alive(c) ? diggerEntity(c.digger) : 0))],
          [63, u8(this.squad.public ? 1 : 0)],
        ],
      });
    }
    if (rules.roundMs && me?.alive) entities.set(ROLE, { components: [11], fields: [[71, u8(me.seeker ? 0 : 1)]] });
    entities.set(VIEW, {
      components: [8],
      fields: [
        // bit 2: the account is loaded (the shop shows field 51's gold);
        // bit 8: "YOU HAVE WON"
        [35, u8(2 | (rules.won?.(me) ? 8 : 0))],
        [44, stringList(this.account?.items || [])],
        [51, f64(this.account?.gold || 0)],
        [37, svar4(cam.x)],
        // the death screen: diggers destroyed, gold, time alive (52 - 49, ms), max points
        ...(me
          ? [
              [38, varint(me.kills)],
              [41, f32(me.gold + (me.bonusGold || 0))],
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
    // after the snapshot, so the client already has the entity
    const hurt = visible.filter((d) => d.hurtPulse && this.known.has(diggerEntity(d)));
    if (hurt.length) this.sendMessages(hurt.map((d) => [MSG_HURT, new Writer().id(diggerEntity(d)).u8(d.hurtPulse).done()]));
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
    // squad mates share what they see near them
    for (const c of this.squad?.members || []) {
      const d = c.digger;
      if (c === this || !d?.alive || c.lobby !== this.lobby) continue;
      const mx = Math.floor(d.x / TILE), my = Math.floor(d.y / TILE);
      const r = Math.ceil(d.radius / TILE) + d.vision;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) set(mx + dx, my + dy);
    }
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
      // the client reads field indexes as deltas from the one before
      for (const [index, fn] of [...e.fields].sort((a, b) => a[0] - b[0])) {
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
