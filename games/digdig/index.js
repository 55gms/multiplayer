// digdig.io on a server of our own: /api/mp/digdig/play speaks the client's
// protocol (README.md), and every lobby keeps bots playing so it is never empty.
import { WebSocketServer } from "ws";
import { acceptConnection, clientIp, rateLimiter, MAX_MESSAGE_BYTES } from "../../src/limits.js";
import { log } from "../../src/log.js";
import { World, TICK_MS } from "./world.js";
import { Connection } from "./connection.js";
import { Bot, botName } from "./bots.js";
import { rulesFor } from "./modes.js";
import { randomSkin, FACE, SPINNER } from "./skins.js";

const MAX_PLAYERS = 20; // people per lobby
const TARGET_DIGGERS = 12; // bots fill a lobby up to this many diggers
const MIN_BOTS = 4; // and there are always at least this many
const HEARTBEAT_MS = 20_000;
const EMPTY_LOBBY_MS = 120_000; // a lobby nobody has played in this long stops

// The client's mode buttons: digdig-<mode> endpoints.
export const MODES = ["ffa", "teams", "tag", "br", "maze"];
const modeOf = (req) => {
  const m = new URL(req.url, "http://x").searchParams.get("mode");
  return MODES.includes(m) ? m : "ffa";
};

class Lobby {
  constructor(id, mode) {
    this.id = id;
    this.mode = mode;
    // Maze: map flag 16, bedrock walls the client draws from the seed (maze.js)
    this.world = new World({ radiusTiles: Number(process.env.DIGDIG_ARENA_TILES) || 200, flags: mode === "maze" ? 16 : 0 });
    log("digdig_lobby_start", { lobby: id, mode, seed: this.world.seed >>> 0 });
    this.connections = new Set();
    this.bots = new Set();
    this.world.listeners.add((e) => {
      for (const c of this.connections) c.onWorldEvent(e);
      if (e.type === "death") for (const b of this.bots) if (b.d === e.digger) this.bots.delete(b);
    });
    this.rules = rulesFor(mode, this);
    this.lobbyFor = lobbyFor;
    this.timer = setInterval(() => this.step(), TICK_MS);
    this.timer.unref?.();
    this.fillBots();
  }

  get players() {
    return this.connections.size;
  }

  // force: fill now even if the mode lets no bots in (the start of a round)
  fillBots(force = false) {
    if (!force && !this.rules.wantBots()) return;
    const humans = [...this.world.diggers.values()].filter((d) => !d.bot).length;
    const want = Math.max(MIN_BOTS, TARGET_DIGGERS - humans);
    const taken = new Set([...this.world.diggers.values()].map((d) => d.name));
    while (this.bots.size < want) {
      const d = this.world.addDigger({ name: botName(taken), bot: true });
      // bots start at different sizes, so there is something to hunt and to run from
      d.score = this.rules.botScore?.() ?? Math.floor(Math.random() ** 2 * 6000);
      // some bots wear shop skins, as players do
      d.skins = [Math.random() < 0.4 ? randomSkin(FACE).index : 0, Math.random() < 0.3 ? randomSkin(SPINNER).index : 0];
      taken.add(d.name);
      this.bots.add(new Bot(this.world, d));
    }
    // too many after people joined: let the smallest bots leave
    if (this.bots.size > want) {
      const extra = [...this.bots].sort((a, b) => a.d.score - b.d.score).slice(0, this.bots.size - want);
      for (const b of extra) {
        this.world.removeDigger(b.d);
        this.bots.delete(b);
      }
    }
  }

  // moves a connection here from another lobby of the same mode
  take(conn) {
    const from = conn.lobby;
    if (from === this) return;
    from.connections.delete(conn);
    conn.close();
    from.fillBots();
    conn.moveTo(this);
    this.connections.add(conn);
  }

  stop() {
    clearInterval(this.timer);
    lobbies.splice(lobbies.indexOf(this), 1);
    log("digdig_lobby_stop", { lobby: this.id, mode: this.mode });
  }

  step() {
    if (this.connections.size) this.lastPlayer = Date.now();
    else if (Date.now() - (this.lastPlayer || 0) > EMPTY_LOBBY_MS) return this.stop();
    for (const b of this.bots) b.think();
    this.world.step();
    this.rules.step();
    if (this.world.tick % 20 === 0) this.fillBots();
    for (const c of this.connections) {
      try {
        c.update();
      } catch (err) {
        log("digdig_update_error", { error: String(err.stack || err).slice(0, 500) });
        c.ws.terminate();
      }
    }
  }
}

const lobbies = [];
let lobbyIds = 0;
// a lobby of this mode with room, preferring one that lets people in right now
// (a Battle Royale round that has not started)
export function lobbyFor(mode) {
  const open = lobbies.filter((l) => l.mode === mode && l.players < MAX_PLAYERS);
  let lobby = open.find((l) => l.rules.canSpawn()) || (mode === "br" ? null : open[0]);
  if (!lobby) {
    lobby = new Lobby(++lobbyIds, mode);
    lobby.lastPlayer = Date.now();
    lobbies.push(lobby);
  }
  return lobby;
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

function onConnection(ws, req, release) {
  const ip = clientIp(req);
  const lobby = lobbyFor(modeOf(req));
  const conn = new Connection(ws, lobby, log);
  const limiter = rateLimiter();
  let alive = true;
  lobby.connections.add(conn);
  log("digdig_join", { ip, lobby: lobby.id, mode: lobby.mode, players: lobby.players });
  const heartbeat = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, HEARTBEAT_MS);
  ws.on("pong", () => (alive = true));
  ws.on("message", (data, isBinary) => {
    if (!limiter.allow()) return ws.terminate();
    if (!isBinary) return;
    try {
      conn.onPacket(Buffer.isBuffer(data) ? data : Buffer.concat(data));
    } catch (err) {
      log("digdig_bad_packet", { ip, error: String(err.message || err) });
      ws.terminate();
    }
  });
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    clearInterval(heartbeat);
    conn.lobby.connections.delete(conn);
    conn.close();
    conn.leaveSquad();
    release();
    conn.lobby.fillBots();
  };
  ws.on("close", end);
  ws.on("error", end);
}

export default {
  name: "digdig",
  upgrade(req, socket, head, rest) {
    if (rest !== "play") return socket.destroy();
    const ip = clientIp(req);
    const release = acceptConnection(ip);
    if (!release) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    socket.once("close", release);
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req, release));
  },
  http(req, res, rest) {
    // what the client asks api.n.m28.io for, so a page can point it here
    if (rest === "servers") {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
      // the id comes back as the game server's host name, <id>.s.m28n.net
      const id = modeOf(req);
      return res.end(JSON.stringify({ servers: { "vultr-chicago": { id, ipv4: "127.0.0.1", ipv6: "::1" } } }));
    }
    // one server by id (api.n.m28.io/server/<id>): joining a squad of another
    // mode looks its server up this way
    if (rest === "server") {
      const id = new URL(req.url, "http://x").searchParams.get("id");
      if (!MODES.includes(id)) return res.writeHead(404, { "access-control-allow-origin": "*" }).end();
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
      return res.end(JSON.stringify({ id, ipv4: "127.0.0.1", ipv6: "::1" }));
    }
    res.writeHead(404).end();
  },
};
