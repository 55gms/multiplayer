// Name server: one region, whose master server is this process.
import { randomUUID, randomBytes } from "node:crypto";
import { Op, Param, Err } from "../../src/photon/codes.js";
import { StringArray } from "../../src/photon/protocol18.js";
import { address } from "./address.js";

export const REGION = "eu";

// Tokens handed out on authentication, so a player keeps one user id from
// the name server to the master to the game server (clients send the token
// back, not always the id).
const TOKEN_MS = 6 * 60 * 60 * 1000;
const tokens = new Map(); // token -> { userId, until }
setInterval(() => {
  const now = Date.now();
  for (const [t, v] of tokens) if (v.until < now) tokens.delete(t);
}, 60_000).unref();

// Authenticate is answered the same way on every role: who you are, and a
// token. Any AppId, version and token is accepted.
export function authenticate(peer, opCode, params, role) {
  const token = params.get(Param.Token);
  const known = typeof token === "string" ? tokens.get(token) : null;
  const asked = params.get(Param.UserId);
  const userId = known ? known.userId : typeof asked === "string" && asked ? asked.slice(0, 64) : randomUUID();
  const secret = known ? token : randomBytes(16).toString("hex");
  tokens.set(secret, { userId, until: Date.now() + TOKEN_MS });
  peer.state.userId = userId;
  const out = new Map([
    [Param.UserId, userId],
    [Param.Secret, secret],
  ]);
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
