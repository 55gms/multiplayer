// The queue on another 1v1.lol server. A casual search that finds nobody
// here within REMOTE.afterMs is sent to another public Photon server for the
// game (by default 1v1.lol Reloaded's, wss://ws.onecloudcdn.site/ns), so a
// lone 55GMS player still finds an opponent:
//
// - master: this connection logs in to the other name server and master
//   (Authenticate with REMOTE.name as the nickname, the name that server
//   lists us under), then passes the player's master operations through
//   unchanged. The game server address in its answers becomes
//   /api/mp/1v1/remote?ticket=…, on this host.
// - game: /api/mp/1v1/remote relays the player's game server connection to
//   that address frame for frame. Only the first Authenticate is rewritten,
//   to carry the other server's token and user id instead of ours.
//
// Ranked stays here (accounts only, results kept by 55GMS); matches played
// there are not refereed, so they give no 55GMS XP.
import { randomBytes } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { Reader, Writer } from "../../src/photon/protocol18.js";
import { MsgType, Op, Param, Err } from "../../src/photon/codes.js";
import { acceptConnection, clientIp, rateLimiter, MAX_MESSAGE_BYTES } from "../../src/limits.js";
import { address } from "./address.js";
import { log } from "../../src/log.js";

const MAGIC = 0xf3;
const SUBPROTOCOL = "GpBinaryV18";
const APP_ID = "82620531-8737-4824-8fd2-a4d29e2417d8";
const APP_VERSION = "3.800";

function remoteUrl() {
  const value = process.env.MP_1V1_REMOTE_URL ?? "wss://ws.onecloudcdn.site/ns";
  if (!value || value === "off") return null;
  try {
    const u = new URL(value);
    return u.protocol === "wss:" || u.protocol === "ws:" ? u : null;
  } catch {
    return null;
  }
}

const URL_ = remoteUrl();
export const REMOTE = {
  enabled: Boolean(URL_),
  url: URL_?.toString() || null,
  host: URL_?.host || null,
  name: (process.env.MP_1V1_REMOTE_NAME || "55gms.com").slice(0, 32),
  region: process.env.MP_1V1_REMOTE_REGION || "us",
  afterMs: Math.max(0, Number(process.env.MP_1V1_REMOTE_AFTER_MS) || 10_000),
};

const CONNECT_TIMEOUT_MS = 10_000;
const PING_MS = 5_000;
const HEARTBEAT_MS = 20_000;
const MAX_BUFFERED = 1024 * 1024;
const MAX_PENDING = 64;
const TICKET_MS = 2 * 60_000;
const MAX_TICKETS = 5000;

export const remoteStats = { masters: 0, games: 0 };

// The other server only ever hands out addresses on its own host; anything
// else is refused, so this never dials somewhere a client picked.
function allowed(addr) {
  try {
    const u = new URL(addr);
    return (u.protocol === "wss:" || u.protocol === "ws:") && u.host === REMOTE.host;
  } catch {
    return false;
  }
}

function connect(url) {
  return new WebSocket(url, [SUBPROTOCOL], {
    origin: "https://55gms.com",
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
    handshakeTimeout: CONNECT_TIMEOUT_MS,
  });
}

function opBytes(opCode, params, raw = null) {
  return new Writer().byte(MAGIC).byte(MsgType.Operation).byte(opCode).params(params, raw).finish();
}

// One operation response's parts, or null for any other message.
function readResponse(buf) {
  if (buf.length < 6 || buf[0] !== MAGIC || buf[1] !== MsgType.OperationResponse) return null;
  const r = new Reader(buf, 5);
  const debug = r.value();
  const start = r.pos;
  const params = r.params();
  const raw = new Reader(buf, start).rawParams();
  return { opCode: buf[2], rc: buf.readInt16LE(3), debug, params, raw };
}

function toBuffer(data) {
  return data instanceof Buffer ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
}

