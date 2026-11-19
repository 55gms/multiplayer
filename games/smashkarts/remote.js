// The official Photon cloud. A PLAY that finds no room on this server goes to
// the cloud Smash Karts itself plays on, so a lone 55GMS player meets the
// people who play there:
//
// - login: the player's own name-server login (the Firebase ID token they sent
//   to this server's name server, nameserver.js) is replayed to the cloud's
//   name server, then the master gets the token that answers it.
// - master: the player's connection to our master then passes their master
//   operations through unchanged. The game server address in the answer
//   becomes /api/mp/smashkarts/remote/<ticket>, on this host.
// - game: that address relays the player's game server connection to the cloud
//   frame for frame. Only the first Authenticate is rewritten, to carry the
//   cloud's token and user id instead of ours.
//
// The cloud only ever hands out addresses on Photon's own hosts; anything else
// is refused, so this never dials somewhere a client picked. Private games stay
// on this server (master.js).
import { randomBytes } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { Reader, Writer } from "../../src/photon/protocol18.js";
import { MsgType, Op, Param, Err } from "../../src/photon/codes.js";
import { acceptConnection, clientIp, rateLimiter, MAX_MESSAGE_BYTES } from "../../src/limits.js";
import { address } from "./address.js";
import { log } from "../../src/log.js";

const MAGIC = 0xf3;
const SUBPROTOCOL = "GpBinaryV18";
const NAME_SERVER = process.env.MP_SK_REMOTE_NS || "wss://ns.photonengine.io:19093/";
// Smash Karts' Photon application: the cloud checks the login against it.
const APP_ID = process.env.MP_SK_APP_ID || "32cef7fc-1db1-46a0-b3f2-f80d0eefce18";

export const REMOTE = { enabled: process.env.MP_SK_REMOTE !== "off" };

const CONNECT_TIMEOUT_MS = 10_000;
const PING_MS = 5_000;
const HEARTBEAT_MS = 20_000;
const MAX_BUFFERED = 1024 * 1024;
const MAX_PENDING = 64;
const TICKET_MS = 2 * 60_000;
const LOGIN_MS = 30 * 60_000;
const MAX_TICKETS = 5000;
const MAX_LOGINS = 5000;

export const remoteStats = { masters: 0, games: 0 };

function allowed(addr) {
  try {
    const u = new URL(addr);
    return u.protocol === "wss:" && (u.hostname.endsWith(".exitgames.com") || u.hostname.endsWith(".photonengine.io"));
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

// Sends one message on a fresh socket and resolves with the response to `opCode`.
function ask(ws, opCode, frame) {
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
    const send = () => ws.send(frame);
    if (ws.readyState === WebSocket.OPEN) send();
    else ws.once("open", send);
  });
}

// --- logins: what each player sent to our name server ----------------------

const logins = new Map(); // userId -> { frame, query, at }

export function rememberLogin(userId, frame, query) {
  const now = Date.now();
  for (const [id, l] of logins) if (now - l.at > LOGIN_MS || logins.size >= MAX_LOGINS) logins.delete(id);
  const version = query?.get("libversion");
  const sid = query?.get("sid");
  logins.set(userId, { frame: Buffer.from(frame), version: /^[\w.]{1,16}$/.test(version || "") ? version : "4.1.6.11", sid: /^\d{1,4}$/.test(sid || "") ? sid : "30", at: now });
}

function urlFor(base, login, app) {
  const u = new URL(base);
  u.searchParams.set("libversion", login.version);
  u.searchParams.set("sid", login.sid);
  u.searchParams.set("app", app);
  return u.toString();
}

// --- tickets: a game server address and the login it needs ------------------

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

// --- master -----------------------------------------------------------------

// Logs in to the cloud's name server and master for this player. Resolves with
// { send(buf), close() }; the master's messages go to the player from then on.
// Rejects if either login fails.
export async function openRemoteMaster(peer) {
  const login = logins.get(peer.state.userId);
  if (!login) throw new Error("no login to pass on");

  const ns = connect(urlFor(NAME_SERVER, login, "NameServer"));
  ns.on("error", () => {});
  let auth;
  try {
    auth = await ask(ns, Op.Authenticate, login.frame);
  } finally {
    ns.terminate();
  }
  const masterAddress = auth.params.get(Param.Address);
  if (auth.rc !== Err.Ok || !allowed(masterAddress)) throw new Error(`name server refused (${auth.rc} ${auth.debug || ""})`);

  const masterUrl = new URL(masterAddress);
  masterUrl.pathname = masterUrl.pathname.replace(/\/?$/, "/");
  const master = connect(urlFor(masterUrl, login, APP_ID));
  master.on("error", () => {});
  let session;
  try {
    session = await ask(master, Op.Authenticate, opBytes(Op.Authenticate, new Map([[Param.Token, auth.params.get(Param.Token)]])));
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
    master.send(w.params(new Map([[1, (Date.now() % 2 ** 31) | 0]])).finish());
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
    const id = issueTicket({ address: gameAddress, token: state.token, userId: state.userId, version: login.version, sid: login.sid });
    res.raw.delete(Param.Address);
    log("remote_room", { peer: peer.id, op: res.opCode, room: res.params.get(Param.RoomName) });
    peer.respond(res.opCode, res.rc, new Map([[Param.Address, `${address(peer, "remote")}/${id}`]]), res.debug, res.raw);
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

// --- game server relay ---------------------------------------------------------

// The player's first Authenticate, with the cloud's login in place of ours.
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

function relay(client, t, ip, app) {
  const limiter = rateLimiter();
  const pending = [];
  let alive = true;
  let done = false;
  let authed = false;
  const upstream = connect(urlFor(t.address.replace(/\/?$/, "/"), t, app));
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
      log("rate_close", { game: "smashkarts-remote", ip });
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
  upstream.on("message", (data) => forward(client, toBuffer(data)));
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

// The client adds "/?libversion=…" to the address it was given, so the ticket
// is a path segment: /api/mp/smashkarts/remote/<ticket>.
export function remoteGameUpgrade(req, socket, head, rest = "") {
  const t = ticket(rest.split("/")[1]);
  if (!REMOTE.enabled || !t) return socket.destroy();
  const ip = clientIp(req);
  const release = acceptConnection(ip);
  if (!release) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  socket.once("close", release);
  wss.handleUpgrade(req, socket, head, (ws) => relay(ws, t, ip, APP_ID));
}
