# digdig.io

Work in progress: a server of our own for the digdig.io client, so it can be
played on 55GMS without M28's servers. This file records what is known about
the protocol. It was worked out against client build
`2749f7bafff1e95846c87486cda9d7184c0a06bf` (`static.digdig.io/<hash>/client.{js,wasm}`).
A new build may change any of the constants below.

## Finding the server

The client asks `https://api.n.m28.io/endpoint/digdig-ffa/findEach/` (also
`-teams`, `-tag`, `-br`, `-maze`) for `{"servers":{"<region>":{"id","ipv4","ipv6"}}}`
and opens `wss://<id>.s.m28n.net/`.

## Packets

Every WebSocket message is `[type][body]`, scrambled by `cipher.js` in both
directions (`ClientCipher.open` for what the client sends, `ServerCipher.seal`
for what we send). Each side keeps a 32-bit state that steps on every scrambled
packet; both start from fixed values.

Client to server:

| type | body |
| ---- | ---- |
| 48 | hello, sent raw: `version hash\0`, `\0`, `version hash\0` |
| 1 | `[0][varint ack][stream]`, everything after the first byte XORed with the 256-byte table at client memory 49632 (`STREAM_MASK`) |
| 2 | `[varint X][varint ?]`: acknowledges our type-1 packet X |

Server to client:

| type | body |
| ---- | ---- |
| 0 | disconnect, raw: `[varint reason]` (1 kicked, 2 banned, 3 idle, 4 too many connections, 5 shutting down, 6 protocol error, 7 invalid token, 8 server full, 9 outdated (the client reloads), 10 server error) |
| 1 | snapshot: `[varint X][snapshot]`, X counts up, the client echoes it in a type 2 |
| 2 | compressed: `[u32 size][LZ4 block]`, the block is a whole packet `[type][body]` |
| 5 | a string |

Answering anything with type 2 breaks the stream: it is a compressed packet.

## Client stream

After `[0][varint ack]`, messages follow until the end: `[varint seq][varint id][payload]`.
seq counts 1, 2, 3... for reliable messages. Seen so far:

| id | payload |
| -- | ------- |
| 10 | empty, first message |
| 13 | `[u8 1][user agent\0][\0][language\0]` |
| 20 | `[00 00]` |
| 16 | nickname `string\0` (sent as it is typed) |

## Snapshot

`[varint tick][varint ack of the client's messages][varint A][varint deleteCount][2 bytes][deleteCount x u32 id][2 bytes]`
then entities, then (not worked out yet) the reliable messages for the client.

An entity is `[u32 id]` (0 ends the list) then `[flags ^ 18]`:

- flags & 128: no fields follow
- flags & 32: no component list; otherwise the components it has:
  - flags & 64: `u16` bitmask (low 14 bits), else a delta list like the fields below
- flags & 2: sets a mark on the entity (unknown)

Fields: a running index starting at 0; each field is `varint((index - previous) ^ 1)`
followed by its value; a raw 1 ends the list. Field indexes 2 to 87, by component:

| component | fields |
| --------- | ------ |
| 0 | 2, 3 (2 is a signed varint / 4, interpolated: a position) |
| 1 | 4, 5, 6 (f32) |
| 2 | 7 |
| 3 | 8 |
| 4 | 9 to 28 |
| 5 | 29, 30 |
| 6 | 31 to 33 |
| 7 | 34 |
| 8 | 35 to 55 |
| 9 | 56 to 63 |
| 10 | 64 to 70 |
| 11 | 71, 72 |
| 12 | 73 to 87 |

## Getting into the game

The world id (the varint after the type byte of a snapshot) must stay the same:
a larger one makes the client throw its whole state away. The client's hello
(messages 10, 13, 20) needs an ack in the snapshots, and Play sends message 16
with the nickname. The client then waits on "Connecting" until:

- an entity has component 8 (the first one created is the client's own view), and
- its field 53 (an entity id) names an entity with component 10, and
- that entity's component 1 field 5 (health, f32) is above 0.

Entity components set bits in the entity: +57 bit 1 is component 0, 2 is 1, 4 is 2,
8 is 3, 16 is 4, 64 is 6, 128 is 7; +58 bit 1 is component 8, 2 is 9, 4 is 10, 8 is 11.

## Tools

`tools/digdig/` holds what found all this: `harness.mjs` runs the real client in
headless Chromium against a local handler (nothing reaches M28), with wasm
breakpoints and patched-client probes (`patch.py`); `dec.py` turns the client's
disassembly into pseudocode. The client files themselves are not committed; put
them in `captures/digdig/client/` (git-ignored).
