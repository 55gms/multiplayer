// 1v1.lol (JustPlay.LOL, build 3.800, PUN 2): Photon name, master and game
// servers at /api/mp/1v1/{ns,master,game}.
import { photonUpgrade, traffic } from "../../src/photon/peer.js";
import { Err } from "../../src/photon/codes.js";
import { log } from "../../src/log.js";
import { nameServerOp } from "./nameserver.js";

const roles = {
  ns: nameServerOp,
};

function attach(role, handle) {
  return photonUpgrade((peer) => {
    peer.state.role = role;
    peer.on("op", (opCode, params, rawParams) => {
      try {
        if (handle(peer, opCode, params, rawParams) === false) {
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
  name: "1v1",
  upgrade(req, socket, head, rest) {
    const role = rest.split("/")[0];
    const upgrade = Object.hasOwn(upgrades, role) ? upgrades[role] : null;
    if (!upgrade) return socket.destroy();
    upgrade(req, socket, head);
  },
  stats() {
    return { peers: traffic.peers, bytesIn: traffic.bytesIn, bytesOut: traffic.bytesOut };
  },
};
