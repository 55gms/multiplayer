// Photon binary protocol 1.8 ("GpBinaryV18"): the value encoding used by
// PUN 2 clients. Little-endian; ints and lengths are varints (zigzag for
// signed), with short forms for small ints.
//
// Decoding keeps types the server has to read. Every other value (dictionaries,
// custom types, nested arrays, typed arrays the server never inspects) is parsed
// only to find its end and kept as `Raw`, so it is written back byte for byte.

export const T = {
  Unknown: 0,
  Boolean: 2,
  Byte: 3,
  Short: 4,
  Float: 5,
  Double: 6,
  String: 7,
  Null: 8,
  CompressedInt: 9,
  CompressedLong: 10,
  Int1: 11,
  Int1_: 12,
  Int2: 13,
  Int2_: 14,
  L1: 15,
  L1_: 16,
  L2: 17,
  L2_: 18,
  Custom: 19,
  Dictionary: 20,
  Hashtable: 21,
  ObjectArray: 23,
  OperationRequest: 24,
  OperationResponse: 25,
  EventData: 26,
  BooleanFalse: 27,
  BooleanTrue: 28,
  ShortZero: 29,
  IntZero: 30,
  LongZero: 31,
  FloatZero: 32,
  DoubleZero: 33,
  ByteZero: 34,
  Array: 64,
  BooleanArray: 66,
  ByteArray: 67,
  ShortArray: 68,
  FloatArray: 69,
  DoubleArray: 70,
  StringArray: 71,
  CompressedIntArray: 73,
  CompressedLongArray: 74,
  CustomTypeArray: 83,
  DictionaryArray: 84,
  HashtableArray: 85,
  CustomTypeSlim: 128,
};

// A number that must keep a Photon type other than int.
export class Typed {
  constructor(type, v) {
    this.type = type; // 'byte' | 'short' | 'long' | 'float' | 'double'
    this.v = v;
  }
  valueOf() {
    return Number(this.v);
  }
}
export const byte = (n) => new Typed("byte", n & 0xff);
export const short = (n) => new Typed("short", n);
export const long = (n) => new Typed("long", BigInt(n));
export const float = (n) => new Typed("float", n);
export const double = (n) => new Typed("double", n);

// An encoded value (type byte included), written back unchanged.
export class Raw {
  constructor(bytes) {
    this.bytes = bytes;
  }
}

// string[] (an Array of strings encodes as object[] otherwise).
export class StringArray extends Array {}

// bool[] (FindFriends answers with one).
export class BoolArray extends Array {}

// Number of a Typed, a plain int, or null.
export function num(v) {
  if (typeof v === "number") return v;
  if (v instanceof Typed) return Number(v.v);
  return null;
}

// Stable identity for a Photon key: byte 255 and int 255 are different keys.
export function keyId(key) {
  if (key instanceof Typed) return `${key.type[0]}:${key.v}`;
  if (typeof key === "number") return `i:${key}`;
  if (typeof key === "string") return `s:${key}`;
  if (typeof key === "boolean") return `o:${key}`;
  if (key instanceof Raw) return `r:${Buffer.from(key.bytes).toString("hex")}`;
  return `?:${String(key)}`;
}

// Photon Hashtable: keys of any type, looked up by keyId.
export class Hashtable {
  constructor(entries = []) {
    this.map = new Map();
    for (const [k, v] of entries) this.set(k, v);
  }
  get size() {
    return this.map.size;
  }
  get(key) {
    return this.map.get(keyId(key))?.[1];
  }
  has(key) {
    return this.map.has(keyId(key));
  }
  set(key, value) {
    this.map.set(keyId(key), [key, value]);
    return this;
  }
  delete(key) {
    return this.map.delete(keyId(key));
  }
  *[Symbol.iterator]() {
    yield* this.map.values();
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: false });
const utf8enc = new TextEncoder();

