# digdig.io

Work in progress: a server of our own for the digdig.io client, so it can be
played on 55GMS without M28's servers. This file records what is known about
the protocol. It was worked out against client build
`2749f7bafff1e95846c87486cda9d7184c0a06bf` (`static.digdig.io/<hash>/client.{js,wasm}`).
A new build may change any of the constants below.

## Modes

The mode buttons ask `api.n.m28.io/endpoint/digdig-<mode>/findEach/` with mode
`ffa`, `teams`, `tag`, `br` or `maze`. The 55GMS page sends that on as
`/api/mp/digdig/servers?mode=<mode>`, the answer's server id is the mode, and the
client then opens `wss://<mode>.s.m28n.net/`, which the page sends to
`/api/mp/digdig/play?mode=<mode>`. Each mode gets its own lobbies (`modes.js`).

Done: FFA; Battle Royale (rounds, countdown, shrinking arena, winner); TDM
(three teams in M28's colours, component 10 field 66, no damage between
teammates); Tag (5-minute rounds, seekers red, a tag turns a hider into a seeker;
the role entity below); Maze (map flag 16, `maze.js`); squads (below).

Tag's "You are a seeker/hider" banner needs byte 10 of the game object at 331776
set, and no server message sets it that we know of; the 55GMS page sets it in
memory during Tag games.

## Accounts, gold and the shop

55GMS accounts stand in for M28's (`accounts.js`). The 55GMS page saves a
digdig game token as the client's own login (localStorage
`oauth2_data_DO_NOT_SHARE`: base64 of id, provider, token, display name, each
NUL-ended, an f64 expiry in ms, and an avatar string). With provider `discord`
the client counts itself signed in, shows the display name, and sends message
28 on connect; its third string is the token, which 55GMS checks
(`/api/digdig/internal/verify`). Server message 6 signs the client out.

