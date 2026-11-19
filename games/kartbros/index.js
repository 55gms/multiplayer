// Kart Bros: the game's session server, here. The client finds its servers at
// wss://kart{da,ea,eu,mw,we}.kartbros.io/<n> and pings https://kart<xx>.kartbros.io/ping;
// the 55GMS page sends both here:
//   /api/mp/kartbros/play   the game's WebSocket
//   /api/mp/kartbros/ping   its region ping ("pong", only for DA)
//
// The original is a relay with a lobby: the host's game runs the race and
// streams it to the others; the server keeps the sessions (code, members,
// host, roles) and passes every member's frames to the others stamped with
// who sent them. See README.md and wire.js for the frames.
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { acceptConnection, clientIp, rateLimiter, MAX_MESSAGE_BYTES } from "../../src/limits.js";
import { log } from "../../src/log.js";
import { NAME, decode, serverFrame, clientFrame, sequenced, relayed, pack } from "./wire.js";

const HEARTBEAT_MS = 20_000;
const MAX_BUFFERED = 1024 * 1024;
const REGION = "DA";
const MAX_PLAYERS = 6;
const MAX_SPECTATORS = 8;
const MAX_SESSIONS = 2000;
// What the original server answers in session_host_state; the client turns on
// its newer lobby features (roles, host handover, rejoin) when it sees them.
const SESSION_CAPABILITIES = 7;
const CODE = /^[A-Z0-9]{4,16}$/;
const MAX_TEXT = 40;
const COUNTDOWN_LEAD_S = 1;

// Enums from the game (value order as declared).
const ROLE = { player: 0, spectator: 1 };
const ROLE_REFUSAL = { playerSeatsFull: 0, spectatorSeatsFull: 1, raceActive: 2, lastPlayer: 3 };
const HOST_REASON = { hostLeft: 0, transfer: 1, claim: 2 };
const RESUME_FAIL = { invalidToken: 0, versionMismatch: 1, roomGone: 2 };

const sessions = new Map();
let nextConnection = 1;
const connections = new Set();

const text = (s, max = MAX_TEXT) =>
  typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max) : "";

class Member {
  constructor(ws, ip) {
    this.id = nextConnection++;
    this.ws = ws;
    this.ip = ip;
    this.alive = true;
    this.closed = false;
    this.limiter = rateLimiter();
    this.session = null;
    this.playerId = -1;
    this.clientId = crypto.randomUUID();
    this.token = crypto.randomBytes(16);
    this.outSeq = 0;
    this.role = ROLE.player;
    this.isWaiting = false;
    this.info = { playerName: "", broId: "", flagId: "", networkVersion: "" };
  }

  sendFrames(frames) {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    if (this.ws.bufferedAmount > MAX_BUFFERED) {
      log("slow_close", { game: "kartbros", client: this.id });
      return this.close();
    }
    this.ws.send(pack(frames), { binary: true });
  }

  // Wrap in a sequence number, counted per member.
  seq(frame) {
    return sequenced(++this.outSeq, frame);
  }

  close() {
    this.ws.terminate();
  }
}

class Session {
  constructor(code, networkVersion) {
    this.code = code;
    this.networkVersion = networkVersion;
    this.members = new Map(); // playerId -> Member
    this.hostId = 0;
    this.hostEpoch = 1;
    this.raceActive = false;
    this.created = Date.now();
  }

  freeId() {
    for (let id = 0; id < 255; id++) if (!this.members.has(id)) return id;
    return -1;
  }

  count(role) {
    let n = 0;
    for (const m of this.members.values()) if (m.role === role) n++;
    return n;
  }

  others(member) {
    return [...this.members.values()].filter((m) => m !== member);
  }

  spectatorIds() {
    return [...this.members.values()].filter((m) => m.role === ROLE.spectator).map((m) => m.playerId);
  }

  hostState() {
    return serverFrame("session_host_state", {
      hostPlayerId: this.hostId,
      hostEpoch: this.hostEpoch,
      sessionCapabilities: SESSION_CAPABILITIES,
    });
  }

  // To every member, each with its own sequence number.
  broadcast(frame, except = null) {
    for (const m of this.members.values()) if (m !== except) m.sendFrames([m.seq(frame)]);
  }

  setHost(id, reason) {
    const previous = this.hostId;
    if (id === previous) return;
    this.hostId = id;
    this.hostEpoch++;
    this.broadcast(
      serverFrame("host_changed", {
        hostPlayerId: id,
        hostEpoch: this.hostEpoch,
        previousHostPlayerId: previous,
        reason,
      }),
    );
  }

  // Lowest id among the players, else among the spectators.
  pickHost() {
    const ids = [...this.members.values()].sort((a, b) => a.role - b.role || a.playerId - b.playerId);
    return ids.length ? ids[0].playerId : -1;
  }
}

function sendError(member, message) {
  member.sendFrames([serverFrame("error", { message })]);
}

