import { EventEmitter } from "node:events";
import { WebSocketServer } from "ws";
import { Reader, Writer } from "./protocol18.js";
import { MsgType, Op } from "./codes.js";
import { acceptConnection, clientIp, rateLimiter, IDLE_MS, MAX_MESSAGE_BYTES } from "../limits.js";
import { log } from "../log.js";

const MAGIC = 0xf3;
const ENCRYPTED = 0x80;
const MAX_BUFFERED = 1024 * 1024; // a client this far behind is dropped
const SUBPROTOCOL = "GpBinaryV18";

export const traffic = { bytesIn: 0, bytesOut: 0, peers: 0 };

let nextPeerId = 1;

// Photon's server clock: a 32-bit millisecond counter. One process, so every
// role and room shares it, which PUN's PhotonNetwork.Time relies on.
export function serverTime() {
  return Date.now() % 2 ** 31 | 0;
}

function isLocalHost(host) {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}

export class Peer extends EventEmitter {
  constructor(ws, req, release) {
    super();
    this.id = nextPeerId++;
    this.ws = ws;
    this.ip = clientIp(req);
    this.host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0].trim();
    // Public hosts are always served over TLS at the edge, even when a CDN
    // reaches Caddy over plain HTTP, so only local hosts get ws://.
    this.scheme = isLocalHost(this.host) ? "ws" : "wss";
    this.state = {};
    this.query = new URL(req.url || "/", "http://x").searchParams;
    this.closed = false;
    this.release = release;
    this.limiter = rateLimiter();
    this.idle = null;
    traffic.peers++;

    ws.on("message", (data, isBinary) => this.receive(data, isBinary));
    ws.on("close", () => this.cleanup());
    ws.on("error", () => this.cleanup());
    this.touch();
    this.sendBytes(Uint8Array.of(MAGIC, MsgType.InitResponse, 0));
  }

  touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      log("idle_close", { peer: this.id });
      this.close();
    }, IDLE_MS);
  }

  receive(data, isBinary) {
    if (this.closed) return;
    const buf = data instanceof Buffer ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
    traffic.bytesIn += buf.length;
    this.touch();
    if (!this.limiter.allow()) {
      log("rate_close", { peer: this.id, ip: this.ip });
      return this.close();
    }
    try {
      if (!isBinary || buf.length < 3 || buf[0] !== MAGIC) throw new RangeError("not a Photon message");
      const type = buf[1];
      if (type & ENCRYPTED) throw new RangeError("encrypted messages are not supported");
      if (type === MsgType.InternalOperationRequest) return this.internal(buf);
      if (type !== MsgType.Operation) throw new RangeError(`unexpected message type ${type}`);
      const opCode = buf[2];
      const params = new Reader(buf, 3).params();
      const rawReader = new Reader(buf, 3);
      const rawParams = rawReader.rawParams();
      this.emit("op", opCode, params, rawParams);
    } catch (err) {
      log("bad_frame", { peer: this.id, ip: this.ip, error: String(err.message || err), head: buf.subarray(0, 16).toString("hex") });
      this.close();
    }
  }

  // Internal op 1 is Photon's ping: echo the client's time, add ours.
  internal(buf) {
    const opCode = buf[2];
    const params = new Reader(buf, 3).params();
    if (opCode !== Op.Ping) throw new RangeError(`unknown internal op ${opCode}`);
    const w = new Writer(32).byte(MAGIC).byte(MsgType.InternalOperationResponse).byte(Op.Ping).short(0).value(null);
    w.params(
      new Map([
        [1, params.get(1) ?? 0],
        [2, serverTime()],
      ]),
    );
    this.sendBytes(w.finish());
  }

  respond(opCode, returnCode, params = new Map(), debugMessage = null, rawParams = null) {
    const w = new Writer().byte(MAGIC).byte(MsgType.OperationResponse).byte(opCode).short(returnCode).value(debugMessage);
    w.params(params, rawParams);
    this.sendBytes(w.finish());
  }

  event(code, params = new Map(), rawParams = null) {
    this.sendBytes(encodeEvent(code, params, rawParams));
  }

  // A whole event message from encodeEvent, for sending the same bytes to many peers.
  eventRaw(bytes) {
    this.sendBytes(bytes);
  }

  sendBytes(bytes) {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    if (this.ws.bufferedAmount > MAX_BUFFERED) {
      log("slow_close", { peer: this.id });
      return this.close();
    }
    traffic.bytesOut += bytes.length;
    this.ws.send(bytes, { binary: true });
  }

  close() {
    if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) this.ws.close();
    this.cleanup();
  }

  cleanup() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idle);
    traffic.peers--;
    this.release();
    this.emit("close");
    this.removeAllListeners("op");
    // Close the socket if it is still open (cleanup can come from close()).
    if (this.ws.readyState === this.ws.OPEN) this.ws.terminate();
  }
}

export function encodeEvent(code, params = new Map(), rawParams = null) {
  return new Writer().byte(MAGIC).byte(MsgType.Event).byte(code).params(params, rawParams).finish();
}

// Upgrade handler for one Photon role. `onPeer` gets each new Peer.
export function photonUpgrade(onPeer) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  });
  return (req, socket, head) => {
    const release = acceptConnection(clientIp(req));
    if (!release) {
      log("ip_cap", { ip: clientIp(req) });
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    // A failed handshake never reaches the callback; give the slot back then too.
    socket.once("close", release);
    wss.handleUpgrade(req, socket, head, (ws) => {
      try {
        onPeer(new Peer(ws, req, release));
      } catch (err) {
        log("peer_error", { error: String(err) });
        ws.terminate();
        release();
      }
    });
  };
}
