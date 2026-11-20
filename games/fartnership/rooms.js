// Fartnership's online rooms: the lobby, the match and the vote after it,
// speaking the JSON protocol the game's client (`Fv` in its bundle) expects.
//
// The server is authoritative, as the game's own was: clients send their
// stick and fart button, the server steps the game's world (sim.js, the
// client's own code) at its fixed 60 Hz and sends snapshots of it; clients
// interpolate between them 100 ms behind. See games/fartnership/README.md.
import { World, loadCourse, raceCourses, MODES, isParty, ANIMALS, OUTFITS, STEP, EMOTES } from "./sim.js";

const SNAP_EVERY = 3; // steps per snapshot: 20 a second
const MAX_GAME_SECONDS = 15 * 60;
const AFTER_END_SECONDS = 3; // the world keeps moving under the results screen
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const BOT_NAMES = ["Rumbly", "Gusty", "Puffy", "Tooty"];
const TEAM_SIZES = [1, 2, 4];
const RACE_COURSES = new Set(raceCourses().map((c) => c.id));
const DEFAULT_COURSE = "lagoon";
const EMOTE_COOLDOWN_MS = 1200;
// An 8-raft match of bots is ~8% of a core and ~420 KB/s of snapshots.
export const MAX_ROOMS = 60;

const rooms = new Map();

export function roomCount() {
  return rooms.size;
}

export function roomStats() {
  let players = 0;
  let playing = 0;
  for (const room of rooms.values()) {
    players += room.members.size;
    if (room.phase === "playing") playing++;
  }
  return { rooms: rooms.size, players, playing };
}

function newCode() {
  for (;;) {
    let code = "";
    for (let i = 0; i < 4; i++) code += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
    if (!rooms.has(code)) return code;
  }
}

function cleanName(value) {
  const name = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "")
    .trim()
    .slice(0, 16);
  return name || "Player";
}

// A player as the client describes itself in create/join; anything unknown
// falls back to what the client would show by default.
function cleanSpec(raw) {
  const spec = raw && typeof raw === "object" ? raw : {};
  const tint = Number(spec.tint);
  const fart = typeof spec.fart === "string" && spec.fart.length <= 80 ? spec.fart : null;
  return {
    name: cleanName(spec.name),
    animal: ANIMALS.includes(spec.animal) ? spec.animal : ANIMALS[0],
    tint: Number.isInteger(tint) && tint >= 0 && tint <= 2 ? tint : 0,
    fart,
    outfit: OUTFITS.includes(spec.outfit) ? spec.outfit : "none",
  };
}

function capacity(mode) {
  return mode === "coop" ? 4 : 8;
}

function send(conn, message) {
  conn.send(message);
}

export class Room {
  constructor(host) {
    this.code = newCode();
    this.host = host.id;
    this.phase = "lobby";
    this.config = { mode: "coop", courseId: DEFAULT_COURSE, chill: false, teamSize: 1 };
    this.raceCourse = DEFAULT_COURSE;
    this.players = []; // {id, name, animal, tint, fart, outfit, bot, conn}
    this.members = new Map(); // conn -> [pid]
    this.nextPid = 1;
    this.world = null;
    this.timer = null;
    this.votes = new Map(); // conn -> pid
    this.endedAt = null;
    rooms.set(this.code, this);
  }

  // What the client reads as `room`: no connection objects.
  view() {
    return {
      code: this.code,
      host: this.host,
      phase: this.phase,
      config: { ...this.config },
      players: this.players.map(({ id, name, animal, tint, fart, outfit, bot }) => ({
        id,
        name,
        animal,
        tint,
        fart,
        outfit,
        bot,
      })),
    };
  }

  broadcast(message, except = null) {
    for (const conn of this.members.keys()) if (conn !== except) send(conn, message);
  }

  sendRoom() {
    const room = this.view();
    for (const [conn, pids] of this.members) send(conn, { t: "room", room, you: pids });
  }

  humans() {
    return this.players.filter((p) => !p.bot).length;
  }

  bots() {
    return this.players.filter((p) => p.bot);
  }

  addMember(conn, specs) {
    if (this.phase !== "lobby") return "That game has already started. Try again when it's back in the room.";
    const list = (Array.isArray(specs) ? specs : [specs]).slice(0, 4);
    if (!list.length) return "Nobody to add.";
    const cap = capacity(this.config.mode);
    // Bots make room for people.
    while (this.players.length + list.length > cap && this.bots().length) {
      this.players.splice(this.players.lastIndexOf(this.bots().at(-1)), 1);
    }
    if (this.players.length + list.length > cap) return "That room is full.";
    const pids = [];
    for (const raw of list) {
      const player = { id: this.nextPid++, ...cleanSpec(raw), bot: false, conn };
      // Humans go before the bots, so bots fill the last rafts.
      const firstBot = this.players.findIndex((p) => p.bot);
      if (firstBot < 0) this.players.push(player);
      else this.players.splice(firstBot, 0, player);
      pids.push(player.id);
    }
    this.members.set(conn, pids);
    conn.room = this;
    // Everyone already here hears the newcomer's fart sound, and the other way round.
    for (const other of this.members.keys()) {
      if (other !== conn && other.sound) send(conn, { t: "sound", ...other.sound });
    }
    this.sendRoom();
    return null;
  }