function welcome(member, session) {
  member.sendFrames([
    member.seq(session.hostState()),
    member.seq(serverFrame("session_resume_token", { token: [...member.token] })),
  ]);
}

function createSession(member, msg) {
  if (member.session) return;
  const code = String(msg.sessionId || "").toUpperCase();
  if (!CODE.test(code) || sessions.has(code) || sessions.size >= MAX_SESSIONS) {
    return sendError(member, "Couldn't create the lobby. Try again!");
  }
  const session = new Session(code, text(msg.networkVersion, 16));
  sessions.set(code, session);
  member.session = session;
  member.playerId = 0;
  member.info = pickInfo(msg);
  session.members.set(0, member);
  welcome(member, session);
  member.sendFrames([
    serverFrame("session_created", { sessionId: code, clientId: member.clientId, playerId: 0 }),
    member.seq(serverFrame("session_roles", { spectatorIds: [], yourRole: member.role })),
  ]);
  log("kart_session", { code, client: member.id });
}

function pickInfo(msg) {
  return {
    playerName: text(msg.playerName, 24) || "BRO",
    broId: text(msg.broId),
    flagId: text(msg.flagId),
    networkVersion: text(msg.networkVersion, 16),
  };
}

function joinSession(member, msg) {
  if (member.session) return;
  const session = sessions.get(String(msg.sessionId || "").toUpperCase());
  if (!session) return member.sendFrames([serverFrame("invalid_session", {})]);
  let role = ROLE.player;
  if (session.count(ROLE.player) >= MAX_PLAYERS) {
    if (session.count(ROLE.spectator) >= MAX_SPECTATORS) return member.sendFrames([serverFrame("session_full", {})]);
    role = ROLE.spectator;
  }
  const playerId = session.freeId();
  if (playerId < 0) return member.sendFrames([serverFrame("session_full", {})]);
  member.session = session;
  member.playerId = playerId;
  member.role = role;
  member.info = pickInfo(msg);
  // A player who arrives mid-race waits for the next one.
  member.isWaiting = session.raceActive;
  session.members.set(playerId, member);

  const players = [...session.members.values()]
    .sort((a, b) => a.playerId - b.playerId)
    .map((m) => ({
      playerId: m.playerId,
      playerName: m.info.playerName,
      broId: m.info.broId,
      flagId: m.info.flagId,
      isWaiting: m.isWaiting,
    }));
  welcome(member, session);
  member.sendFrames([
    serverFrame("session_joined", {
      sessionId: session.code,
      clientId: member.clientId,
      playerId,
      clientCount: session.members.size,
      players,
      raceActive: session.raceActive,
      rematchInProgress: false,
      isWaiting: member.isWaiting,
      currentTrackId: null,
      currentBotDifficulty: null,
      currentBotCount: 0,
    }),
    member.seq(serverFrame("session_roles", { spectatorIds: session.spectatorIds(), yourRole: role })),
  ]);
  session.broadcast(
    serverFrame("client_joined", {
      clientId: member.clientId,
      sessionId: session.code,
      clientCount: session.members.size,
      playerId,
      ...member.info,
      isWaiting: member.isWaiting,
    }),
    member,
  );
  if (role === ROLE.spectator) session.broadcast(serverFrame("member_role", { playerId, role }), member);
}

function leave(member) {
  const session = member.session;
  if (!session || session.members.get(member.playerId) !== member) return;
  session.members.delete(member.playerId);
  member.session = null;
  if (!session.members.size) {
    sessions.delete(session.code);
    return;
  }
  session.broadcast(
    serverFrame("client_disconnected", {
      clientId: member.clientId,
      sessionId: session.code,
      clientCount: session.members.size,
      playerId: member.playerId,
      wasWaiting: member.isWaiting,
    }),
  );
  if (session.hostId === member.playerId) session.setHost(session.pickHost(), HOST_REASON.hostLeft);
  if (session.raceActive && session.count(ROLE.player) === 0) session.raceActive = false;
}

function setRole(member, role) {
  const session = member.session;
  if (role !== ROLE.player && role !== ROLE.spectator) return;
  if (role === member.role) return;
  const refuse = (reason) => member.sendFrames([member.seq(serverFrame("member_role_refused", { reason }))]);
  if (session.raceActive) return refuse(ROLE_REFUSAL.raceActive);
  if (role === ROLE.player && session.count(ROLE.player) >= MAX_PLAYERS) return refuse(ROLE_REFUSAL.playerSeatsFull);
  if (role === ROLE.spectator) {
    if (session.count(ROLE.spectator) >= MAX_SPECTATORS) return refuse(ROLE_REFUSAL.spectatorSeatsFull);
    if (session.count(ROLE.player) <= 1) return refuse(ROLE_REFUSAL.lastPlayer);
  }
  member.role = role;
  session.broadcast(serverFrame("member_role", { playerId: member.playerId, role }));
}

