import http from "node:http";
import { connectionCount } from "./limits.js";

const PREFIX = "/api/mp/";

// Splits "/api/mp/<game>/<rest>?query" into [game, rest]; null for any other path.
function route(url = "") {
  const path = url.split("?")[0];
  if (!path.startsWith(PREFIX)) return null;
  const parts = path.slice(PREFIX.length).split("/");
  return [parts[0], parts.slice(1).join("/")];
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function createServer({ games }) {
  const server = http.createServer((req, res) => {
    const target = route(req.url);
    if (!target) return json(res, 404, { error: "not found" });
    const [name, rest] = target;
    if (name === "health") {
      return json(res, 200, { ok: true, games: Object.keys(games), connections: connectionCount() });
    }
    const game = Object.hasOwn(games, name) ? games[name] : null;
    if (!game?.http) return json(res, 404, { error: "not found" });
    try {
      game.http(req, res, rest);
    } catch {
      if (!res.headersSent) json(res, 500, { error: "server error" });
    }
  });

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    const target = route(req.url);
    const game = target && Object.hasOwn(games, target[0]) ? games[target[0]] : null;
    if (!game?.upgrade) return socket.destroy();
    try {
      game.upgrade(req, socket, head, target[1]);
    } catch {
      socket.destroy();
    }
  });

  return server;
}
