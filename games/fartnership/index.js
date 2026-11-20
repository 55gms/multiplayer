// Fartnership: /api/mp/fartnership/ws (the game's socket) and
// /api/mp/fartnership/api/presence (the "N online" line on its menu).
//
// The game's page in 55GMS sends the socket and the presence calls for its
// own server's host here. Messages are JSON text frames: see rooms.js.
import { WebSocketServer } from "ws";
import { acceptConnection, clientIp, rateLimiter } from "../../src/limits.js";
import { log } from "../../src/log.js";
import { Room, findRoom, roomStats, roomCount, MAX_ROOMS } from "./rooms.js";

// A custom fart is up to 3 s of 22.05 kHz 16-bit mono WAV, sent as base64:
// about 176 KiB. Everything else is small.
const MAX_PAYLOAD = 256 * 1024;
const MAX_SOUND_CHARS = 200 * 1024;
const SOUND_COOLDOWN_MS = 2000;
const HEARTBEAT_MS = 20_000;
const MAX_BUFFERED = 1024 * 1024;
const PRESENCE_TTL_MS = 30_000;
const MAX_PRESENCE = 50_000;

let nextId = 1;
const conns = new Set();
const presence = new Map(); // id -> {at, s}

function connection(ws, ip) {
  const limiter = rateLimiter();
  const conn = {
    id: `c${nextId++}`,
    room: null,
    sound: null,
    soundAt: 0,
    lastEmote: 0,
    alive: true,
    send(message) {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED) {
        log("slow_close", { game: "fartnership", client: conn.id });
        return ws.terminate();
      }
      ws.send(JSON.stringify(message));
    },
    heartbeat() {
      if (!conn.alive) return ws.terminate();
      conn.alive = false;
      ws.ping();
    },
  };
  conns.add(conn);
  conn.send({ t: "welcome", id: conn.id });

  const leave = () => conn.room?.removeMember(conn);

  ws.on("pong", () => (conn.alive = true));
  ws.on("close", () => {
    leave();
    conns.delete(conn);
  });
  ws.on("error", () => ws.terminate());
  ws.on("message", (data, isBinary) => {
    conn.alive = true;
    if (!limiter.allow()) {
      log("rate_close", { game: "fartnership", client: conn.id, ip });
      return ws.close(1008, "rate");
    }
    if (isBinary) return;
    let m;
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    try {
      handle(conn, m, leave);
    } catch (err) {
      log("fartnership_error", { client: conn.id, type: String(m.t).slice(0, 20), error: String(err?.message || err) });
    }
  });
}

function handle(conn, m, leave) {
  const room = conn.room;
  switch (m.t) {
    case "hello":
      return conn.send({ t: "welcome", id: conn.id });
    case "ping":
      return conn.send({ t: "pong", c: Number(m.c) || 0 });
    case "create": {
      leave();
      if (roomCount() >= MAX_ROOMS)
        return conn.send({ t: "error", msg: "Every room is taken right now. Try again in a minute." });
      const created = new Room(conn);
      const error = created.addMember(conn, m.players);
      if (error) {
        created.close();
        conn.send({ t: "error", msg: error });
      }
      return;
    }
    case "join": {
      const target = findRoom(m.code);
      if (!target) return conn.send({ t: "error", msg: "No room with that code. Check the letters?" });
      if (target === room) return;
      leave();
      const error = target.addMember(conn, m.players);
      if (error) conn.send({ t: "error", msg: error });
      return;
    }
    case "leave":
      if (room) {
        leave();
        conn.send({ t: "left" });
      }
      return;
    case "sound": {
      const id = typeof m.id === "string" ? m.id.slice(0, 80) : "";
      const sound = typeof m.data === "string" ? m.data : "";
      if (!id || !sound || sound.length > MAX_SOUND_CHARS || !/^[A-Za-z0-9+/=]+$/.test(sound)) return;
      const now = Date.now();
      if (now - conn.soundAt < SOUND_COOLDOWN_MS) return;
      conn.soundAt = now;
      conn.sound = { id, data: sound };
      room?.sound(conn);
      return;
    }
  }
  if (!room) return;
  switch (m.t) {
    case "config":
      return room.configure(conn, m.config);
    case "bots":
      return room.setBots(conn, m.count);
    case "start":
      return room.start(conn);
    case "in":
      return room.input(conn, m.p);
    case "respawn":
      return room.respawn(conn);
    case "emote":
      return room.emote(conn, Number(m.pid), Number(m.k));
    case "vote":
      return room.vote(conn, Number(m.target));
    case "lobby":
      return room.backToLobby(conn);
  }
}

// The menu's "N online · M playing", from each open copy's beat every few seconds.
function presenceCall(req, res) {
  const url = new URL(req.url, "http://x");
  const id = (url.searchParams.get("id") || "").slice(0, 64);
  const now = Date.now();
  if (id && (presence.has(id) || presence.size < MAX_PRESENCE)) {
    presence.set(id, { at: now, s: url.searchParams.get("s") === "game" ? "game" : "menu" });
  }
  let online = 0;
  let playing = 0;
  for (const [key, entry] of presence) {
    if (now - entry.at > PRESENCE_TTL_MS) presence.delete(key);
    else {
      online++;
      if (entry.s === "game") playing++;
    }
  }
  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify({ online: Math.max(1, online), playing }));
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });

setInterval(() => {
  for (const conn of conns) conn.heartbeat();
}, HEARTBEAT_MS).unref();

export default {
  name: "fartnership",
  http(req, res, rest) {
    if (rest === "api/presence" && (req.method === "GET" || req.method === "HEAD")) return presenceCall(req, res);
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not found"}');
  },
  upgrade(req, socket, head, rest) {
    if (rest !== "ws") return socket.destroy();
    const ip = clientIp(req);
    const release = acceptConnection(ip);
    if (!release) {
      log("ip_cap", { game: "fartnership", ip });
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    socket.once("close", release);
    wss.handleUpgrade(req, socket, head, (ws) => connection(ws, ip));
  },
  stats() {
    return { connections: conns.size, ...roomStats() };
  },
};
