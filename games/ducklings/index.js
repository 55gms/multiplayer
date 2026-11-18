// Ducklings.io: a relay to the game's own server, not a server of our own.
// The game connects to wss://ducklings.io/ws, which now redirects (browsers
// do not follow redirects for WebSockets) to wss://multiplayer.ducklings.io/ws,
// and that server refuses any Origin but https://ducklings.io (401). It is
// also on a domain filters block. So the 55GMS page sends the game's socket
// to /api/mp/ducklings/play, and each connection here opens one to the real
// server with the Origin it accepts and passes frames through unchanged.
//
// The server only does matchmaking and WebRTC signalling (JSON text frames:
// rooms, offers, ICE candidates, TURN credentials); the match itself runs
// host-to-peer over WebRTC data channels, which this relay never sees.
import WebSocket, { WebSocketServer } from "ws";
import { acceptConnection, clientIp, rateLimiter, MAX_MESSAGE_BYTES } from "../../src/limits.js";
import { log } from "../../src/log.js";

const UPSTREAM = "wss://multiplayer.ducklings.io/ws";
const ORIGIN = "https://ducklings.io";
const HEARTBEAT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_BUFFERED = 256 * 1024;
// Frames the game sends before the upstream socket opens.
const MAX_PENDING = 64;

let nextId = 1;
const relays = new Set();

function closeCode(code) {
  // 1005, 1006 and 1015 are reserved: they may be reported but never sent.
  return code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1011;
}

function relay(client, req, ip) {
  const id = nextId++;
  const limiter = rateLimiter();
  const pending = [];
  let alive = true;
  let done = false;

  const upstream = new WebSocket(UPSTREAM, {
    origin: ORIGIN,
    headers: { "user-agent": req.headers["user-agent"] || "Mozilla/5.0" },
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
    handshakeTimeout: CONNECT_TIMEOUT_MS,
  });

  const entry = {
    heartbeat() {
      if (!alive) return end(1001, "timeout");
      alive = false;
      client.ping();
    },
  };
  relays.add(entry);

  function end(code = 1000, reason = "") {
    if (done) return;
    done = true;
    relays.delete(entry);
    for (const ws of [client, upstream]) {
      if (ws.readyState === WebSocket.OPEN) ws.close(closeCode(code), reason.slice(0, 120));
      else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    }
  }

  function forward(to, data, isBinary) {
    if (to.readyState !== WebSocket.OPEN) return;
    if (to.bufferedAmount > MAX_BUFFERED) {
      log("slow_close", { game: "ducklings", client: id });
      return end(1011, "slow");
    }
    to.send(data, { binary: isBinary });
  }

  client.on("pong", () => (alive = true));
  client.on("message", (data, isBinary) => {
    if (!limiter.allow()) {
      log("rate_close", { game: "ducklings", client: id, ip });
      return end(1008, "rate");
    }
    if (upstream.readyState === WebSocket.OPEN) return forward(upstream, data, isBinary);
    if (pending.length >= MAX_PENDING) return end(1008, "too many");
    pending.push([data, isBinary]);
  });
  client.on("close", (code, reason) => end(code, String(reason)));
  client.on("error", () => end(1011));

  upstream.on("open", () => {
    for (const [data, isBinary] of pending.splice(0)) forward(upstream, data, isBinary);
  });
  upstream.on("message", (data, isBinary) => forward(client, data, isBinary));
  upstream.on("unexpected-response", (_, res) => {
    log("upstream_refused", { game: "ducklings", client: id, status: res.statusCode });
    end(1011, "upstream");
  });
  upstream.on("close", (code, reason) => end(code, String(reason)));
  upstream.on("error", (err) => {
    log("upstream_error", { game: "ducklings", client: id, error: String(err.message || err) });
    end(1011, "upstream");
  });
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

setInterval(() => {
  for (const r of relays) r.heartbeat();
}, HEARTBEAT_MS).unref();

export default {
  name: "ducklings",
  upgrade(req, socket, head, rest) {
    if (rest !== "play") return socket.destroy();
    const ip = clientIp(req);
    const release = acceptConnection(ip);
    if (!release) {
      log("ip_cap", { game: "ducklings", ip });
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    socket.once("close", release);
    wss.handleUpgrade(req, socket, head, (ws) => relay(ws, req, ip));
  },
  stats() {
    return { connections: relays.size };
  },
};
