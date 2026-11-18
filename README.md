# 55GMS multiplayer

One server for the multiplayer games on [55GMS](https://github.com/55gms/55GMS). Each game has its own endpoints under `/api/mp/<game>/`, speaking the protocol that game's client already expects, so the game files stay as they are. Players on 55GMS play each other, except in Ducklings.io, where the server only relays the game to its own, still running, server.

| Game                                 | Endpoints                                                                                 | Protocol                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1v1.lol                              | `/api/mp/1v1/ns` (name server), `/api/mp/1v1/master`, `/api/mp/1v1/game`                  | Photon PUN 2 (binary protocol 1.8 over WebSocket)                                 |
| BasketBros, SoccerBros, BaseballBros | `/api/mp/<game>/play`, `/api/mp/<game>/ping` (`basketbros`, `soccerbros`, `baseballbros`) | Blue Wizard's lockstep relay (little-endian ints over WebSocket), one against one |
| FootballBros                         | `/api/mp/footballbros/play`, `/api/mp/footballbros/ping`                                  | The same relay with a lobby of up to three a side                                 |
| Ducklings.io                         | `/api/mp/ducklings/play`                                                                  | Passed through unchanged to `wss://multiplayer.ducklings.io/ws`                   |

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
- `games/bros/` the four Blue Wizard sports games: `wire.js` (message bytes), `clock.js` (the shared 60 Hz tick), `duel.js` (one against one), `lobby.js` (FootballBros), `index.js` (sockets, limits, the region ping)
- `games/ducklings/` a pass-through relay to Ducklings.io's own server
- `games/1v1/` the three Photon roles over one in-memory room registry (`rooms.js`), 55GMS accounts (`accounts.js`) and the match referee (`referee.js`)

## 1v1.lol

The build 55GMS hosts (1v1.LOL 3.800, Unity 2019.4, PUN 2.18.1) asked Photon's name server for AppId `82620531-…` and got `ApplicationArchived`: its Photon app is shut down, so it could not connect anywhere. The game page in 55GMS (`static/misc/nowgg/index.html`) wraps `WebSocket` so `*.exitgames.com` becomes `/api/mp/1v1/ns` on the page's own host. For local work, set `localStorage["gms-mp-base"] = "ws://localhost:8093/api/mp"` on the 55GMS page.

What the game does, and what the server answers:

- Name server: `GetRegions` gets one region whose address is our master; the HTTP region pings (`https://<host>/photon/m/?ping`) fail and the client carries on. `Authenticate` accepts anything and returns a token; the token maps back to the user id on the master and game servers.
- Master: PLAY sends `JoinRandomGame` in the SQL lobby `1v1Lobby` with `C0 = '<mode>'` and `MaxPlayers` 2 (or the mode's size). No match → `CreateGame`; the new room takes the searched properties and lobby at once, so players pressing PLAY together land in the same room. A search that fails while someone is creating the same room waits up to 1.5 s for it, and a player who reaches the room before its creator waits up to 5 s.
- Game server: rooms, actors, room and player properties (CAS, `BroadcastPropsChangeToAll`), `RaiseEvent` relay with receivers, targets, interest groups and the room event cache (PUN instantiation and buffered RPCs), master client handover on leave. A room is removed when its last player leaves.
- Signed-in players: the 55GMS page adds the account's game token as `?gms=`; `Authenticate` asks 55GMS whose it is (`games/1v1/accounts.js`) and gives the player the user id `gms:<uuid>` and their handle as name. Nobody else can take a `gms:` user id. Without the token, or with 55GMS unreachable, the player is a guest.
- Nobody here: a casual search that finds no room here goes at once to another public 1v1.lol server's queue, by default 1v1.lol Reloaded's (`MP_1V1_REMOTE_URL`, default `wss://ws.onecloudcdn.site/ns`; `off` turns it off), in region `us` (`MP_1V1_REMOTE_REGION`). Answering at once keeps the game's own waiting room ("1/2") and its Cancel button. The player's master connection then passes through to that server's master, and the game server address it answers with becomes `/api/mp/1v1/remote?ticket=…`, which relays the game connection frame for frame (`games/1v1/remote.js`): the first `Authenticate` carries that server's token, the player is named `55gms.com` there (`MP_1V1_REMOTE_NAME`), and every other player in the room gets a random name from `games/1v1/opponent-names.txt` on the player's screen (the same one for the whole match), while the player keeps their own name. Only addresses on that server's own host are dialled. If it cannot be reached the player waits in a room here as before. Matches there are not refereed, so they give no 55GMS results; ranked never leaves this server.
- Parties: the leader's search carries the party's user ids (`ExpectedUsers`). It stays on this server, joins only a room with space for the whole party, and keeps the members' places for 30 s while they follow the leader (`FindFriends`, then `JoinGame` by name).
- Ranked (`…_Competitive` modes): accounts only, one ranked room each. A ranked search joins the waiting ranked room closest to its 55GMS rating; the game's own `C1`/`C2` range filter is ignored (it overflows, never widens, and a waiting player never searches again). Two ranked players searching together wait up to 12 s for each other's room.
- Results: `games/1v1/referee.js` reads each `1v1` and `1v1_Competitive` match from the relayed messages and posts the result to 55GMS, which keeps ratings, XP, stats and the battle pass. See `docs/1v1-match-events.md` for what it reads and why it can be trusted. Results wait in memory and are retried while 55GMS is unreachable; 55GMS applies each match id once.
- Not supported: friends (Photon Chat). Accounts, the shop and LOL Pass are 55GMS's (`docs/1v1-backend.md` there).

`tools/capture.mjs` opens the game in headless Chromium and logs every Photon message, which is how the above was worked out: `CHROME_PATH=… node tools/capture.mjs http://localhost:8080/misc/nowgg/ --pages 2 --mp ws://localhost:8093/api/mp --click 1075,620@60 --size 640x360`. Software rendering is slow; two players on a small VM take long enough loading a map that the game may give up.

## BasketBros, SoccerBros, BaseballBros, FootballBros

Blue Wizard's games are Haxe builds that find their server from the page's own hostname: `https://<region>.<hostname>/ping` to list regions and `wss://<region>.<hostname>/<n>` to play. On 55GMS those hosts do not exist, and the originals (`*.basketbros.io`, one set of servers for all four games) are what school filters block. A script on each game page in 55GMS (`static/assets/js/bros-mp.js`) sends both to `/api/mp/<game>/ping` and `/api/mp/<game>/play` on the page's own host. Only the `EA` region answers its ping, so the game shows one server; the region in a private code is ignored.

The protocol was read from the game bundles and checked byte for byte against the original servers. Every message is one binary frame: an int32 type, then little-endian int32s, bytes and strings. The server simulates nothing. Once a match starts it sends every player the same tick 60 times a second (each game steps once per tick, so this is the game's speed) carrying every player's latest buttons. Names and chat are cleaned to printable ASCII.

Client to server, all four games:

| Type                    | Body                                                                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 join                  | skin (team index in BaseballBros and FootballBros), wins, losses, perk count, perks (bytes), 6 outfit bytes, 4 guid ints, private game number (0 = public), raw name to the end (FootballBros adds an int 2 after it) |
| 0 input                 | BasketBros/SoccerBros/BaseballBros: 4 ints, the low byte of each relayed. FootballBros: 5 ints (left, right, up, punch, down)                                                                                         |
| 6 chat                  | length, text                                                                                                                                                                                                          |
| 5 score                 | mine, theirs (classic games, after each goal; ignored)                                                                                                                                                                |
| 2 side, 8 team, 7 start | FootballBros lobby: move side (3 a side at most), pick the side's team, host starts                                                                                                                                   |

Server to client, BasketBros, SoccerBros, BaseballBros (`duel.js`): nothing until a second player with the same private game number (or public) arrives, then both get a `1` for each player (side 0 left / 1 right, skin, wins, losses, perks, outfit, isYou, length-prefixed upper-cased name) and the ticks start: `0, frame, left 4 bytes, right 4 bytes`. Chat comes back to both as `6, side, "NAME : text"`. When one leaves the other keeps getting ticks, as on the originals.

Server to client, FootballBros (`lobby.js`): the joiner gets its own `1` (client id, team, wins, losses, perks, outfit, isYou, side, name), every other player's `1`, and each side's team as `8, -1000 - side, team`; the others get the joiner's `1`; the host gets `9`. Side and team changes go to the others as `2, id, side` and `8, id, team`, a player leaving as `3, id` (a new host gets `9`). The host's `7` sends `7` to all, every player's `1` again, then ticks: `0, frame, count, then per player id and 5 input bytes`.

`node` with two `ws` clients is enough to try it: connect to `ws://localhost:8093/api/mp/soccerbros/play` twice, send each a join, and both start getting ticks.

## Ducklings.io

Ducklings.io's server still runs, but the game can no longer reach it from 55GMS: the address in the game, `wss://ducklings.io/ws`, now redirects to `wss://multiplayer.ducklings.io/ws` (browsers do not follow redirects for WebSockets), that server answers 401 to any `Origin` but `https://ducklings.io`, and filters block the domain. An inline script in the game's page on 55GMS (`static/misc/ducklings-io/index.html`) sends any `ducklings.io` WebSocket to `/api/mp/ducklings/play`. For each connection there, `games/ducklings/index.js` opens one to the real server with `Origin: https://ducklings.io` and passes frames both ways unchanged; when either side closes, so does the other. Frames the game sends before the real server answers wait (64 at most).

The server only does matchmaking and WebRTC signalling (JSON text frames such as `ping`, rooms, offers, ICE candidates, `turnCredentials`). A match itself runs between the players' browsers over WebRTC data channels, directly or through the game's TURN server, so it never passes through here; on a network that blocks that, players find a room and then fail to connect to each other. Every player reaches the real server from this box's address.

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
