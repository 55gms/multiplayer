# 55GMS multiplayer

One server for the multiplayer games on [55GMS](https://github.com/55gms/55GMS). Each game has its own endpoints under `/api/mp/<game>/`, speaking the protocol that game's client already expects, so the game files stay as they are. Players on 55GMS play each other; nobody here talks to the games' original servers.

| Game    | Endpoints                                                                | Protocol                                          |
| ------- | ------------------------------------------------------------------------ | ------------------------------------------------- |
| 1v1.lol | `/api/mp/1v1/ns` (name server), `/api/mp/1v1/master`, `/api/mp/1v1/game` | Photon PUN 2 (binary protocol 1.8 over WebSocket) |

`GET /api/mp/health` reports the games and open connections. Every minute the server logs one `stats` line (connections, rooms, players, bytes).

```bash
npm ci
node .                # PORT (default 8093), HOST (default 0.0.0.0)
MP_DEBUG=1 node .     # also log every operation with its parameters
```

## Layout

- `src/server.js` routes `/api/mp/<game>/<rest>` (HTTP and websocket upgrades) to `games/<game>/index.js`
- `src/limits.js` caps: 64 KiB per message, 120 messages/s per connection, 64 connections per IP, 60 s idle, 16 players per room
- `src/photon/` the Photon layer any Photon game can reuse: `protocol18.js` (value codec), `codes.js` (operation, parameter and event codes), `peer.js` (framing, ping, limits)
- `games/1v1/` the three Photon roles over one in-memory room registry (`rooms.js`)

## 1v1.lol

The build 55GMS hosts (1v1.LOL 3.800, Unity 2019.4, PUN 2.18.1) asked Photon's name server for AppId `82620531-…` and got `ApplicationArchived`: its Photon app is shut down, so it could not connect anywhere. The game page in 55GMS (`static/misc/nowgg/index.html`) wraps `WebSocket` so `*.exitgames.com` becomes `/api/mp/1v1/ns` on the page's own host. For local work, set `localStorage["gms-mp-base"] = "ws://localhost:8093/api/mp"` on the 55GMS page.

What the game does, and what the server answers:

- Name server: `GetRegions` gets one region whose address is our master; the HTTP region pings (`https://<host>/photon/m/?ping`) fail and the client carries on. `Authenticate` accepts anything and returns a token; the token maps back to the user id on the master and game servers.
- Master: PLAY sends `JoinRandomGame` in the SQL lobby `1v1Lobby` with `C0 = '<mode>'` and `MaxPlayers` 2 (or the mode's size). No match → `CreateGame`; the new room takes the searched properties and lobby at once, so players pressing PLAY together land in the same room. A search that fails while someone is creating the same room waits up to 1.5 s for it, and a player who reaches the room before its creator waits up to 5 s.
- Game server: rooms, actors, room and player properties (CAS, `BroadcastPropsChangeToAll`), `RaiseEvent` relay with receivers, targets, interest groups and the room event cache (PUN instantiation and buffered RPCs), master client handover on leave. A room is removed when its last player leaves.
- Not supported: Google login, the shop, LOL Pass, friends and parties (Firebase and Photon Chat).

`tools/capture.mjs` opens the game in headless Chromium and logs every Photon message, which is how the above was worked out: `CHROME_PATH=… node tools/capture.mjs http://localhost:8080/misc/nowgg/ --pages 2 --mp ws://localhost:8093/api/mp --click 1075,620@60 --size 640x360`. Software rendering is slow; two players on a small VM take long enough loading a map that the game may give up.

## Production

The same box as 55GMS. systemd runs `gms-multiplayer` on `127.0.0.1:8093` from `/root/multiplayer`; Caddy sends `/api/mp/*` to it on every hostname. A push to `main` runs `.github/workflows/deploy.yml`: syntax checks, then SSH with a key that may only run `/root/deploy-mp/entry.sh` (checkout, `npm ci`, restart, health check, restore on failure). Without the deploy secrets the deploy step is skipped.

One-time setup on the server:

```bash
git clone https://github.com/55gms/multiplayer /root/multiplayer
cd /root/multiplayer && npm ci --omit=dev
mkdir -p /root/deploy-mp && install -m 755 deploy/entry.sh /root/deploy-mp/entry.sh
install -m 644 deploy/gms-multiplayer.service /etc/systemd/system/
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
