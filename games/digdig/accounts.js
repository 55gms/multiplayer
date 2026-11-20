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

// { uuid, handle, gold, items, achievements, stats } as 55GMS sends it, or null
function account(body) {
  if (typeof body?.uuid !== "string") return null;
  return {
    uuid: body.uuid,
    handle: String(body.handle || ""),
    gold: Number(body.gold) || 0,
    items: Array.isArray(body.items) ? body.items.map(String) : [],
    achievements: Array.isArray(body.achievements) ? body.achievements.map(String) : [],
    stats: stats(body.stats),
  };
}

// lifetime totals (achievements.js)
function stats(body) {
  const out = {};
  for (const key of ["kills", "dirt", "gold", "tags", "br_wins", "ores"]) out[key] = Number(body?.[key]) || 0;
  return out;
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

// What the server decided an account earned: gold (a life's digging, a win),
// an achievement, a life's stats. Each call has a unique source, which 55GMS
// applies once, so a retry after a lost answer is harmless; calls wait here,
// in order, until 55GMS has them.
const queue = [];
const waiting = new Map(); // source -> [resolve]
let timer = null;
let backoff = 1000;

function enqueue(path, body, source) {
  if (!accountsEnabled) return Promise.resolve(null);
  if (queue.length >= QUEUE_MAX) {
    const dropped = queue.shift();
    log("digdig_grant_dropped", { source: dropped.source, reason: "queue_full" });
    for (const r of waiting.get(dropped.source) || []) r(null);
    waiting.delete(dropped.source);
  }
  queue.push({ path, body, source });
  const done = new Promise((resolve) => waiting.set(source, [...(waiting.get(source) || []), resolve]));
  flushSoon(0);
  return done;
}

// Resolves with the account's new balance once 55GMS has the grant (or null).
export function grantGold(uuid, amount, source) {
  if (!(amount > 0)) return Promise.resolve(null);
  return enqueue("gold", { uuid, amount: Math.floor(amount), source }, source).then((body) =>
    Number.isFinite(Number(body?.gold)) ? Number(body.gold) : null,
  );
}

// Unlocks an achievement (55GMS pays its reward with it): the account after, or null.
export function unlockAchievement(uuid, achievement) {
  return enqueue("achievement", { uuid, achievement }, `achievement:${uuid}:${achievement}`).then(account);
}

// Adds a life's stats to the account's totals: the totals after, or null.
export function addStats(uuid, lifeStats, source) {
  return enqueue("stats", { uuid, stats: lifeStats, source }, source).then((body) => (body?.stats ? stats(body.stats) : null));
}

function flushSoon(delay) {
  if (timer) return;
  timer = setTimeout(flush, delay);
  timer.unref?.();
}

async function flush() {
  timer = null;
  while (queue.length) {
    const item = queue[0];
    let answer = null;
    try {
      const { status, body } = await call(item.path, item.body, 10000);
      if (status >= 500 || status === 403) throw new Error(`HTTP ${status}`);
      // 2xx (applied, or applied before) or a 4xx 55GMS will never accept
      if (status === 200) answer = body;
      else log("digdig_grant_refused", { path: item.path, source: item.source, status, error: String(body?.error || "") });
      queue.shift();
      backoff = 1000;
    } catch (err) {
      log("digdig_grant_failed", { path: item.path, source: item.source, error: String(err.message || err), retryMs: backoff });
      flushSoon(backoff);
      backoff = Math.min(backoff * 2, 60000);
      return;
    }
    for (const r of waiting.get(item.source) || []) r(answer);
    waiting.delete(item.source);
  }
}
