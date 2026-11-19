// Name server: one region, whose master server is this process.
//
// Smash Karts logs in to Photon with its own Firebase ID token (custom
// authentication that Photon's cloud checks with the game's webhook). Here
// any token is accepted: the player's user id is the Firebase uid the login
// names (parameter 225), taken as given, because it only names a seat in a room. Each
// login is also remembered so the player can be sent on to the official Photon
// cloud with the real one (remote.js).
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Op, Param, Err } from "../../src/photon/codes.js";
import { StringArray } from "../../src/photon/protocol18.js";
import { address } from "./address.js";
import { connected } from "./presence.js";
import { rememberLogin } from "./remote.js";
import { log } from "../../src/log.js";

export const REGION = "us";
// The regions the game's own menu lists. They all lead to this server, which
// has one place: the game only reads the names.
const REGIONS = ["us", "usw", "eu", "asia", "sa", "in"];
const TOKEN_MS = 12 * 60 * 60 * 1000;

// Tokens are signed, not stored: "<userId b64url>.<expiry>.<hmac>", so they
// carry a player from the name server to the master and game servers and
// survive a restart (the secret is kept on disk, as for 1v1.lol).
function loadSecret() {
  if (process.env.MP_TOKEN_SECRET) return Buffer.from(process.env.MP_TOKEN_SECRET);
  const file = path.resolve(process.env.MP_SECRET_FILE || ".token-secret");
  try {
    const existing = fs.readFileSync(file);
    if (existing.length >= 32) return existing;
  } catch {}
  const secret = randomBytes(32);
  try {
    fs.writeFileSync(file, secret, { mode: 0o600 });
  } catch (err) {
    log("token_secret_not_saved", { error: String(err.message || err) });
  }
  return secret;
}
const SECRET = loadSecret();

function sign(payload) {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

function makeToken(userId) {
  const payload = `${Buffer.from(userId).toString("base64url")}.${Date.now() + TOKEN_MS}`;
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  if (typeof token !== "string" || token.length > 300) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const want = Buffer.from(sign(payload));
  const got = Buffer.from(parts[2]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  if (!(Number(parts[1]) > Date.now())) return null;
  return Buffer.from(parts[0], "base64url").toString();
}

// Authenticate is answered the same way on every role: who you are, and a
// token. Any application id and version is accepted.
export function authenticate(peer, opCode, params, role, buf) {
  if (peer.state.authenticated) {
    return peer.respond(opCode, Err.OperationNotAllowedInCurrentState, new Map(), "Already authenticated");
  }
  const known = readToken(params.get(Param.Token));
  const asked = params.get(Param.UserId);
  let userId;
  if (known) userId = known;
  else if (typeof asked === "string" && /^(fb:)?[\w-]{1,128}$/.test(asked)) userId = asked.startsWith("fb:") ? asked : `fb:${asked}`;
  else userId = randomUUID();
  peer.state.userId = userId;
  peer.state.authenticated = true;
  if (role === "ns" && buf && buf.length <= 8192) rememberLogin(userId, buf, peer.query);
  if (role !== "ns") connected(peer);
  const out = new Map([
    [Param.UserId, userId],
    [Param.Secret, makeToken(userId)],
  ]);
  if (role === "master") out.set(223, 0);
  if (role === "ns") {
    out.set(Param.Address, address(peer, "master"));
    out.set(Param.Cluster, "default");
  }
  peer.respond(opCode, Err.Ok, out);
}

export function nameServerOp(peer, opCode, params, rawParams, buf) {
  switch (opCode) {
    case Op.GetRegions:
      peer.respond(
        opCode,
        Err.Ok,
        new Map([
          [Param.Region, StringArray.from(REGIONS)],
          [Param.Address, StringArray.from(REGIONS.map(() => address(peer, "master")))],
        ]),
      );
      return;
    case Op.Authenticate:
    case Op.AuthenticateOnce:
      return authenticate(peer, opCode, params, "ns", buf);
    default:
      return false;
  }
}