  removeMember(conn) {
    const pids = this.members.get(conn);
    if (!pids) return;
    this.members.delete(conn);
    this.votes.delete(conn);
    conn.room = null;
    if (this.phase === "lobby") {
      this.players = this.players.filter((p) => p.conn !== conn);
    } else {
      // Mid-game the raft keeps its seat: the game's bot steers for them.
      for (const p of this.players) if (p.conn === conn) p.conn = null;
      if (this.world) {
        for (const raft of this.world.rafts) {
          for (const ch of raft.chars) if (pids.includes(ch.pid)) ch.spec.bot = true;
        }
      }
    }
    if (!this.members.size) return this.close();
    if (this.host === conn.id) this.host = this.members.keys().next().value.id;
    this.sendRoom();
    if (this.votes.size || this.phase === "results") this.sendVotes();
  }

  close() {
    this.stopLoop();
    rooms.delete(this.code);
  }

  isHost(conn) {
    return conn.id === this.host;
  }

  configure(conn, patch) {
    if (!this.isHost(conn) || this.phase !== "lobby" || !patch || typeof patch !== "object") return;
    const next = { ...this.config };
    if (typeof patch.mode === "string" && Object.hasOwn(MODES, patch.mode)) next.mode = patch.mode;
    if (typeof patch.courseId === "string" && RACE_COURSES.has(patch.courseId)) this.raceCourse = patch.courseId;
    if (typeof patch.chill === "boolean") next.chill = patch.chill;
    if (TEAM_SIZES.includes(Number(patch.teamSize))) next.teamSize = Number(patch.teamSize);
    next.courseId = isParty(next.mode) ? MODES[next.mode].arena : this.raceCourse;
    if (this.players.length > capacity(next.mode)) {
      // Too many for co-op: drop bots first, refuse if people would not fit.
      const over = this.players.length - capacity(next.mode);
      const bots = this.bots();
      if (this.humans() > capacity(next.mode)) {
        return send(conn, { t: "error", msg: `Co-op is ${capacity(next.mode)} players at most.` });
      }
      for (const bot of bots.slice(-over)) this.players.splice(this.players.indexOf(bot), 1);
    }
    this.config = next;
    this.sendRoom();
  }

  setBots(conn, count) {
    if (!this.isHost(conn) || this.phase !== "lobby") return;
    const want = Math.max(0, Math.min(Number(count) || 0, capacity(this.config.mode) - this.humans()));
    let bots = this.bots();
    while (bots.length > want) {
      this.players.splice(this.players.indexOf(bots.at(-1)), 1);
      bots = this.bots();
    }
    while (bots.length < want) {
      this.players.push(this.makeBot(bots.length));
      bots = this.bots();
    }
    this.sendRoom();
  }

  makeBot(index) {
    const id = this.nextPid++;
    return {
      id,
      name: `Bot ${BOT_NAMES[index % BOT_NAMES.length]}`,
      animal: ANIMALS[(id + 1) % ANIMALS.length],
      tint: 2,
      fart: null,
      outfit: OUTFITS[id % OUTFITS.length],
      bot: true,
      conn: null,
    };
  }

  // The same teams the game makes for a local match (startLocalFromLobby).
  start(conn) {
    if (!this.isHost(conn) || this.phase !== "lobby") return;
    const { mode, courseId, chill, teamSize } = this.config;
    const party = isParty(mode);
    let teams = [];
    if (mode === "coop") teams = [this.players];
    else for (let i = 0; i < this.players.length; i += teamSize) teams.push(this.players.slice(i, i + teamSize));
    if (party) {
      const min = Math.max(2, MODES[mode].minRafts);
      let added = 0;
      while (teams.length < min) {
        const bot = this.makeBot(this.bots().length + added++);
        bot.auto = true; // gone again when the room is back in the lobby
        this.players.push(bot);
        teams.push([bot]);
      }
    } else if (mode === "race" && teams.length < 2) {
      return send(conn, { t: "error", msg: "A race needs two rafts. Add a bot or invite a friend." });
    }
    const setup = {
      courseId,
      mode,
      chill,
      teams: teams.map((team) =>
        team.map(({ id, name, animal, tint, bot, fart, outfit }) => ({ id, name, animal, tint, bot, fart, outfit })),
      ),
    };
    try {
      loadCourse(courseId);
      this.world = new World(setup);
    } catch {
      return send(conn, { t: "error", msg: "That course could not be loaded." });
    }
    this.phase = "playing";
    this.votes.clear();
    this.endedAt = null;
    this.sendRoom();
    this.broadcast({ t: "start", setup });
    this.startLoop();
  }

