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
followed by its value; a raw 1 ends the list. Field indexes 1 to 87, by component:

| component | fields |
| --------- | ------ |
| 0 | 1, 2, 3 |
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

Field meanings found so far ("svarint/4": zigzag varint, divided by 4 by the client;
values are interpolated over ~120 ms when they change):

| field | component | type | meaning |
| ----- | --------- | ---- | ------- |
| 1, 2 | 0 transform | svarint/4 | x, y (relative to the parent, see component 5) |
| 3 | 0 transform | u16 | angle, 2π/65536 per unit |
| 4, 5, 6 | 1 health | f32 | 5 is health; the client counts the player alive while it is above 0 |
| 7 | 2 | u8 | unknown; component 2 also holds the tick the client last saw the entity |
| 8 | 3 | f32 | radius |
| 12 | 4 game | f32 | arena diameter (the arena is a circle) |
| 13, 15 | 4 game | f32 | arena centre x, y |
| 17 | 4 game | varint | state flags: 2 running; else 8 with 10 clear shows a countdown from field 21 (ms); else "Waiting for players" |
| 21 | 4 game | f32 | countdown, ms |
| 25 | 4 game | f32 | arena scale (1) |
| 29, 30 | 5 | entity id | the parent (positions are relative to it, rotated by its angle) |
| 31 | 6 terrain chunk | sparse bytes | `[varint (index delta) ^ 1][u8]` pairs, then 1, index from 0. Bytes 0-511: the dug layer (bit set = dug); bytes 3060-3571: the reveal layer (bit set = this player can see the tile). Byte i holds tiles x = (i % 8) * 8 + bit, y = i / 8 |
| 32, 33 | 6 terrain chunk | varint | chunk x, y (unsigned: keep the map at positive coordinates) |
| 34 | 7 name | string | the digger's name |
| 37, 47 | 8 view | svarint/4 | camera x, y |
| 53 | 8 view | entity id | the entity the client plays as |
| 69 | 10 digger | f64 | score |

Components 4 and 12 belong to the world, not to the entity (one of each).

Tiles are 16 world units, chunks 64 x 64 tiles; a tile's material comes from
`terrain.js` (the client works it out itself from component 4 fields 27, the
seed, and 11, the map flags). Materials: 1 amethyst (vision), 2 gold, 3 dirt,
5 bedrock (cannot be dug), 6 uranium (mass boost), 7 lava, 8 unknown (teal),
9 quartz (shield), going by the client's colours and changelog.

A digger is an entity with components 0, 1, 2, 3, 7 and 10. The client draws
another player's digger only while some tile under it (radius + 16) is set in a
chunk's reveal layer; that is how the server decides what each player sees.
Undug tiles outside the reveal layer show as dark grey.

## Getting into the game

The world id (the varint after the type byte of a snapshot) must stay the same:
a larger one makes the client throw its whole state away. The client's hello
(messages 10, 13, 20) needs an ack in the snapshots, and Play sends message 16
with the nickname. The client then waits on "Connecting" until:

- an entity has component 8 (the first one created is the client's own view), and
- its field 53 (an entity id) names an entity with component 10, and
- that entity's component 1 field 5 (health, f32) is above 0.

Component 4 field 17 must have bit 2 set, or the client shows "Waiting for
players". Component 8 fields 37 and 47 move the camera.

Entity components set bits in the entity: +57 bit 1 is component 0, 2 is 1, 4 is 2,
8 is 3, 16 is 4, 64 is 6, 128 is 7; +58 bit 1 is component 8, 2 is 9, 4 is 10, 8 is 11.

## Tools

`tools/digdig/` holds what found all this: `harness.mjs` runs the real client in
headless Chromium against a local handler (nothing reaches M28), with wasm
breakpoints and patched-client probes (`patch.py`); `dec.py` turns the client's
disassembly into pseudocode. The client files themselves are not committed; put
them in `captures/digdig/client/` (git-ignored).
