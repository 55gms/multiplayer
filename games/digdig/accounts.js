// 55GMS accounts for digdig.io. The 55GMS page hands the client a game token
// as its saved login (the client sends it in message 28); 55GMS, on the same
// box, says whose it is and keeps the account's gold and skins. Every call
// carries MP_SHARED_SECRET, the same value as 55GMS's. Without it, or with
// 55GMS unreachable, everyone plays as a guest and nothing is kept.
import { log } from "../../src/log.js";

const GMS = (process.env.GMS_INTERNAL_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
const SECRET = process.env.MP_SHARED_SECRET || "";
const QUEUE_MAX = 2000;

export const accountsEnabled = SECRET.length >= 16;

async function call(path, body, timeout) {
  const response = await fetch(`${GMS}/api/digdig/internal/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mp-secret": SECRET },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

// { uuid, handle, gold, items } as 55GMS sends it, or null
function account(body) {
  if (typeof body?.uuid !== "string") return null;
  return {
    uuid: body.uuid,
    handle: String(body.handle || ""),
    gold: Number(body.gold) || 0,
    items: Array.isArray(body.items) ? body.items.map(String) : [],
  };
}

// { account } for a game token, { invalid: true } when 55GMS does not know it
// (expired, signed out), or null when that cannot be told (55GMS unreachable).
export async function verifyToken(token) {
  if (!accountsEnabled) return null;
  if (typeof token !== "string" || !token || token.length > 1000) return { invalid: true };
  try {
    const { status, body } = await call("verify", { token }, 3000);
    if (status === 200 && account(body)) return { account: account(body) };
    return status === 404 ? { invalid: true } : null;
  } catch (err) {
    log("digdig_verify_failed", { error: String(err.message || err) });
    return null;
  }
}

// Buys a skin for an account at 55GMS's price: the account afterwards, or
// { error } (not enough gold, already owned, unknown skin, unreachable).
export async function buySkin(uuid, item) {
  if (!accountsEnabled) return { error: "unavailable" };
  try {
    const { status, body } = await call("buy", { uuid, item }, 5000);
    if (status === 200) return account(body) || { error: "unavailable" };
    return { error: String(body.error || `HTTP ${status}`) };
  } catch (err) {
    log("digdig_buy_failed", { error: String(err.message || err) });
    return { error: "unavailable" };
  }
}

// Gold the server decided an account earned (a life's digging, a win). Each
// grant has a unique source, which 55GMS applies once, so a retry after a lost
// answer is harmless; grants wait here until 55GMS has them.
const queue = [];
const waiting = new Map(); // source -> [resolve]
let timer = null;
let backoff = 1000;

// Resolves with the account's new balance once 55GMS has the grant (or null).
export function grantGold(uuid, amount, source) {
  if (!accountsEnabled || !(amount > 0)) return Promise.resolve(null);
  if (queue.length >= QUEUE_MAX) {
    const dropped = queue.shift();
    log("digdig_gold_dropped", { source: dropped.source, reason: "queue_full" });
    for (const r of waiting.get(dropped.source) || []) r(null);
    waiting.delete(dropped.source);
  }
  queue.push({ uuid, amount: Math.floor(amount), source });
  const done = new Promise((resolve) => waiting.set(source, [...(waiting.get(source) || []), resolve]));
  flushSoon(0);
  return done;
}

function flushSoon(delay) {
  if (timer) return;
  timer = setTimeout(flush, delay);
  timer.unref?.();
}

async function flush() {
  timer = null;
  while (queue.length) {
    const grant = queue[0];
    let gold = null;
    try {
      const { status, body } = await call("gold", grant, 10000);
      if (status >= 500 || status === 403) throw new Error(`HTTP ${status}`);
      // 2xx (applied, or applied before) or a 4xx 55GMS will never accept
      if (status === 200 && Number.isFinite(Number(body.gold))) gold = Number(body.gold);
      queue.shift();
      backoff = 1000;
    } catch (err) {
      log("digdig_gold_failed", { source: grant.source, error: String(err.message || err), retryMs: backoff });
      flushSoon(backoff);
      backoff = Math.min(backoff * 2, 60000);
      return;
    }
    for (const r of waiting.get(grant.source) || []) r(gold);
    waiting.delete(grant.source);
  }
}