  startLoop() {
    this.stopLoop();
    let last = performance.now();
    let acc = 0;
    let steps = 0;
    let events = [];
    this.timer = setInterval(() => {
      const world = this.world;
      if (!world) return this.stopLoop();
      const now = performance.now();
      acc += Math.min(now - last, 250) / 1000;
      last = now;
      while (acc >= STEP) {
        acc -= STEP;
        try {
          world.step(STEP);
        } catch {
          this.finish(true);
          return;
        }
        events.push(...world.takeEvents());
        if (world.t > MAX_GAME_SECONDS && world.phase !== "finished") world.endGame();
        if (++steps % SNAP_EVERY === 0) {
          this.broadcast({ t: "snap", s: world.snapshot(), ev: events });
          events = [];
        }
        if (world.phase === "finished" && this.phase === "playing") this.finish(false);
        if (this.endedAt !== null && world.t - this.endedAt >= AFTER_END_SECONDS) return this.stopLoop();
      }
    }, 1000 / 60);
    this.timer.unref?.();
  }

  stopLoop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  finish(broken) {
    if (broken) {
      this.stopLoop();
      this.world = null;
      this.toLobby();
      this.broadcast({ t: "error", msg: "The game hit a snag. Back to the room!" });
      return;
    }
    this.phase = "results";
    this.endedAt = this.world.t;
    this.broadcast({ t: "results", results: this.world.results() });
    this.sendVotes();
  }

  input(conn, list) {
    if (this.phase !== "playing" || !this.world || !Array.isArray(list)) return;
    const pids = this.members.get(conn) || [];
    list.slice(0, pids.length).forEach((entry, i) => {
      if (!Array.isArray(entry)) return;
      const move = Number(entry[0]);
      this.world.setInput(pids[i], {
        move: Number.isFinite(move) ? Math.round(Math.max(-1, Math.min(1, move)) * 100) / 100 : 0,
        fart: !!entry[1],
      });
    });
  }

  respawn(conn) {
    if (this.phase !== "playing" || !this.world) return;
    const pids = this.members.get(conn) || [];
    const index = this.world.rafts.findIndex((raft) => raft.chars.some((ch) => pids.includes(ch.pid)));
    if (index >= 0) this.world.forceRespawn(index);
  }

  emote(conn, pid, k) {
    if (this.phase === "lobby") return;
    const pids = this.members.get(conn) || [];
    if (!pids.includes(pid) || !Number.isInteger(k) || k < 0 || k >= EMOTES.length) return;
    const now = Date.now();
    if (now - (conn.lastEmote || 0) < EMOTE_COOLDOWN_MS) return;
    conn.lastEmote = now;
    // The text names someone at random ("It was {name}!"); pick it here so
    // everyone sees the same accusation.
    const others = this.players.filter((p) => p.id !== pid);
    const blamed = others.length ? others[Math.floor(Math.random() * others.length)].name : "them";
    this.broadcast({ t: "emote", pid, k, text: EMOTES[k].replace("{name}", blamed) });
  }

  vote(conn, target) {
    if (this.phase !== "results" || !this.players.some((p) => p.id === target)) return;
    this.votes.set(conn, target);
    this.sendVotes();
  }

  sendVotes() {
    const tally = {};
    for (const pid of this.votes.values()) tally[pid] = (tally[pid] || 0) + 1;
    this.broadcast({ t: "votes", tally });
  }

  backToLobby(conn) {
    if (!this.isHost(conn) || this.phase === "lobby") return;
    this.toLobby();
  }

  toLobby() {
    this.stopLoop();
    this.world = null;
    this.phase = "lobby";
    this.votes.clear();
    // Seats of players who left mid-game, and the bots a party mode added.
    this.players = this.players.filter((p) => (p.bot ? !p.auto : p.conn));
    const cap = capacity(this.config.mode);
    while (this.players.length > cap && this.bots().length)
      this.players.splice(this.players.indexOf(this.bots().at(-1)), 1);
    this.sendRoom();
  }

  sound(conn) {
    if (conn.sound) this.broadcast({ t: "sound", ...conn.sound }, conn);
  }
}

export function findRoom(code) {
  return (
    rooms.get(
      String(code ?? "")
        .trim()
        .toUpperCase(),
    ) || null
  );
}