// Sends one operation on a fresh socket and resolves with its response.
function ask(ws, opCode, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`no answer to op ${opCode}`)), CONNECT_TIMEOUT_MS);
    function done(err, value) {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onClose);
      err ? reject(err) : resolve(value);
    }
    function onMessage(data) {
      const res = readResponse(toBuffer(data));
      if (res && res.opCode === opCode) done(null, res);
    }
    function onClose(err) {
      done(err instanceof Error ? err : new Error("closed"));
    }
    ws.on("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onClose);
    const send = () => ws.send(opBytes(opCode, params));
    if (ws.readyState === WebSocket.OPEN) send();
    else ws.once("open", send);
  });
}

// --- tickets: a game server address and the login it needs --------------

const tickets = new Map(); // id -> { address, token, userId, at }

function issueTicket(entry) {
  const now = Date.now();
  for (const [id, t] of tickets) if (now - t.at > TICKET_MS || tickets.size >= MAX_TICKETS) tickets.delete(id);
  const id = randomBytes(18).toString("base64url");
  tickets.set(id, { ...entry, at: now });
  return id;
}

function ticket(id) {
  const t = typeof id === "string" ? tickets.get(id) : null;
  if (!t || Date.now() - t.at > TICKET_MS) return null;
  return t;
}

// --- master ---------------------------------------------------------------

// Logs in to the other server's name server and master for this player.
// Resolves with { send(buf), close() }; the master's messages go to the
// player from then on. Rejects if either login fails.
export async function openRemoteMaster(peer) {
  const appId = typeof peer.state.appId === "string" ? peer.state.appId : APP_ID;
  const appVersion = typeof peer.state.appVersion === "string" ? peer.state.appVersion : APP_VERSION;
  const login = new Map([
    [Param.ApplicationId, appId],
    [Param.AppVersion, appVersion],
    [Param.Nickname, REMOTE.name],
  ]);

  const ns = connect(REMOTE.url);
  ns.on("error", () => {});
  let auth;
  try {
    auth = await ask(ns, Op.Authenticate, new Map([...login, [Param.Region, REMOTE.region]]));
  } finally {
    ns.terminate();
  }
  const masterAddress = auth.params.get(Param.Address);
  if (auth.rc !== Err.Ok || !allowed(masterAddress)) throw new Error(`name server refused (${auth.rc} ${auth.debug || ""})`);

  const master = connect(masterAddress);
  master.on("error", () => {});
  let session;
  try {
    session = await ask(master, Op.Authenticate, new Map([...login, [Param.Token, auth.params.get(Param.Token)]]));
  } catch (err) {
    master.terminate();
    throw err;
  }
  if (session.rc !== Err.Ok || peer.closed) {
    master.terminate();
    throw new Error(`master refused (${session.rc} ${session.debug || ""})`);
  }

  const state = {
    token: session.params.get(Param.Token) ?? auth.params.get(Param.Token),
    userId: session.params.get(Param.UserId) ?? auth.params.get(Param.UserId),
  };
  remoteStats.masters++;
  log("remote_master", { peer: peer.id, master: masterAddress });

  const ping = setInterval(() => {
    if (master.readyState !== WebSocket.OPEN) return;
    const w = new Writer(32).byte(MAGIC).byte(MsgType.InternalOperationRequest).byte(Op.Ping);
    master.send(w.params(new Map([[1, Date.now() % 2 ** 31 | 0]])).finish());
  }, PING_MS);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    remoteStats.masters--;
    if (master.readyState === WebSocket.OPEN || master.readyState === WebSocket.CONNECTING) master.close();
    if (!peer.closed) peer.close();
  }

  master.on("message", (data) => {
    const buf = toBuffer(data);
    if (buf.length < 2 || buf[0] !== MAGIC) return;
    const type = buf[1];
    if (type === MsgType.Event) return peer.sendBytes(buf);
    if (type === MsgType.DisconnectReason) return close();
    if (type !== MsgType.OperationResponse) return; // init and ping answers are ours
    const res = readResponse(buf);
    if (!res) return;
    if (typeof res.params.get(Param.Token) === "string") state.token = res.params.get(Param.Token);
    const gameAddress = res.params.get(Param.Address);
    if (res.rc !== Err.Ok || typeof gameAddress !== "string") return peer.sendBytes(buf);
    if (!allowed(gameAddress)) {
      log("remote_bad_address", { peer: peer.id, op: res.opCode });
      return peer.respond(res.opCode, Err.InternalServerError);
    }
    const id = issueTicket({ address: gameAddress, token: state.token, userId: state.userId });
    res.raw.delete(Param.Address);
    log("remote_room", { peer: peer.id, op: res.opCode, room: res.params.get(Param.RoomName) });
    peer.respond(res.opCode, res.rc, new Map([[Param.Address, `${address(peer, "remote")}?ticket=${id}`]]), res.debug, res.raw);
  });
  master.on("close", close);
  peer.once("close", close);

  return {
    send(buf) {
      if (master.readyState !== WebSocket.OPEN) return;
      if (master.bufferedAmount > MAX_BUFFERED) return close();
      master.send(buf);
    },
    close,
  };
}