export class Reader {
  constructor(buf, pos = 0) {
    this.buf = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    this.pos = pos;
    this.depth = 0;
  }
  need(n) {
    if (n < 0 || this.pos + n > this.buf.length) throw new RangeError("photon: read past end");
  }
  get remaining() {
    return this.buf.length - this.pos;
  }
  byte() {
    this.need(1);
    return this.buf[this.pos++];
  }
  bytes(n) {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  short() {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  ushort() {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  float() {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  double() {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  varuint() {
    let result = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const b = this.byte();
      result += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return result >>> 0;
    }
    throw new RangeError("photon: varint too long");
  }
  varuint64() {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const b = this.byte();
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
    }
    throw new RangeError("photon: varint too long");
  }
  varint() {
    const u = this.varuint();
    return (u >>> 1) ^ -(u & 1);
  }
  varint64() {
    const u = this.varuint64();
    return (u >> 1n) ^ -(u & 1n);
  }
  length() {
    const n = this.varuint();
    this.need(0);
    if (n > this.remaining) throw new RangeError("photon: length past end");
    return n;
  }
  string() {
    return utf8.decode(this.bytes(this.length()));
  }

  // One value with its type byte.
  value() {
    return this.typed(this.byte());
  }

  // The next value's encoded bytes (type byte included), without decoding it.
  raw() {
    const start = this.pos;
    this.skipTyped(this.byte());
    return this.buf.slice(start, this.pos);
  }

  typed(type) {
    if (++this.depth > 32) throw new RangeError("photon: nested too deep");
    try {
      return this.decode(type);
    } finally {
      this.depth--;
    }
  }

  decode(type) {
    switch (type) {
      case T.Boolean:
        return this.byte() !== 0;
      case T.Byte:
        return byte(this.byte());
      case T.Short:
        return short(this.short());
      case T.Float:
        return float(this.float());
      case T.Double:
        return double(this.double());
      case T.String:
        return this.string();
      case T.Null:
        return null;
      case T.CompressedInt:
        return this.varint();
      case T.CompressedLong:
        return long(this.varint64());
      case T.Int1:
        return this.byte();
      case T.Int1_:
        return -this.byte();
      case T.Int2:
        return this.ushort();
      case T.Int2_:
        return -this.ushort();
      case T.L1:
        return long(this.byte());
      case T.L1_:
        return long(-this.byte());
      case T.L2:
        return long(this.ushort());
      case T.L2_:
        return long(-this.ushort());
      case T.Hashtable: {
        const n = this.length();
        const table = new Hashtable();
        for (let i = 0; i < n; i++) {
          const k = this.value();
          const v = this.value();
          if (k !== null) table.set(k, v);
        }
        return table;
      }
      case T.ObjectArray: {
        const n = this.length();
        const out = [];
        for (let i = 0; i < n; i++) out.push(this.value());
        return out;
      }
      case T.BooleanFalse:
        return false;
      case T.BooleanTrue:
        return true;
      case T.ShortZero:
        return short(0);
      case T.IntZero:
        return 0;
      case T.LongZero:
        return long(0);
      case T.FloatZero:
        return float(0);
      case T.DoubleZero:
        return double(0);
      case T.ByteZero:
        return byte(0);
      case T.ByteArray:
        return this.bytes(this.length()).slice();
      case T.StringArray: {
        const n = this.length();
        const out = new StringArray();
        for (let i = 0; i < n; i++) out.push(this.string());
        return out;
      }
      case T.CompressedIntArray: {
        const n = this.length();
        const out = new Int32Array(n);
        for (let i = 0; i < n; i++) out[i] = this.varint();
        return out;
      }
      default: {
        // Everything else is kept as written.
        const start = this.pos - 1;
        this.skip(type);
        return new Raw(this.buf.slice(start, this.pos));
      }
    }
  }

  skipTyped(type) {
    if (++this.depth > 32) throw new RangeError("photon: nested too deep");
    try {
      this.skip(type);
    } finally {
      this.depth--;
    }
  }

  // Moves past a value of the given type (its type byte already read).
  skip(type) {
    if (type >= T.CustomTypeSlim) {
      this.bytes(this.length());
      return;
    }
    switch (type) {
      case T.Null:
      case T.BooleanFalse:
      case T.BooleanTrue:
      case T.ShortZero:
      case T.IntZero:
      case T.LongZero:
      case T.FloatZero:
      case T.DoubleZero:
      case T.ByteZero:
        return;
      case T.Boolean:
      case T.Byte:
      case T.Int1:
      case T.Int1_:
      case T.L1:
      case T.L1_:
        this.bytes(1);
        return;
      case T.Short:
      case T.Int2:
      case T.Int2_:
      case T.L2:
      case T.L2_:
        this.bytes(2);
        return;
      case T.Float:
        this.bytes(4);
        return;
      case T.Double:
        this.bytes(8);
        return;
      case T.String:
      case T.ByteArray:
        this.bytes(this.length());
        return;
      case T.CompressedInt:
        this.varuint();
        return;
      case T.CompressedLong:
        this.varuint64();
        return;
      case T.Custom:
        this.byte();
        this.bytes(this.length());
        return;
      case T.Hashtable: {
        const n = this.length();
        for (let i = 0; i < n; i++) {
          this.skipTyped(this.byte());
          this.skipTyped(this.byte());
        }
        return;
      }
      case T.ObjectArray:
      case T.Array: {
        const n = this.length();
        for (let i = 0; i < n; i++) this.skipTyped(this.byte());
        return;
      }
      case T.Dictionary: {
        const [k, v] = this.dictionaryHeader();
        this.dictionaryElements(k, v);
        return;
      }
      case T.DictionaryArray: {
        const [k, v] = this.dictionaryHeader();
        const n = this.length();
        for (let i = 0; i < n; i++) this.dictionaryElements(k, v);
        return;
      }
      case T.OperationRequest:
        this.byte();
        this.skipParams();
        return;
      case T.OperationResponse:
        this.byte();
        this.bytes(2);
        this.skipTyped(this.byte());
        this.skipParams();
        return;
      case T.EventData:
        this.byte();
        this.skipParams();
        return;
      case T.BooleanArray: {
        const n = this.varuint(); // elements, 8 to a byte
        this.bytes(Math.ceil(n / 8));
        return;
      }
      case T.ShortArray:
        this.bytes(this.length() * 2);
        return;
      case T.FloatArray:
        this.bytes(this.length() * 4);
        return;
      case T.DoubleArray:
        this.bytes(this.length() * 8);
        return;
      case T.StringArray: {
        const n = this.length();
        for (let i = 0; i < n; i++) this.bytes(this.length());
        return;
      }
      case T.CompressedIntArray: {
        const n = this.length();
        for (let i = 0; i < n; i++) this.varuint();
        return;
      }
      case T.CompressedLongArray: {
        const n = this.length();
        for (let i = 0; i < n; i++) this.varuint64();
        return;
      }
      case T.HashtableArray: {
        const n = this.length();
        for (let i = 0; i < n; i++) this.skip(T.Hashtable);
        return;
      }
      case T.CustomTypeArray: {
        const n = this.length();
        this.byte();
        for (let i = 0; i < n; i++) this.bytes(this.length());
        return;
      }
      default:
        throw new RangeError(`photon: unknown type ${type}`);
    }
  }

  // Key and value types of a Dictionary. A value type of Dictionary or Array
  // carries its own nested header, which is consumed here too.
  dictionaryHeader() {
    const k = this.byte();
    const v = this.byte();
    if (v === T.Dictionary) this.dictionaryHeader();
    else if (v === T.Array) {
      let t = this.byte();
      while (t === T.Array) t = this.byte();
    }
    return [k, v];
  }

  dictionaryElements(k, v) {
    const n = this.length();
    for (let i = 0; i < n; i++) {
      this.skipTyped(k === T.Unknown ? this.byte() : k);
      // A known value type has no type byte per element; a nested Dictionary
      // repeats its own header for each element, which skip() reads.
      this.skipTyped(v === T.Unknown ? this.byte() : v);
    }
  }

  // Parameter table: count byte, then (key byte, typed value) pairs.
  params() {
    const n = this.byte();
    const out = new Map();
    for (let i = 0; i < n; i++) {
      const key = this.byte();
      out.set(key, this.value());
    }
    return out;
  }

  // The same table as encoded bytes per key.
  rawParams() {
    const n = this.byte();
    const out = new Map();
    for (let i = 0; i < n; i++) {
      const key = this.byte();
      out.set(key, this.raw());
    }
    return out;
  }

  skipParams() {
    const n = this.byte();
    for (let i = 0; i < n; i++) {
      this.byte();
      this.skipTyped(this.byte());
    }
  }
}

export class Writer {
  constructor(size = 256) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
    this.pos = 0;
  }
  grow(n) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  byte(n) {
    this.grow(1);
    this.buf[this.pos++] = n & 0xff;
    return this;
  }
  bytes(b) {
    this.grow(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
    return this;
  }
  short(n) {
    this.grow(2);
    this.view.setInt16(this.pos, n, true);
    this.pos += 2;
    return this;
  }
  ushort(n) {
    this.grow(2);
    this.view.setUint16(this.pos, n, true);
    this.pos += 2;
    return this;
  }
  float(n) {
    this.grow(4);
    this.view.setFloat32(this.pos, n, true);
    this.pos += 4;
    return this;
  }
  double(n) {
    this.grow(8);
    this.view.setFloat64(this.pos, n, true);
    this.pos += 8;
    return this;
  }
  varuint(n) {
    n >>>= 0;
    while (n >= 0x80) {
      this.byte((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    return this.byte(n);
  }
  varuint64(n) {
    n = BigInt.asUintN(64, n);
    while (n >= 0x80n) {
      this.byte(Number(n & 0x7fn) | 0x80);
      n >>= 7n;
    }
    return this.byte(Number(n));
  }
  varint(n) {
    return this.varuint(((n << 1) ^ (n >> 31)) >>> 0);
  }
  varint64(n) {
    n = BigInt.asIntN(64, BigInt(n));
    return this.varuint64((n << 1n) ^ (n >> 63n));
  }
  string(s) {
    const b = utf8enc.encode(s);
    this.varuint(b.length);
    return this.bytes(b);
  }

  int(n) {
    if (n === 0) return this.byte(T.IntZero);
    if (n > 0 && n <= 0xff) return this.byte(T.Int1).byte(n);
    if (n > 0 && n <= 0xffff) return this.byte(T.Int2).ushort(n);
    if (n < 0 && n >= -0xff) return this.byte(T.Int1_).byte(-n);
    if (n < 0 && n >= -0xffff) return this.byte(T.Int2_).ushort(-n);
    return this.byte(T.CompressedInt).varint(n);
  }

  long(n) {
    n = BigInt(n);
    if (n === 0n) return this.byte(T.LongZero);
    if (n > 0n && n <= 0xffn) return this.byte(T.L1).byte(Number(n));
    if (n > 0n && n <= 0xffffn) return this.byte(T.L2).ushort(Number(n));
    if (n < 0n && n >= -0xffn) return this.byte(T.L1_).byte(Number(-n));
    if (n < 0n && n >= -0xffffn) return this.byte(T.L2_).ushort(Number(-n));
    return this.byte(T.CompressedLong).varint64(n);
  }

  // One value with its type byte.
  value(v) {
    if (v === null || v === undefined) return this.byte(T.Null);
    if (v instanceof Raw) return this.bytes(v.bytes);
    if (typeof v === "boolean") return this.byte(v ? T.BooleanTrue : T.BooleanFalse);
    if (typeof v === "number") {
      if (!Number.isInteger(v) || v > 0x7fffffff || v < -0x80000000) throw new TypeError(`photon: ${v} is not an int`);
      return this.int(v);
    }
    if (typeof v === "string") return this.byte(T.String).string(v);
    if (v instanceof Typed) {
      switch (v.type) {
        case "byte":
          return v.v === 0 ? this.byte(T.ByteZero) : this.byte(T.Byte).byte(v.v);
        case "short":
          return v.v === 0 ? this.byte(T.ShortZero) : this.byte(T.Short).short(v.v);
        case "long":
          return this.long(v.v);
        case "float":
          return v.v === 0 && !Object.is(v.v, -0) ? this.byte(T.FloatZero) : this.byte(T.Float).float(v.v);
        case "double":
          return v.v === 0 && !Object.is(v.v, -0) ? this.byte(T.DoubleZero) : this.byte(T.Double).double(v.v);
      }
    }
    if (v instanceof Hashtable) {
      this.byte(T.Hashtable).varuint(v.size);
      for (const [k, val] of v) this.value(k).value(val);
      return this;
    }
    if (v instanceof Uint8Array) return this.byte(T.ByteArray).varuint(v.length).bytes(v);
    if (v instanceof Int32Array) {
      this.byte(T.CompressedIntArray).varuint(v.length);
      for (const n of v) this.varint(n);
      return this;
    }
    if (v instanceof BoolArray) {
      this.byte(T.BooleanArray).varuint(v.length);
      for (let i = 0; i < v.length; i += 8) {
        let b = 0;
        for (let j = 0; j < 8 && i + j < v.length; j++) if (v[i + j]) b |= 1 << j;
        this.byte(b);
      }
      return this;
    }
    if (v instanceof StringArray) {
      this.byte(T.StringArray).varuint(v.length);
      for (const s of v) this.string(s);
      return this;
    }
    if (Array.isArray(v)) {
      this.byte(T.ObjectArray).varuint(v.length);
      for (const item of v) this.value(item);
      return this;
    }
    throw new TypeError(`photon: cannot encode ${Object.prototype.toString.call(v)}`);
  }

  // Parameter table from a Map<byte, value>. Values that are Uint8Array in
  // `raw` (already encoded, type byte included) are copied as they are.
  params(map = new Map(), raw = null) {
    this.byte(map.size + (raw ? raw.size : 0));
    for (const [k, v] of map) this.byte(k).value(v);
    if (raw) for (const [k, bytes] of raw) this.byte(k).bytes(bytes);
    return this;
  }

  finish() {
    return this.buf.slice(0, this.pos);
  }
}
