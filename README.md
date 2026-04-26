# Meme Velocity Radar

Live Solana memecoin velocity dashboard.

The app currently runs as a full-stack Node/Express + React service. The backend scans live public DEX-indexed feeds, scores tokens for velocity, virality, upside, and risk, and streams updates to the frontend.

## What it does

- Tracks live Solana memecoin candidates.
- Scores each token by velocity, virality, upside, and risk.
- Decodes the likely meme narrative from token metadata and social/profile signals.
- Streams live radar updates over Server-Sent Events.
- Exports visible signals as CSV.
- Keeps all API keys on the backend.

## Local setup

```bash
npm install
cp .env.example .env
npm run dev
```

Open:

```text
http://localhost:5000
```

## Production build

```bash
npm run build
npm start
```

The server reads `PORT` from the host environment and defaults to `5000`.

## Railway setup

From your phone:

1. Open Railway.
2. Create a new project.
3. Choose "Deploy from GitHub repo".
4. Pick this repo.
5. Add the environment variables from `.env.example` in Railway's Variables tab.
6. Use these commands if Railway asks:

Build command:

```bash
npm install && npm run build
```

Start command:

```bash
npm start
```

7. Generate a Railway public domain.

## Phase 1 SVS variables

```bash
SVS_API_BASE_URL=https://free.api.solanavibestation.com
SVS_API_KEY=
SVS_RPC_HTTP_URL=
SVS_RPC_WS_URL=
SVS_GRPC_ENDPOINT=
SVS_GRPC_X_TOKEN=
```

`SVS_API_BASE_URL` is optional and defaults to `https://free.api.solanavibestation.com`. The other variables enable enrichment and live-stream paths:

- `SVS_API_KEY` — used by the backend to call `/metadata`, `/price`, and `/mint_info` (sent as `Authorization: Bearer ...`).
- `SVS_RPC_HTTP_URL` / `SVS_RPC_WS_URL` — Solana JSON-RPC endpoints. The backend probes `getLatestBlockhash` for health checks.
- `SVS_GRPC_ENDPOINT` / `SVS_GRPC_X_TOKEN` — Geyser gRPC. Phase 1 only checks that the endpoint is configured.

Do not prefix secrets with `VITE_`. Anything prefixed with `VITE_` can be exposed to browser JavaScript. The frontend reads only `/api/svs/health`, which returns booleans/status strings — never the secret values.

The app continues to work without any SVS keys — it falls back to the public DexScreener feed for both data and signals. The header SVS badge shows `connected`, `degraded`, `error`, or `not configured` based on `/api/svs/health`.

## Notes

- `.env` files are ignored.
- SQLite runtime files are ignored.
- `dist/` is ignored because Railway should build from source.
- The current deployed prototype can run without SVS keys, using public fallback feeds.
