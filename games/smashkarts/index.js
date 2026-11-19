// Smash Karts (Tall Team, PUN 2 over Photon): name, master and game servers at
// /api/mp/smashkarts/{ns,master,game}, and /api/mp/smashkarts/remote/<ticket>, the relay
// to the official Photon cloud's game servers (remote.js).
import { photonUpgrade, traffic } from "../../src/photon/peer.js";
import { Err } from "../../src/photon/codes.js";
import { log } from "../../src/log.js";
import { nameServerOp } from "./nameserver.js";
import { masterOp, paramSummary } from "./master.js";
import { gameOp } from "./game.js";
import { registry } from "./rooms.js";
import { remoteGameUpgrade, remoteStats } from "./remote.js";

const DEBUG = process.env.MP_DEBUG === "1";

const roles = {
  ns: nameServerOp,
  master: masterOp,
  game: gameOp,
};

function attach(role, handle) {
  return photonUpgrade((peer) => {
    peer.state.role = role;
    peer.on("op", (opCode, params, rawParams, buf) => {
      if (DEBUG && !(role === "game" && opCode === 253)) {
        log("op", { role, peer: peer.id, actor: peer.state.actor?.actorNr, op: opCode, params: paramSummary(params) });
      }
      try {
        if (handle(peer, opCode, params, rawParams, buf) === false) {
          log("unknown_op", { role, op: opCode, params: [...params.keys()] });
          peer.respond(opCode, Err.InvalidOperation, new Map(), `Operation ${opCode} not supported`);
        }
      } catch (err) {
        log("op_error", { role, op: opCode, error: String(err.stack || err) });
        peer.respond(opCode, Err.InternalServerError);
      }
    });
  });
}

const upgrades = Object.fromEntries(Object.entries(roles).map(([role, handle]) => [role, attach(role, handle)]));

export default {
  name: "smashkarts",
  upgrade(req, socket, head, rest) {
    const role = rest.split("/")[0];
    if (role === "remote") return remoteGameUpgrade(req, socket, head, rest);
    const upgrade = Object.hasOwn(upgrades, role) ? upgrades[role] : null;
    if (!upgrade) return socket.destroy();
    upgrade(req, socket, head);
  },
  // Region ping (PUN on WebGL times an HTTP GET to the region's host): an
  // empty 200 is a successful ping.
  http(req, res, rest) {
    if (rest === "ping") {
      res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*", "cache-control": "no-store" });
      return res.end();
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not found"}');
  },
  stats() {
    return { peers: traffic.peers, rooms: registry.count(), players: registry.players(), bytesIn: traffic.bytesIn, bytesOut: traffic.bytesOut, remote: { ...remoteStats } };
  },
};
