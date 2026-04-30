# Meme Velocity Radar

Live Solana memecoin velocity dashboard.

The app runs as a single Node/Express process serving both the API and a Vite/React SPA. The backend ingests live program activity over SVS Geyser gRPC, falls back to DexScreener public feeds, enriches with the SVS API, scores tokens for velocity, virality, upside, and risk, and streams updates to the frontend.

## Documentation

- [docs/PRODUCT.md](docs/PRODUCT.md) — what the product is, who it's for, working features, non-goals, success metrics.
- [docs/RUNBOOK.md](docs/RUNBOOK.md) — local + Railway deploy, env vars, safe defaults, health endpoints, troubleshooting.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system diagram, data pipeline, components, safety/resilience, limitations.
- [docs/ROADMAP.md](docs/ROADMAP.md) — P0 stabilise, P1 protocol decoders / risk / social, P2 later, acceptance criteria.

## What it does

- Tracks live Solana memecoin candidates.
- Scores each token by velocity, virality, upside, and risk.
- Decodes the likely meme narrative from token metadata and social/profile signals.
- Streams live radar updates over Server-Sent Events.
- Exports visible signals as CSV.
- Keeps all API keys on the backend.

## Quick Start

Local:

```bash
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:5000. Runs on the DexScreener fallback even with no SVS keys.

Production build:

```bash
npm run build
npm start
```

The server reads `PORT` from the host environment and defaults to `5000`.

## Railway deploy (from phone)

1. Railway → **New project** → **Deploy from GitHub repo** → pick this repo.
2. Variables tab → paste the values you need (see `.env.example` and [docs/RUNBOOK.md](docs/RUNBOOK.md)).
3. If asked: build = `npm install && npm run build`, start = `npm start`.
4. **Settings → Networking → Generate Domain**.

**Safe production defaults:** keep `ENABLE_RAYDIUM_AMM_V4=false` (or unset) and leave `WATCH_RAYDIUM_AMM_V4_PROGRAM` blank. AMM v4 is the highest-volume mature pool stream and will OOM a small Railway container; it stays opt-in for that reason.

For launchpad-only ingestion (lowest event volume): also set `ENABLE_GRPC_DEX_POOLS=false`.

If `/api/svs/health` returns a `403` from the SVS API, your `SVS_API_KEY` is wrong or your account does not have the API entitlement — check your SVS plan. Full troubleshooting matrix in [docs/RUNBOOK.md](docs/RUNBOOK.md).

Health checks:

- `GET /api/svs/health` — overall SVS status, gRPC summary, auth-cooldown state.
- `GET /api/grpc/status` — instant gRPC worker state with `diagnostics` (parse counters, ignored-mint reasons, last candidate age).
- `GET /api/radar` — current radar snapshot (deadline-bound, falls back to last cached snapshot).

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
- `SVS_GRPC_ENDPOINT` / `SVS_GRPC_X_TOKEN` — Geyser gRPC. When set, the backend starts a Yellowstone-based worker that subscribes to live transactions on the watched program IDs (see below) and feeds candidates into the radar.

### gRPC live worker

The backend boots a Yellowstone gRPC worker only when `SVS_GRPC_ENDPOINT` is set. The worker:

- Connects to SVS Geyser using `SVS_GRPC_X_TOKEN` (optional for IP-whitelist plans).
- Subscribes to **transaction** updates with `vote: false`, `failed: false`.
- Groups filters as `launchpads` (PumpSwap, Raydium LaunchLab, Pump.fun) and `dexPools` (Raydium CPMM, AMM v4, CLMM) using `accountInclude` against the watched program IDs.
- Auto-reconnects with exponential backoff (1s → 30s).
- Sends a keepalive ping every ~30s.
- Maintains an in-memory candidate cache of recent mints (45-minute TTL, 1k cap), filtered to drop SOL/wSOL, USDC/USDT, BONK, WIF, etc.

The worker never crashes the web server: if the connection fails, the radar keeps working on its DexScreener fallback.

Sanitized status is exposed at `GET /api/grpc/status` and a summary is also embedded in `GET /api/svs/health` and `GET /api/radar`. Status fields cover `status` (`disabled` / `configured` / `connecting` / `connected` / `reconnecting` / `error`), `activeStreams`, `filters`, `lastEventAt`, `lastEventAgeSec`, `lastError`, `eventsReceived`, `eventsPerMinute`, `candidateCount`, and the configured `watchedPrograms`. The header shows a `gRPC` badge with the same info.

Watched-program env vars and stream toggles. The defaults below are the
**safe production defaults**: launchpads + Raydium CPMM are on, but Raydium
AMM v4 (the highest-volume mature pool stream and the most likely to OOM a
small Railway container) is off until you opt in.

```bash
# Stream-group toggles
ENABLE_GRPC_DEX_POOLS=true     # Raydium CPMM / CLMM. Set false to launchpad-only.
ENABLE_RAYDIUM_AMM_V4=false    # Raydium AMM v4 firehose. Only enable on a sized host.

# Watched programs (set blank to disable)
WATCH_PUMPSWAP_PROGRAM=pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
WATCH_RAYDIUM_LAUNCHLAB_PROGRAM=LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj
WATCH_RAYDIUM_CPMM_PROGRAM=CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
WATCH_RAYDIUM_AMM_V4_PROGRAM=   # blank = off; set explicitly to override AMM v4 toggle
WATCH_RAYDIUM_CLMM_PROGRAM=
WATCH_PUMPFUN_PROGRAM=
```

Either `ENABLE_RAYDIUM_AMM_V4=true` OR an explicit `WATCH_RAYDIUM_AMM_V4_PROGRAM`
value is enough to enable the AMM v4 stream — the explicit program ID is
treated as opt-in. With both blank/false the worker subscribes only to
launch-focused programs (PumpSwap, Raydium LaunchLab) and Raydium CPMM,
which is well within the budget of a small Railway container.

`/api/grpc/status` is synchronous and always returns instantly — it never
waits on the gRPC stream or external APIs. `/api/svs/health` and
`/api/radar` both run under hard deadlines and fall back to the last
cached snapshot rather than hanging behind slow upstream fetches.

`/api/grpc/status.diagnostics` exposes parse counters
(`eventsWithTokenBalances`, `eventsWithCandidateMints`, `eventsByProgram`,
`eventsByFilter`, `ignoredBaseMintCount`, `parseErrorCount`,
`lastCandidateAt`, `lastCandidateAgeSec`, `ignoredReasonCounts`) so a
`candidateCount: 0` despite high `eventsReceived` is explainable.

gRPC candidates are merged into the radar candidate list with priority above DexScreener. Mints that show on gRPC but have no DexScreener pair surface as conservative `grpc-only` `TokenSignal` entries with `riskFlags` like `pre-dex or no pair yet` and `grpc-only early signal`, and `sourceTags` including `grpc-live` and `grpc-transaction`. Liquidity and market cap are unknown for these and the conservative score never lets them dominate the ranking — they exist as a watchlist seed, not a buy signal.

Do not prefix secrets with `VITE_`. Anything prefixed with `VITE_` can be exposed to browser JavaScript. The frontend reads only `/api/svs/health` and `/api/grpc/status`, both of which return booleans/status strings — never the secret values.

The app continues to work without any SVS keys — it falls back to the public DexScreener feed for both data and signals. The header SVS badge shows `connected`, `degraded`, `error`, or `not configured` based on `/api/svs/health`.

## Notes

- `.env` files are ignored.
- SQLite runtime files are ignored.
- `dist/` is ignored because Railway should build from source.
- The current deployed prototype can run without SVS keys, using public fallback feeds.