The shop is the client's (`skins.js` has its table): prices are shown by the
client but charged by 55GMS (`/api/digdig/internal/buy`). Gold a life collects,
plus 10% of the gold of diggers it destroyed (the client's changelog), is
granted when the life ends (`/api/digdig/internal/gold`, once per digger).

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
| 5 | reliable messages: `[varint world id]`, then masked like the client's stream (STREAM_MASK from the byte after the world id) `[varint seq][varint id][payload]` repeated; the client runs a message whose seq is above the last it ran, or 0 |

Server messages (type 5), handled by client f1392:

| id | payload |
| -- | ------- |
| 6 | empty: sign out (the client forgets its saved login) |
| 12 | five strings and an f64 (`s s s f64 s s`): a new saved login, stored as id, provider, token, display name, expiry, avatar |
| 18 | `[varint request][string]`: why a squad request failed, shown in the Squad panel |
| 19 | string: stored as localStorage `cp6_player_id` |
| 22 | varint: an achievement's "+N gold" popup |
| 25 | `[u32 entity][u8 strength]`: the entity was hurt; it flashes red (strength 255 strongest), and when it is the player's own digger the screen shakes |
| 26 | empty: squads work here (the Squad panel waits for it) |
| 27 | `[varint request][string]`: why joining a squad failed, e.g. "Squad doesn't exist" |

Answering anything with type 2 breaks the stream: it is a compressed packet.

## Client stream

After `[0][varint ack]`, messages follow until the end: `[varint seq][varint id][payload]`.
seq counts 1, 2, 3... for reliable messages. Seen so far:

Messages count seq numbers even when sent unreliably (seq 0), so reliable
seqs have gaps. Every message must be parsed to find the next; the payloads:

| id | payload |
| -- | ------- |
| 1 | empty: Play (spawn with the last nickname) |
| 2 | shop Buy: the skin id `string\0` (digdig.io has no chat) |
| 7 | `[varint request]`: a squad (opening the Squad panel, Find Public) |
| 9 | `[varint request]`: a new squad (New) |
| 17 | `[u8]`: the Squad panel's Public box |
| 32 | `[varint request][string code]`: join a squad |
| 3, 24, 34 | empty, meaning unknown |
| 4 | empty: the client gives up its dead digger (Continue) |
| 14 | `string\0`, unknown |
| 15 | four `string\0`: a report |
| 21 | one byte, unknown |
| 28 | three `string\0` and an f64: account login data |
| 10 | empty, first message |
| 13 | `[u8 1][user agent\0][\0][language\0]` |
| 20 | equipped skins `[u8 face][u8 spinner]`, indexes in `skins.js`, 0 none |
| 28 | the saved login: provider, token and id strings in some order (`[id][provider][token]` as sent), then the f64 expiry; the first message on connect |
| 29 | empty, after a message 12 |
| 16 | nickname `string\0`, before Play and again as it settles |
| 5 | input, unreliable: `[varint flags][f32 angle][f32 distance]`; flags 65536, +1 left button; angle in radians, distance in world units from the digger |
| 23 | empty, every few seconds |

## Snapshot

`[varint tick][varint ack of the client's messages][varint A][varint deleteCount][2 bytes][deleteCount x u32 id][2 bytes]`
then entities, then (not worked out yet) the reliable messages for the client.

An entity is `[u32 id]` (0 ends the list) then `[flags ^ 18]`:

- flags & 128: no fields follow
- flags & 32: no component list; otherwise the components it has:
  - flags & 64: `u16` bitmask (low 14 bits), else a delta list like the fields below
- flags & 2: sets a mark on the entity (unknown)

Sparse arrays (fields 18, 20, 22, 28, 31, 43...) are `[varint (index + 1 - previous) ^ 1][value]`
entries with indexes counting from 0, ended by a raw 1.

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
| 9 | 4 game | u8 | leaderboard rows |
| 12 | 4 game | f32 | arena diameter (the arena is a circle) |
| 13, 15 | 4 game | f32 | arena centre x, y |
| 16 | 4 game | varint | digger count ("N Diggers") |
| 18 | 4 game | sparse rgb | leaderboard bar colours, 3 bytes per row |
| 20 | 4 game | sparse strings | leaderboard names |
| 22 | 4 game | sparse entity ids | leaderboard diggers |
| 28 | 4 game | sparse varints | leaderboard scores |
| 17 | 4 game | varint | state flags: 2 running; else 8 with 10 clear shows a countdown from field 21 (ms); else "Waiting for players" |
| 21 | 4 game | f32 | countdown, ms |
| 25 | 4 game | f32 | arena scale (1) |
| 27 | 4 game | varint | map seed |
| 11 | 4 game | u8 | map flags (`terrain.js`) |
| 29, 30 | 5 | entity id | the parent (positions are relative to it, rotated by its angle) |
| 31 | 6 terrain chunk | sparse bytes | `[varint (index delta) ^ 1][u8]` pairs, then 1, index from 0. Bytes 0-511: the dug layer (bit set = dug); bytes 3060-3571: the reveal layer (bit set = this player can see the tile). Byte i holds tiles x = (i % 8) * 8 + bit, y = i / 8 |
| 32, 33 | 6 terrain chunk | varint | chunk x, y (unsigned: keep the map at positive coordinates) |
| 34 | 7 name | string | the digger's name |
| 37, 47 | 8 view | svarint/4 | camera x, y |
| 53 | 8 view | entity id | the entity the client plays as |
| 69 | 10 digger | f64 | score |
| 24 | 4 game | varint | diggers needed, shown as "Waiting for players (field 16/field 24)" |
| 35 | 8 view | u8 | bit 8: "YOU HAVE WON" (set at spawn, it keeps the client in the menu) |
| 38 | 8 view | varint | death screen: diggers destroyed |
| 41 | 8 view | f32 | death screen: gold collected (shown when above 0) |
| 49, 52 | 8 view | f64 | spawn and death time, ms; the death screen shows Time Alive = 52 - 49 |
| 55 | 8 view | f32 | death screen: Max Points |
| 19 | 4 game | f32 | Tag: ms into the round, shown counting down from 300000 (an f64 here freezes the client) |
| 62, 63 | 9 | rgb, bit | unknown; a colour and a flag (did not change how a digger is drawn) |
| 66 | 10 digger | rgb | body colour (team colour); tunnels it digs take it too |
| 68 | 10 digger | sparse u8 | skins worn: [face, spinner] |
| 35 | 8 view | u8 | bit 2: account loaded (the shop shows field 51) |
| 44 | 8 view | list | skins owned: `[varint count]`, then (if any) a sparse list of strings |
| 51 | 8 view | f64 | the account's gold |
| 71 | 11 | u8 | Tag: 0 "You are a seeker", else "You are a hider", shown 10 s when it changes; the client reads the first component 11 entity, so it is an entity of its own (not the view, which breaks the menu) |

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

## Squads

`squads.js`; up to four players, in FFA, TDM and Maze (the modes the client's
server list gives `"squads": "4"`). Client messages: 7 `[varint request]` (a
squad: sent when the Squad panel opens without one, and by Find Public), 9
`[varint request]` (New), 32 `[varint request][code]` (Join; the code without
its server part, lowercased), 17 `[u8]` (the Public box). Server message 26
(empty) must come first: without it the panel never shows a squad.

The squad is an entity with component 9: four slots each of status (56: 0
empty, 1 in the menu, 2 playing), face (59), name (60) and digger (61, an
entity id); 57 the code, 63 public, 58 a list of u32 we leave out, 62 a colour.
A request has worked once 57 changes (Join: once it is the code typed), and
the panel then shows the slots and "Code: <server id>-<57>". Server messages
18 and 27 `[varint request][text]` answer a failed request (create, join) with
a text the panel shows instead, such as "Squad doesn't exist".

Join compares the code's server part with the server the client is on, which
it keeps as a string in its world object (offset 24 of the object at 331776 +
544) that nothing the server sends fills; the 55GMS page writes it (our server
ids are the modes). A code of another mode makes the client look its server up
(`api.n.m28.io/server/<id>`, answered by `/api/mp/digdig/server?id=`) and
reconnect before it joins. Members share a lobby, cannot hurt each other, see
around each other, are always in each other's snapshots (the in-game squad
list shows their health), and play on one team in TDM.

## Maze

Map flag 16: the client carves a 1080 x 1080 grid (one cell per 8 x 8 tiles)
from the seed with 150 shrinking worms (f1008) and draws bedrock outside it.
`maze.js` matches it bit for bit; `tools/digdig/maze-oracle.py` cuts the
client's generator out to check a new build against.

## Tools

`tools/digdig/` holds what found all this: `harness.mjs` runs the real client in
headless Chromium against a local handler (nothing reaches M28), with wasm
breakpoints and patched-client probes (`patch.py`); `dec.py` turns the client's
disassembly into pseudocode. The client files themselves are not committed; put
them in `captures/digdig/client/` (git-ignored).
