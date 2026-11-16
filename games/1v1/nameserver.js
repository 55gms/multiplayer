// Name server: one region, whose master server is this process.
import { randomUUID, randomBytes } from "node:crypto";
import { Op, Param, Err } from "../../src/photon/codes.js";
import { StringArray } from "../../src/photon/protocol18.js";
import { address } from "./address.js";

export const REGION = "eu";

// Authenticate is answered the same way on every role: who you are, and a
// token. Any AppId, version and token is accepted.
export function authenticate(peer, opCode, params, role) {
  const asked = params.get(Param.UserId);
  const userId = typeof asked === "string" && asked ? asked.slice(0, 64) : randomUUID();
  peer.state.userId = userId;
  const out = new Map([
    [Param.UserId, userId],
    [Param.Secret, randomBytes(16).toString("hex")],
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
