// digdig.io on a server of our own: /api/mp/digdig/play speaks the client's
// protocol (README.md), and every lobby keeps bots playing so it is never empty.
import { WebSocketServer } from "ws";
import { acceptConnection, clientIp, rateLimiter, MAX_MESSAGE_BYTES } from "../../src/limits.js";
import { log } from "../../src/log.js";
import { World, TICK_MS } from "./world.js";
import { Connection } from "./connection.js";
import { Bot, botName } from "./bots.js";

const MAX_PLAYERS = 20; // people per lobby
const TARGET_DIGGERS = 12; // bots fill a lobby up to this many diggers
const MIN_BOTS = 4; // and there are always at least this many
const HEARTBEAT_MS = 20_000;

class Lobby {
  constructor(id) {
    this.id = id;
    this.world = new World({ radiusTiles: Number(process.env.DIGDIG_ARENA_TILES) || 200 });
    this.connections = new Set();
    this.bots = new Set();
    this.world.listeners.add((e) => {
      if (e.type !== "death") return;
      for (const c of this.connections) c.onDeath(e.digger);
      for (const b of this.bots) if (b.d === e.digger) this.bots.delete(b);
    });
    this.timer = setInterval(() => this.step(), TICK_MS);
    this.timer.unref?.();
    this.fillBots();
  }

  get players() {
    return this.connections.size;
  }

  fillBots() {
    const humans = [...this.world.diggers.values()].filter((d) => !d.bot).length;
    const want = Math.max(MIN_BOTS, TARGET_DIGGERS - humans);
    const taken = new Set([...this.world.diggers.values()].map((d) => d.name));
    while (this.bots.size < want) {
      const d = this.world.addDigger({ name: botName(taken), bot: true });
      // bots start at different sizes, so there is something to hunt and to run from
      d.score = Math.floor(Math.random() ** 2 * 6000);
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

  step() {
    for (const b of this.bots) b.think();
    this.world.step();
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
function lobbyFor() {
  let lobby = lobbies.find((l) => l.players < MAX_PLAYERS);
  if (!lobby) {
    lobby = new Lobby(lobbies.length + 1);
    lobbies.push(lobby);
  }
  return lobby;
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

function onConnection(ws, req, release) {
  const ip = clientIp(req);
  const lobby = lobbyFor();
  const conn = new Connection(ws, lobby, log);
  const limiter = rateLimiter();
  let alive = true;
  lobby.connections.add(conn);
  log("digdig_join", { ip, lobby: lobby.id, players: lobby.players });
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
    lobby.connections.delete(conn);
    conn.close();
    release();
    lobby.fillBots();
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
      return res.end(JSON.stringify({ servers: { "vultr-chicago": { id: "digdig", ipv4: "127.0.0.1", ipv6: "::1" } } }));
    }
    res.writeHead(404).end();
  },
};
