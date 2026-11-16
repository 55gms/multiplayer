# 55GMS multiplayer

One server for the multiplayer games on 55GMS. Each game has its own endpoints under `/api/mp/<game>/`, speaking the protocol that game's client already expects.

```bash
npm ci
node .   # PORT (default 8093), HOST (default 0.0.0.0)
```

`GET /api/mp/health` reports the games and open connections.