// Messages addressed to the server ([1]).
function serverMessage(member, frame) {
  if (frame.length < 5) throw new RangeError("short message");
  const name = NAME[frame.readUInt32LE(1)];
  const body = frame.subarray(5);
  switch (name) {
    case "ping":
      return member.sendFrames([serverFrame("pong", {})]);
    case "protocol_hello":
    case "client_capabilities":
      return;
    case "create_session":
      return createSession(member, decode(name, body));
    case "join_session":
      return joinSession(member, decode(name, body));
    case "resume_session":
      // Sessions are not kept for a member who dropped; the client goes back
      // to the title screen and can join again with the code.
      return member.sendFrames([serverFrame("session_resume_failed", { reason: RESUME_FAIL.roomGone })]);
    case "leave_session":
      return leave(member);
  }
  const session = member.session;
  if (!session) return;
  switch (name) {
    case "set_member_role":
      return setRole(member, decode(name, body).role);
    case "member_away_report":
      return session.broadcast(serverFrame("member_away", { playerId: member.playerId, away: decode(name, body).away }), member);
    case "host_transfer_request": {
      const target = session.members.get(decode(name, body).preferredPlayerId);
      if (session.hostId !== member.playerId || !target || target === member) {
        return member.sendFrames([member.seq(serverFrame("host_transfer_refused", {}))]);
      }
      return session.setHost(target.playerId, HOST_REASON.transfer);
    }
    case "host_claim":
      if (session.members.has(session.hostId)) return member.sendFrames([member.seq(serverFrame("host_transfer_refused", {}))]);
      return session.setHost(member.playerId, HOST_REASON.claim);
    case "race_start_roster":
      if (member.playerId !== session.hostId) return;
      session.raceActive = true;
      for (const m of session.members.values()) m.isWaiting = false;
      break;
    case "race_countdown_start": {
      // The host sends zero times; the server stamps its clock and a start one
      // second out, so every member counts down to the same moment.
      if (member.playerId !== session.hostId) return;
      const msg = decode(name, body);
      const now = Date.now() / 1000;
      return session.broadcast(clientFrame(name, { ...msg, serverTime: now, startTime: now + COUNTDOWN_LEAD_S }));
    }
    case "race_finished":
    case "rematch_triggered":
      session.raceActive = false;
      break;
  }
  // Anything else meant for the server goes to every member as it came, the
  // sender too, as the original does with the host's race_start_roster.
  session.broadcast(frame);
}

// One frame from a member: [6][seq] wraps any of the others.
function onFrame(member, frame) {
  let kind = frame[0];
  let inner = frame;
  let isSequenced = false;
  if (kind === 6) {
    if (frame.length < 6) throw new RangeError("short message");
    inner = frame.subarray(5);
    kind = inner[0];
    isSequenced = true;
  }
  if (kind === 1) return serverMessage(member, inner);
  const session = member.session;
  if (!session || (kind !== 0 && kind !== 3 && kind !== 4)) return;
  // 0 (unsequenced state), 3 (messages) and 4 (the game's own RPCs, with
  // their own serializer) all go to every other member, stamped.
  const stamped = relayed(member.playerId, session.hostEpoch, inner);
  for (const m of session.others(member)) m.sendFrames([isSequenced ? m.seq(stamped) : stamped]);
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });

const heartbeat = setInterval(() => {
  for (const m of connections) {
    if (!m.alive) {
      m.close();
      continue;
    }
    m.alive = false;
    m.ws.ping();
  }
}, HEARTBEAT_MS);
heartbeat.unref();

function onConnection(ws, req, release) {
  const member = new Member(ws, clientIp(req));
  connections.add(member);
  ws.on("pong", () => (member.alive = true));
  ws.on("message", (data, isBinary) => {
    if (!member.limiter.allow()) {
      log("rate_close", { game: "kartbros", client: member.id, ip: member.ip });
      return member.close();
    }
    if (!isBinary) return;
    try {
      onFrame(member, Buffer.isBuffer(data) ? data : Buffer.concat(data));
    } catch (err) {
      log("bad_message", { game: "kartbros", client: member.id, ip: member.ip, error: String(err.message || err) });
      member.close();
    }
  });
  const done = () => {
    if (member.closed) return;
    member.closed = true;
    connections.delete(member);
    release();
    leave(member);
  };
  ws.on("close", done);
  ws.on("error", done);
}

export default {
  name: "kartbros",
  upgrade(req, socket, head, rest) {
    if (rest !== "play") return socket.destroy();
    const ip = clientIp(req);
    const release = acceptConnection(ip);
    if (!release) {
      log("ip_cap", { game: "kartbros", ip });
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    socket.once("close", release);
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req, release));
  },
  http(req, res, rest) {
    if (rest === "ping") {
      const region = new URL(req.url, "http://x").searchParams.get("region") || REGION;
      const ok = region.toUpperCase() === REGION;
      res.writeHead(ok ? 200 : 404, {
        "content-type": "text/plain",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      });
      return res.end(ok ? "pong\n" : "");
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end();
  },
  stats() {
    let players = 0;
    for (const s of sessions.values()) players += s.members.size;
    return { connections: connections.size, sessions: sessions.size, players };
  },
};

