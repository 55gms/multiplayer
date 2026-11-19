// Building the snapshots the digdig.io client reads (see README.md).
import { varint } from "./stream.js";

export class Writer {
  constructor() {
    this.parts = [];
  }
  bytes(arr) {
    this.parts.push(Buffer.from(arr));
    return this;
  }
  u8(v) {
    return this.bytes([v & 255]);
  }
  u16(v) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v & 0xffff);
    return this.bytes(b);
  }
  u32(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0);
    return this.bytes(b);
  }
  f32(v) {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v);
    return this.bytes(b);
  }
  varint(v) {
    return this.bytes(varint(v >>> 0));
  }
  zigzag(v) {
    return this.varint(((v << 1) ^ (v >> 31)) >>> 0);
  }
  string(s) {
    return this.bytes([...Buffer.from(s, "utf8"), 0]);
  }
  // An entity id as the client reads it: (generation << 16 | index), sent rotated by 16.
  id(id) {
    return this.u32(((id >>> 16) | (id << 16)) >>> 0);
  }
  done() {
    return Buffer.concat(this.parts);
  }
}

export const entityId = (index, generation = 1) => ((generation << 16) | index) >>> 0;

// flags as the client means them; the wire byte is flags ^ 18
export const FLAG_NO_FIELDS = 128;
export const FLAG_COMPONENT_MASK = 64;
export const FLAG_NO_COMPONENTS = 32;

// One entity: components (indexes 0-13, a new entity) or null (an update), then
// fields as [[index, write(w)], ...] in increasing index order.
export function writeEntity(w, id, components, fields = [], extraFlags = 0) {
  w.id(id);
  let flags = extraFlags;
  if (components) {
    flags |= FLAG_COMPONENT_MASK;
  } else {
    flags |= FLAG_NO_COMPONENTS;
  }
  w.u8(flags ^ 18);
  if (components) w.u16(components.reduce((m, c) => m | (1 << c), 0));
  let prev = 0;
  for (const [index, write] of fields) {
    w.varint((index - prev) ^ 1);
    write(w);
    prev = index;
  }
  w.varint(1);
}

// A whole snapshot body for a type-1 packet.
export function snapshot({ world = 1, tick, ack = 0, deleted = [], entities = [], messages = [] }) {
  const w = new Writer();
  w.varint(world).varint(tick).varint(ack);
  w.varint(0); // A: unknown, 0 works
  w.varint(deleted.length).u16(0);
  for (const id of deleted) w.id(id);
  w.u16(0);
  for (const e of entities) writeEntity(w, e.id, e.components, e.fields, e.flags);
  w.u32(0);
  for (const [seq, body] of messages) w.varint(seq).bytes(body);
  w.varint(0);
  w.bytes([0, 0, 0]);
  return w.done();
}
