// Name server: one region, whose master server is this process.
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Op, Param, Err } from "../../src/photon/codes.js";
import { StringArray } from "../../src/photon/protocol18.js";
import { address } from "./address.js";
import { connected } from "./presence.js";
import { playerName } from "./names.js";
import { log } from "../../src/log.js";

export const REGION = "eu";
const TOKEN_MS = 12 * 60 * 60 * 1000;

// Tokens are signed, not stored: "<userId b64url>.<expiry>.<hmac>". They
// carry a player's user id from the name server to the master and game
// servers (clients send the token back, not always the id), and they keep
// working across restarts because the secret is kept on disk.
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

// The user id a token was issued to, or null.
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
// token. Any AppId and version is accepted. Once per connection.
export function authenticate(peer, opCode, params, role) {
  if (peer.state.authenticated) {
    return peer.respond(opCode, Err.OperationNotAllowedInCurrentState, new Map(), "Already authenticated");
  }
  const known = readToken(params.get(Param.Token));
  const asked = params.get(Param.UserId);
  const userId = known || (typeof asked === "string" && asked ? asked.slice(0, 64) : randomUUID());
  peer.state.userId = userId;
  peer.state.name = playerName(peer.query.get("name"));
  peer.state.authenticated = true;
  if (role !== "ns") connected(peer);
  const out = new Map([
    [Param.UserId, userId],
    [Param.Secret, makeToken(userId)],
  ]);
  // PUN takes the player's name from the name server's and master's answer.
  if (role !== "game" && peer.state.name) out.set(Param.Nickname, peer.state.name);
  if (role === "ns") {
    out.set(Param.Address, address(peer, "master"));
    out.set(Param.Cluster, "default");
  }
  peer.respond(opCode, Err.Ok, out);
}

export function nameServerOp(peer, opCode, params) {
  switch (opCode) {
    case Op.GetRegions:
      peer.respond(
        opCode,
        Err.Ok,
        new Map([
          [Param.Region, StringArray.from([REGION])],
          [Param.Address, StringArray.from([address(peer, "master")])],
        ]),
      );
      return;
    case Op.Authenticate:
    case Op.AuthenticateOnce:
      return authenticate(peer, opCode, params, "ns");
    default:
      return false;
  }
}