// --- game server relay ----------------------------------------------------

// The player's first Authenticate, with the other server's login in place of ours.
function rewriteAuth(buf, t) {
  if (buf.length < 4 || buf[0] !== MAGIC || buf[1] !== MsgType.Operation) return null;
  const opCode = buf[2];
  if (opCode !== Op.Authenticate && opCode !== Op.AuthenticateOnce) return null;
  const raw = new Reader(buf, 3).rawParams();
  raw.delete(Param.Token);
  raw.delete(Param.UserId);
  const params = new Map([[Param.Token, t.token]]);
  if (typeof t.userId === "string") params.set(Param.UserId, t.userId);
  return Buffer.from(opBytes(opCode, params, raw));
}

const relays = new Set();

function relay(client, t, ip) {
  const limiter = rateLimiter();
  const pending = [];
  let alive = true;
  let done = false;
  let authed = false;
  const upstream = connect(t.address);
  remoteStats.games++;

  const entry = {
    heartbeat() {
      if (!alive) return end();
      alive = false;
      client.ping();
    },
  };
  relays.add(entry);

  function end() {
    if (done) return;
    done = true;
    relays.delete(entry);
    remoteStats.games--;
    for (const ws of [client, upstream]) {
      if (ws.readyState === WebSocket.OPEN) ws.close();
      else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    }
  }

  function forward(to, data) {
    if (to.readyState !== WebSocket.OPEN) return;
    if (to.bufferedAmount > MAX_BUFFERED) return end();
    to.send(data, { binary: true });
  }

  function fromClient(data) {
    let buf = toBuffer(data);
    if (!authed) {
      const rewritten = rewriteAuth(buf, t);
      if (rewritten) {
        authed = true;
        buf = rewritten;
      }
    }
    forward(upstream, buf);
  }

  client.on("pong", () => (alive = true));
  client.on("message", (data) => {
    if (!limiter.allow()) {
      log("rate_close", { game: "1v1-remote", ip });
      return end();
    }
    if (upstream.readyState === WebSocket.OPEN) return fromClient(data);
    if (pending.length >= MAX_PENDING) return end();
    pending.push(data);
  });
  client.on("close", end);
  client.on("error", end);

  upstream.on("open", () => {
    for (const data of pending.splice(0)) fromClient(data);
  });
  upstream.on("message", (data) => forward(client, data));
  upstream.on("unexpected-response", (_, res) => {
    log("remote_refused", { status: res.statusCode });
    end();
  });
  upstream.on("close", end);
  upstream.on("error", (err) => {
    log("remote_error", { error: String(err.message || err) });
    end();
  });
}

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_MESSAGE_BYTES,
  perMessageDeflate: false,
  handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
});

setInterval(() => {
  for (const r of relays) r.heartbeat();
}, HEARTBEAT_MS).unref();

export function remoteGameUpgrade(req, socket, head) {
  const t = ticket(new URL(req.url || "/", "http://x").searchParams.get("ticket"));
  if (!REMOTE.enabled || !t) return socket.destroy();
  const ip = clientIp(req);
  const release = acceptConnection(ip);
  if (!release) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  socket.once("close", release);
  wss.handleUpgrade(req, socket, head, (ws) => relay(ws, t, ip));
}
