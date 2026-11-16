// Caps that keep one client, or one address, from using up the server.

export const MAX_MESSAGE_BYTES = 64 * 1024;
export const IDLE_MS = 60_000;
export const MAX_ROOM_PLAYERS = 16;
// High because a whole school often shares one public address; each player
// holds one or two connections at a time.
export const MAX_CONNECTIONS_PER_IP = 64;
const RATE_PER_SECOND = 120;
const RATE_BURST = 240;

const perIp = new Map();

function isLoopback(address = "") {
  return address === "::1" || address.startsWith("127.") || address === "::ffff:127.0.0.1";
}

// Caddy is the only thing that connects from loopback in production. It
// appends the address that connected to it to X-Forwarded-For, so the last
// entry is the one a client cannot forge (the same rule as 55GMS).
export function clientIp(req) {
  const address = req.socket.remoteAddress || "";
  if (isLoopback(address)) {
    const forwarded = String(req.headers["x-forwarded-for"] || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (forwarded.length) return forwarded.at(-1);
  }
  return address;
}

// Returns a function that gives the slot back, or null when the address is at its cap.
export function acceptConnection(ip) {
  const count = perIp.get(ip) || 0;
  if (count >= MAX_CONNECTIONS_PER_IP) return null;
  perIp.set(ip, count + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (perIp.get(ip) || 1) - 1;
    if (left <= 0) perIp.delete(ip);
    else perIp.set(ip, left);
  };
}

// Token bucket: RATE_PER_SECOND refill, RATE_BURST capacity.
export function rateLimiter() {
  let tokens = RATE_BURST;
  let last = Date.now();
  return {
    allow() {
      const now = Date.now();
      tokens = Math.min(RATE_BURST, tokens + ((now - last) / 1000) * RATE_PER_SECOND);
      last = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

export function connectionCount() {
  let total = 0;
  for (const n of perIp.values()) total += n;
  return total;
}
