// 55GMS accounts for 1v1.lol. The 55GMS page adds the account's game token
// to each connection as ?gms=; 55GMS (on the same box) says whose it is, and
// is told the result of every match the referee decides. Both calls carry
// MP_SHARED_SECRET, the same value as 55GMS's. Without it, or with 55GMS
// unreachable, everyone plays as a guest and no results are kept.
import { log } from "../../src/log.js";

const GMS = (process.env.GMS_INTERNAL_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
const SECRET = process.env.MP_SHARED_SECRET || "";
const VERIFY_MS = 2000;
const CACHE_MS = 60 * 1000;
const QUEUE_MAX = 500;

export const accountsEnabled = SECRET.length >= 16;

async function call(path, body, timeout) {
  const response = await fetch(`${GMS}/api/1v1/internal/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mp-secret": SECRET },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const cache = new Map(); // token -> { account, until }

// { uuid, handle, ratings } for a game token, or null (unknown, expired, or
// 55GMS unreachable). Answers are kept for a few minutes per token.
export async function verifyToken(token) {
  if (!accountsEnabled || typeof token !== "string" || !token || token.length > 1000) return null;
  const hit = cache.get(token);
  if (hit && hit.until > Date.now()) return hit.account;
  try {
    const { status, body } = await call("verify", { token }, VERIFY_MS);
    const account = status === 200 && typeof body.uuid === "string" ? { uuid: body.uuid, handle: String(body.handle || ""), ratings: body.ratings || {} } : null;
    if (status === 200 || status === 404) cache.set(token, { account, until: Date.now() + CACHE_MS });
    if (cache.size > 10000) cache.delete(cache.keys().next().value);
    return account;
  } catch (err) {
    log("verify_failed", { error: String(err.message || err) });
    return null;
  }
}

// Results wait here until 55GMS has them, so a restart of 55GMS (a rolling
// deploy) loses nothing. 55GMS applies each matchId once, so a retry after
// a lost answer is harmless.
const queue = [];
let timer = null;
let backoff = 1000;

export function queueSize() {
  return queue.length;
}

export function postMatch(result) {
  if (!accountsEnabled) return;
  if (queue.length >= QUEUE_MAX) {
    log("match_dropped", { matchId: queue.shift().matchId, reason: "queue_full" });
  }
  queue.push(result);
  flushSoon(0);
}

function flushSoon(delay) {
  if (timer) return;
  timer = setTimeout(flush, delay);
  timer.unref?.();
}

async function flush() {
  timer = null;
  while (queue.length) {
    const result = queue[0];
    try {
      const { status, body } = await call("match", result, 10000);
      if (status >= 500 || status === 403) throw new Error(`HTTP ${status}`);
      // 2xx (applied or already applied) or a 4xx 55GMS will never accept.
      queue.shift();
      backoff = 1000;
      log("match_posted", { matchId: result.matchId, status, applied: body.applied ?? null });
    } catch (err) {
      log("match_post_failed", { matchId: result.matchId, error: String(err.message || err), retryMs: backoff });
      flushSoon(backoff);
      backoff = Math.min(backoff * 2, 60000);
      return;
    }
  }
}
