# 55GMS multiplayer

One server for the multiplayer games on [55GMS](https://github.com/55gms/55GMS). Each game has its own endpoints under `/api/mp/<game>/`, speaking the protocol that game's client already expects, so the game files stay as they are. Players on 55GMS play each other, except in Ducklings.io, where the server only relays the game to its own, still running, server.

| Game                                 | Endpoints                                                                                 | Protocol                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1v1.lol                              | `/api/mp/1v1/ns` (name server), `/api/mp/1v1/master`, `/api/mp/1v1/game`                  | Photon PUN 2 (binary protocol 1.8 over WebSocket)                                 |
| BasketBros, SoccerBros, BaseballBros, WrestleBros | `/api/mp/<game>/play`, `/api/mp/<game>/ping` (`basketbros`, `soccerbros`, `baseballbros`, `wrestlebros`) | Blue Wizard's lockstep server (little-endian ints over WebSocket), one against one |
| FootballBros, HockeyBros             | `/api/mp/<game>/play`, `/api/mp/<game>/ping` (`footballbros`, `hockeybros`)              | The same server with a lobby of up to three a side                                 |
| FightBros                            | `/api/mp/fightbros/play`, `/api/mp/fightbros/ping`                                        | The same lobby, up to four fighters, no teams                                      |
| Ducklings.io                         | `/api/mp/ducklings/play`                                                                  | Passed through unchanged to `wss://multiplayer.ducklings.io/ws`                   |
| digdig.io                            | `/api/mp/digdig/play`, `/api/mp/digdig/servers`                                           | M28's own protocol (`games/digdig/README.md`); the game runs here, with bots       |
| Smash Karts                          | `/api/mp/smashkarts/ns`, `/master`, `/game`, `/remote/<ticket>`                           | Photon PUN 2 (binary protocol 1.8 over WebSocket); PLAY goes on to the official Photon cloud |
| Kart Bros                            | `/api/mp/kartbros/play`, `/api/mp/kartbros/ping`                                          | Blue Wizard's session server (MemoryPack frames over WebSocket): lobbies, host, relay |

`GET /api/mp/health` reports the games and open connections. Every minute the server logs one `stats` line (connections, rooms, players, bytes).

```bash
npm ci
node .                # PORT (default 8093), HOST (default 0.0.0.0)
MP_DEBUG=1 node .     # also log every operation with its parameters
```

55GMS accounts need `MP_SHARED_SECRET`, the same long random string as in 55GMS's `.env`, and reach 55GMS at `GMS_INTERNAL_URL` (default `http://127.0.0.1:8080`). Without the secret everyone is a guest and no results are kept.

## Layout

- `src/server.js` routes `/api/mp/<game>/<rest>` (HTTP and websocket upgrades) to `games/<game>/index.js`
- `src/limits.js` caps: 64 KiB per message, 120 messages/s per connection, 64 connections per IP, 60 s idle, 16 players per room
- `src/photon/` the Photon layer any Photon game can reuse: `protocol18.js` (value codec), `codes.js` (operation, parameter and event codes), `peer.js` (framing, ping, limits)
- `games/bros/` the seven Blue Wizard lockstep games: `wire.js` (message bytes), `clock.js` (the shared 60 Hz tick), `duel.js` (one against one), `lobby.js` (FootballBros, HockeyBros, FightBros), `index.js` (sockets, limits, the region ping)
- `games/ducklings/` a pass-through relay to Ducklings.io's own server
- `games/digdig/` digdig.io: the packet cipher (`cipher.js`), the client's stream and snapshots (`stream.js`, `snapshot.js`), the map (`terrain.js`, the same as the client's), the game (`world.js`), what each player is shown (`connection.js`), bots (`bots.js`) and lobbies (`index.js`). `DIGDIG_ARENA_TILES` sets the arena radius (200 tiles), `DIGDIG_DEBUG=1` logs every client message. `tools/digdig/` holds the tools that worked the protocol out
- `games/smashkarts/` the three Photon roles for Smash Karts (copies of 1v1's `rooms.js`, `game.js` and `presence.js`, without the referee and ranked code), and `remote.js`, the relay to the official Photon cloud
- `games/kartbros/` Kart Bros's session server: `wire.js` (frames, MemoryPack, the message ids and fields) and `index.js` (sessions, members, host, relay)
- `games/1v1/` the three Photon roles over one in-memory room registry (`rooms.js`), 55GMS accounts (`accounts.js`) and the match referee (`referee.js`)

## 1v1.lol

The build 55GMS hosts (1v1.LOL 3.800, Unity 2019.4, PUN 2.18.1) asked Photon's name server for AppId `82620531-…` and got `ApplicationArchived`: its Photon app is shut down, so it could not connect anywhere. The game page in 55GMS (`static/misc/nowgg/index.html`) wraps `WebSocket` so `*.exitgames.com` becomes `/api/mp/1v1/ns` on the page's own host. For local work, set `localStorage["gms-mp-base"] = "ws://localhost:8093/api/mp"` on the 55GMS page.

What the game does, and what the server answers:

- Name server: `GetRegions` gets one region whose address is our master; the HTTP region pings (`https://<host>/photon/m/?ping`) fail and the client carries on. `Authenticate` accepts anything and returns a token; the token maps back to the user id on the master and game servers.
- Master: PLAY sends `JoinRandomGame` in the SQL lobby `1v1Lobby` with `C0 = '<mode>'` and `MaxPlayers` 2 (or the mode's size). No match → `CreateGame`; the new room takes the searched properties and lobby at once, so players pressing PLAY together land in the same room. A search that fails while someone is creating the same room waits up to 1.5 s for it, and a player who reaches the room before its creator waits up to 5 s.
- Game server: rooms, actors, room and player properties (CAS, `BroadcastPropsChangeToAll`), `RaiseEvent` relay with receivers, targets, interest groups and the room event cache (PUN instantiation and buffered RPCs), master client handover on leave. A room is removed when its last player leaves.
- Signed-in players: the 55GMS page adds the account's game token as `?gms=`; `Authenticate` asks 55GMS whose it is (`games/1v1/accounts.js`) and gives the player the user id `gms:<uuid>` and their handle as name. Nobody else can take a `gms:` user id. Without the token, or with 55GMS unreachable, the player is a guest.
- Nobody here: a casual search that finds no room here goes at once to another public 1v1.lol server's queue, by default 1v1.lol Reloaded's (`MP_1V1_REMOTE_URL`, default `wss://ws.onecloudcdn.site/ns`; `off` turns it off), in region `us` (`MP_1V1_REMOTE_REGION`). Answering at once keeps the game's own waiting room ("1/2") and its Cancel button. The player's master connection then passes through to that server's master, and the game server address it answers with becomes `/api/mp/1v1/remote?ticket=…`, which relays the game connection frame for frame (`games/1v1/remote.js`): the first `Authenticate` carries that server's token, the player is named `55gms.com` there (`MP_1V1_REMOTE_NAME`), and every other player in the room gets a random name from `games/1v1/opponent-names.txt` on the player's screen (the same one for the whole match), while the player keeps their own name. Only addresses on that server's own host are dialled. If it cannot be reached the player waits in a room here as before. Casual `1v1` matches there are refereed from the relayed messages (`games/1v1/remote-referee.js`, the same rules as `referee.js`, the player's own events read on the way out and everyone else's on the way in), so a signed-in player still gets XP, stats and battle pass progress; they are never rated, and ranked never leaves this server.
- Parties: the leader's search carries the party's user ids (`ExpectedUsers`). It stays on this server, joins only a room with space for the whole party, and keeps the members' places for 30 s while they follow the leader (`FindFriends`, then `JoinGame` by name).
- Ranked (`…_Competitive` modes): accounts only, one ranked room each. A ranked search joins the waiting ranked room closest to its 55GMS rating; the game's own `C1`/`C2` range filter is ignored (it overflows, never widens, and a waiting player never searches again). Two ranked players searching together wait up to 12 s for each other's room.
- Results: `games/1v1/referee.js` reads each `1v1` and `1v1_Competitive` match from the relayed messages and posts the result to 55GMS, which keeps ratings, XP, stats and the battle pass. See `docs/1v1-match-events.md` for what it reads and why it can be trusted. Results wait in memory and are retried while 55GMS is unreachable; 55GMS applies each match id once.
- Not supported: friends (Photon Chat). Accounts, the shop and LOL Pass are 55GMS's (`docs/1v1-backend.md` there).

`tools/capture.mjs` opens the game in headless Chromium and logs every Photon message, which is how the above was worked out: `CHROME_PATH=… node tools/capture.mjs http://localhost:8080/misc/nowgg/ --pages 2 --mp ws://localhost:8093/api/mp --click 1075,620@60 --size 640x360`. Software rendering is slow; two players on a small VM take long enough loading a map that the game may give up.

## BasketBros, SoccerBros, BaseballBros, FootballBros, HockeyBros, WrestleBros, FightBros

Blue Wizard's games are Haxe builds that find their server from the page's own hostname: `https://<region>.<hostname>/ping` to list regions and `wss://<region>.<hostname>/<n>` to play. On 55GMS those hosts do not exist, and the originals (`*.basketbros.io`, one set of servers for all five games) are what school filters block. A script on each game page in 55GMS (`static/assets/js/bros-mp.js`) sends both to `/api/mp/<game>/ping` and `/api/mp/<game>/play` on the page's own host. Only the `EA` region answers its ping, so the game shows one server; the region in a private code is ignored.

The protocol was read from the game bundles and checked byte for byte against the original servers. Every message is one binary frame: an int32 type, then little-endian int32s, bytes and strings. The server simulates nothing. Once a match starts it sends every player the same tick 60 times a second (each game steps once per tick, so this is the game's speed) carrying every player's latest buttons. Names and chat are cleaned to printable ASCII.

Client to server, all five games:

| Type                    | Body                                                                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 join                  | skin (team index in BaseballBros, FootballBros and HockeyBros), wins, losses, perk count, perks (bytes), 6 outfit bytes, 4 guid ints, private game number (0 = public), raw name to the end (FootballBros and HockeyBros add an int 2 after it) |
| 0 input                 | BasketBros/SoccerBros/BaseballBros: 4 ints, the low byte of each relayed. FootballBros/HockeyBros: 5 ints (left, right, up, punch, down)                                                                                       |
| 6 chat                  | length, text                                                                                                                                                                                                          |
| 5 score                 | mine, theirs (classic games, after each goal; ignored)                                                                                                                                                                |
| 2 side, 8 team, 7 start | FootballBros and HockeyBros lobby: move side (3 a side at most), pick the side's team, host starts                                                                                                                    |

Server to client, BasketBros, SoccerBros, BaseballBros (`duel.js`): nothing until a second player with the same private game number (or public) arrives, then both get a `1` for each player (side 0 left / 1 right, skin, wins, losses, perks, outfit, isYou, length-prefixed upper-cased name) and the ticks start: `0, frame, left 4 bytes, right 4 bytes`. Chat comes back to both as `6, side, "NAME : text"`. When one leaves the other keeps getting ticks, as on the originals.

Server to client, FootballBros and HockeyBros (`lobby.js`): the joiner gets its own `1` (client id, team, wins, losses, perks, outfit, isYou, side, name), every other player's `1`, and each side's team as `8, -1000 - side, team`; the others get the joiner's `1`; the host gets `9`. Side and team changes go to the others as `2, id, side` and `8, id, team`, a player leaving as `3, id` (a new host gets `9`). The host's `7` sends `7` to all, every player's `1` again, then ticks: `0, frame, count, then per player id and 5 input bytes`.

HockeyBros (`/api/mp/hockeybros/`) speaks exactly FootballBros's lobby protocol, read from its bundle (`MultiplayerLobby` and `MainGame.ReceiveMessage` in `HockeyBros.js`): the same join with the trailing int 2, the same lobby messages, three a side at most, and the same ticks (it reads the tick's first int as its random seed, which every player gets the same). Its title screen pings the same regions, and its old one-against-one `StartOnlineGame` path is never called, so every online game goes through the lobby.

WrestleBros (`/api/mp/wrestlebros/`) is a classic one against one game: the same join, `duel.js`'s two `1`s and its ticks (`WrestleBros.js`, `NetworkCore` and `MainGame.ReceiveMessage`). Its input packs the buttons into the low bytes itself (left, right, jump, punch, down in the first, the six taunts in the second), which the duel relays as it does every game's.

FightBros (`/api/mp/fightbros/`) speaks FootballBros's lobby protocol (`FightBros.js`, `OnlineLobby` and `MainGame.ReceiveMessage`) with four differences, set by `lobbyGame({ maxPlayers: 4, teams: false })`: a lobby holds four (the game only fights its first four by client id and sends any others home on start); each player's `1` carries that player's own skin where FootballBros has the side's team; sides and teams mean nothing to it (it reads and drops `2` and `8`); and its fighters, outfits and stage travel as chat lines (`#KBPICK#id,skin,5 colours,0,seq`, `#KBSTAGE#n`) that every player reads from the `NAME : text` the server sends back. Its client also sends `#KBPING#` as chat every 5 s when it has sent nothing else; the server drops that line. Input is 5 ints (left, right, jump, punch | kick << 1, down), the tick is FootballBros's, and its first int is the match's random seed.

`node` with two `ws` clients is enough to try it: connect to `ws://localhost:8093/api/mp/soccerbros/play` twice, send each a join, and both start getting ticks.

## Ducklings.io

Ducklings.io's server still runs, but the game can no longer reach it from 55GMS: the address in the game, `wss://ducklings.io/ws`, now redirects to `wss://multiplayer.ducklings.io/ws` (browsers do not follow redirects for WebSockets), that server answers 401 to any `Origin` but `https://ducklings.io`, and filters block the domain. An inline script in the game's page on 55GMS (`static/misc/ducklings-io/index.html`) sends any `ducklings.io` WebSocket to `/api/mp/ducklings/play`. For each connection there, `games/ducklings/index.js` opens one to the real server with `Origin: https://ducklings.io` and passes frames both ways unchanged; when either side closes, so does the other. Frames the game sends before the real server answers wait (64 at most).

The server only does matchmaking and WebRTC signalling (JSON text frames such as `ping`, rooms, offers, ICE candidates, `turnCredentials`). A match itself runs between the players' browsers over WebRTC data channels, directly or through the game's TURN server, so it never passes through here; on a network that blocks that, players find a room and then fail to connect to each other. Every player reaches the real server from this box's address.

## Smash Karts

Tall Team's Unity WebGL game plays on Photon PUN 2 (app `32cef7fc-…`, name server `wss://ns.photonengine.io:19093`). The page in 55GMS (`static/misc/smashkarts/index.html`) wraps `WebSocket` so that name-server address becomes `/api/mp/smashkarts/ns` on the page's own host; our name server then hands out our own master and game servers. For local work set `localStorage["gms-mp-base"] = "ws://localhost:8093/api/mp"` on the 55GMS page.

What the game does:

- Login: custom authentication. The game sends its Firebase ID token to the name server (parameter 214, a Photon-encoded dictionary) with the Firebase uid as the user id (225), and Photon's cloud checks the token with a webhook. Here any login is accepted and the player is `fb:<uid>`, taken as given (it only names a seat in a room). Every login is remembered for 30 minutes (`remote.js`) so the player can be passed on to the cloud.
- PLAY: one `JoinRandomGame` on the master that is also "or create": `GameProperties` (248) are the properties to match (`gm` mode, `wm` weapons, `gv` version, `mm`, `gl` arena, max players), `Properties` (251) and the other room options are what to create with, and the room name (255) is the name to give it. The master answers with a room name and a game server address, never "no match found". The player then joins it on the game server with `JoinGame` and create-if-not-exists.
- Create / Join (private games and parties): `JoinGame` on the master with room name `us<6 digits>` (the code), lobby `pvt`, join mode create-if-not-exists for the creator and default for whoever types the code. Up to 24 players.
- AppStats after the master login: 227 players on the master, 228 rooms, 229 players. The game throws a `NullReferenceException` without all three.

Matchmaking here, in order:

1. a room on this server that matches (`Room.matches`, as Photon) and has space;
2. the official Photon cloud, with the player's own login: the name-server Authenticate frame is replayed to `ns.photonengine.io`, the master gets the token that answers, and the player's master connection then passes through to it. The game server address it answers with becomes `/api/mp/smashkarts/remote/<ticket>` (the client adds `/?libversion=…` to the address, so the ticket is a path segment, not a query), which relays the connection frame for frame and rewrites only the first Authenticate to carry the cloud's token and user id. Only `*.exitgames.com` and `*.photonengine.io` are dialled. `MP_SK_REMOTE=off` turns this off, `MP_SK_APP_ID` and `MP_SK_REMOTE_NS` change the app and name server;
3. a new room here, if the cloud cannot be reached.

Private games and parties never go to the cloud: a code is looked up in this server's rooms, and a code that is not here answers "Game does not exist". Because PLAY looks for a room here first and leaves for the cloud when it finds none, rooms here are mostly private ones.

All game logic stays in the clients (the master client decides), so `game.js` only relays, as for 1v1.lol. There are no 55GMS accounts, results or ranks: names and progress are Smash Karts' own (Firebase), and the Firebase sign-in works from 55GMS's domain because the game's own page treats unknown hosts like a portal.

## Kart Bros

Kart Bros (Unity 6, network version 2.17) finds its servers at `wss://kart{da,ea,eu,mw,we}.kartbros.io/<n>` and pings `https://kart<xx>.kartbros.io/ping`, all hard-coded. An inline script in its 55GMS page (`static/misc/kart-bros/index.html`) sends the socket to `/api/mp/kartbros/play` and the pings to `/api/mp/kartbros/ping` on the page's host; only `DA` answers, so the game picks "US Dallas". Nothing goes to Blue Wizard's servers.

The original server is a relay with a lobby, not a game server: the host's game runs the race (karts, bots, items) and streams it, and the server keeps the sessions and passes each member's frames to the others. This one does the same. The protocol was read from the build (the message structs and their fields from `global-metadata.dat`, the ids from the registered names) and checked against captures of the original server.

Frames (`wire.js`): a client sends one frame per WebSocket message; the server sends one or more, each prefixed with its uint16 length. The first byte is the kind: `1` for the server, `2` from the server, `3` for every other member, `4` the game's own RPCs (item boxes, projectiles; their own serializer) for every other member, `0` unsequenced state for the others (the host's world state, ~30 a second), `5` a relayed frame (`[5][sender][host epoch][the sender's frame]`), and `6` wraps any of them with a uint32 sequence number, counted per direction and per member. A message is `[kind][id][MemoryPack payload]`, the id being FNV-1a of its registered name (`session_joined`).

What the server does:

- `protocol_hello`, `client_capabilities`: nothing to answer.
- `create_session` carries the code the client made up (`DA` and six hex digits; the three words on screen are the same number). The creator is player 0 and host, and gets `session_host_state` (host 0, epoch 1, capabilities 7), `session_resume_token`, `session_created` and `session_roles`.
- `join_session` by code: up to six players, then up to eight spectators, else `session_full`; an unknown code gets `invalid_session`. The joiner gets the same first two, then `session_joined` with every member, then `session_roles`; the others get `client_joined`. A player who joins mid-race waits for the next one.
- Kinds `0`, `3` and `4` are passed on stamped with the sender's id and the host epoch. The lobby (settings, rules, cup, ready, player info, chat), the race setup (`game_config`, `config_received`, `intro_seq_complete`) and the race itself are all messages between the members.
- Kind `1` messages the server does not handle itself (the host's `race_start_roster`) go back to every member as they came, the sender included, as the original does. `race_start_roster` from the host marks the race as running for anyone who joins. The host's `race_countdown_start` comes with zero times: the server sets `serverTime` to its clock (Unix seconds) and `startTime` one second later, and sends it to everyone the same way.
- Race end, from the build's own messages (a finish was not captured from the original): `player_finished` (a racer's own, or any from the host) is passed on and kept in order. The first one starts a 30 s limit (`race_timeout_update`); when every racer still connected has finished, the server sends `race_finished` with the order and who left. When time runs out it asks the host (`request_race_order`) and finishes with the host's `race_order_response`, or after 5 s with the order it has. `rematch_ready` is counted into `rematch_status_update`, and the host's `rematch_triggered` clears it.
- Leaving or dropping: `client_disconnected` to the rest; if the host left, the lowest remaining player becomes host (`host_changed`, epoch + 1, reason HostLeft). `host_transfer_request` (MAKE HOST) and `host_claim` (only once the host is gone), `set_member_role` (player or spectator; refused mid-race, when seats are full, or for the last player) and `member_away_report` are kept here too. Rejoining a dropped session (`resume_session`) is refused (`RoomGone`); the player joins again with the code.
- `ping` gets `pong`.

## Production

The same box as 55GMS. systemd runs `gms-multiplayer` on `127.0.0.1:8093` from `/root/multiplayer`; Caddy sends `/api/mp/*` to it on every hostname. A push to `main` runs `.github/workflows/deploy.yml`: syntax checks, then SSH with a key that may only run `/root/deploy-mp/entry.sh` (checkout, `npm ci`, restart, health check, restore on failure). Without the deploy secrets the deploy step is skipped.

One-time setup on the server:

```bash
git clone https://github.com/55gms/multiplayer /root/multiplayer
cd /root/multiplayer && npm ci --omit=dev
mkdir -p /root/deploy-mp && install -m 755 deploy/entry.sh /root/deploy-mp/entry.sh
install -m 644 deploy/gms-multiplayer.service /etc/systemd/system/
printf 'MP_SHARED_SECRET=%s\n' '<the value in /root/55gms/.env>' > /etc/gms-multiplayer.env && chmod 600 /etc/gms-multiplayer.env
systemctl daemon-reload && systemctl enable --now gms-multiplayer
curl -s 127.0.0.1:8093/api/mp/health
```

- `/root/.ssh/authorized_keys`: the deploy key's line starts with `command="/root/deploy-mp/entry.sh",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding`. Repo secrets: `DEPLOY_SSH_KEY` (its private half), `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS`.
- Caddyfile, in the catch-all site block, ahead of the app (next to the Wisp route):

  ```
  @mp path /api/mp/*
  handle @mp {
      reverse_proxy 127.0.0.1:8093
  }
  ```

  then `caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy`.

- When `deploy/entry.sh` changes, copy it to `/root/deploy-mp/entry.sh` again. When the unit changes, copy it and `systemctl daemon-reload`.
