// Blue Wizard's games: BasketBros, SoccerBros, BaseballBros, WrestleBros,
// FootballBros, HockeyBros and FightBros. Each game's page in 55GMS sends the game's servers
// (wss://<region>.<site>/<n> and https://<region>.<site>/ping) here:
//   /api/mp/<game>/play   the game's WebSocket
//   /api/mp/<game>/ping   its region ping
// The original servers are lockstep relays shared by all of them; see
// README.md for what the games send and what they expect back.
import { WebSocketServer } from "ws";
import { acceptConnection, clientIp, rateLimiter, MAX_MESSAGE_BYTES } from "../../src/limits.js";
import { log } from "../../src/log.js";
import { Reader } from "./wire.js";
import { duelGame } from "./duel.js";
import { lobbyGame } from "./lobby.js";

// Players sit in a waiting room for minutes without sending a byte, so dead
// connections are found with WebSocket pings, not an idle timer.
const HEARTBEAT_MS = 20_000;
const MAX_BUFFERED = 256 * 1024;
// Only one region answers its ping, so the game lists one server, not six
// buttons that all lead to the same place. The region in a private code is ignored.
const REGION = "EA";

let nextId = 1;

class Client {
  constructor(ws, ip, release) {
    this.id = nextId++;
    this.ws = ws;
    this.ip = ip;
    this.release = release;
    this.alive = true;
    this.closed = false;
    this.joined = false;
    this.match = null;
  }

  send(bytes) {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    if (this.ws.bufferedAmount > MAX_BUFFERED) {
      log("slow_close", { client: this.id });
      return this.close();
    }
    this.ws.send(bytes, { binary: true });
  }

  close() {
    this.ws.terminate();
  }
}

function brosGame(name, protocol) {
  const clients = new Set();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.close();
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function onMessage(client, data, isBinary) {
    const limiter = client.limiter;
    if (!limiter.allow()) {
      log("rate_close", { game: name, client: client.id, ip: client.ip });
      return client.close();
    }
    if (!isBinary) return;
    try {
      const r = new Reader(Buffer.isBuffer(data) ? data : Buffer.concat(data));
      const type = r.int();
      if (type === 1) {
        if (client.joined) return;
        client.joined = true;
        protocol.join(client, r);
      } else if (client.joined) {
        protocol.message(client, type, r);
      }
    } catch (err) {
      log("bad_message", {
        game: name,
        client: client.id,
        ip: client.ip,
        error: String(err.message || err),
      });
      client.close();
    }
  }

  function onConnection(ws, req, release) {
    const client = new Client(ws, clientIp(req), release);
    client.limiter = rateLimiter();
    clients.add(client);
    ws.on("pong", () => (client.alive = true));
    ws.on("message", (data, isBinary) => onMessage(client, data, isBinary));
    const done = () => {
      if (client.closed) return;
      client.closed = true;
      clients.delete(client);
      release();
      if (client.joined) protocol.leave(client);
    };
    ws.on("close", done);
    ws.on("error", done);
  }

  return {
    name,
    upgrade(req, socket, head, rest) {
      if (rest !== "play") return socket.destroy();
      const ip = clientIp(req);
      const release = acceptConnection(ip);
      if (!release) {
        log("ip_cap", { game: name, ip });
        socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
        return socket.destroy();
      }
      // A failed handshake never reaches the callback; give the slot back then too.
      socket.once("close", release);
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req, release));
    },
    http(req, res, rest) {
      if (rest === "ping") {
        const region = new URL(req.url, "http://x").searchParams.get("region") || REGION;
        res.writeHead(region.toUpperCase() === REGION ? 200 : 404, {
          "content-type": "text/plain",
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
        });
        return res.end("pong");
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end();
    },
    stats() {
      return { connections: clients.size, ...protocol.stats() };
    },
  };
}

export const basketbros = brosGame("basketbros", duelGame());
export const soccerbros = brosGame("soccerbros", duelGame());
export const baseballbros = brosGame("baseballbros", duelGame());
export const footballbros = brosGame("footballbros", lobbyGame());
export const hockeybros = brosGame("hockeybros", lobbyGame());
export const wrestlebros = brosGame("wrestlebros", duelGame());
export const fightbros = brosGame("fightbros", lobbyGame({ maxPlayers: 4, teams: false }));
