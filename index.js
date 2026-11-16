import { createServer } from "./src/server.js";
import { log } from "./src/log.js";
import { connectionCount } from "./src/limits.js";
import games from "./games/index.js";

const PORT = Number(process.env.PORT) || 8093;
const HOST = process.env.HOST || "0.0.0.0";

const server = createServer({ games });
server.listen(PORT, HOST, () => log("listening", { host: HOST, port: PORT, games: Object.keys(games) }));

// A line a minute with what is running, so load and bandwidth can be watched.
setInterval(() => {
  const stats = {};
  for (const [name, game] of Object.entries(games)) if (game.stats) stats[name] = game.stats();
  log("stats", { connections: connectionCount(), games: stats });
}, 60_000).unref();

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    log("stopping", { signal });
    server.close();
    process.exit(0);
  });
}
