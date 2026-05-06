# External Integrations

**Analysis Date:** 2026-05-05

## APIs & External Services

**Solana Vibe Station (SVS) — Primary enrichment API:**
- Service: Solana Vibe Station REST API (`https://free.api.solanavibestation.com` default)
- What it's used for: Token metadata, price/volume data, and mint info enrichment for radar candidates
- SDK/Client: Native `fetch` with `AbortController` timeout — no third-party SDK
- Auth: `SVS_API_KEY` env var (Bearer token in `Authorization` header)
- Implementation: `server/svs.ts`
- Endpoints consumed:
  - `POST /metadata` — batch token metadata (name, symbol, description, image, creators)
  - `POST /price` — batch price/volume data (latest price, 1m/15m/1h/24h/72h windows)
  - `POST /mint_info` — per-mint deep info (description, creator, early trades), concurrency-limited to 3 workers
- Error handling: 401/403 triggers a 5-minute auth cooldown that blocks all SVS calls; degraded gracefully, radar falls back to DexScreener data alone

**DexScreener — Token discovery and pair data:**
- Service: DexScreener public REST API (`https://api.dexscreener.com`)
- What it's used for: Token profiles, boosts, trending metas, and on-chain pair data for Solana
- SDK/Client: Native `fetch` — no API key required
- Auth: None (public endpoints)
- Implementation: `server/routes.ts` (`fetchJson` helper)
- Endpoints consumed:
  - `GET /token-boosts/latest/v1` — recently boosted token profiles
  - `GET /token-profiles/latest/v1` — latest token profiles
  - `GET /token-profiles/recent-updates/v1` — recently updated profiles
  - `GET /metas/trending/v1` — trending meme meta categories
  - `GET /token-pairs/v1/solana/{address}` — per-token DEX pair data (price, volume, txns, liquidity)
- Rate limiting: No API key, so all calls use a `User-Agent: meme-velocity-radar/1.0` header; concurrency capped at 7 parallel pair fetches via `mapPool`

## Data Storage

**Databases:**
- SQLite (via `better-sqlite3` 11.7.0)
  - Local file at `./data.db` (gitignored; not committed)
  - WAL journal mode enabled for concurrent reads
  - Schema auto-created at startup in `server/storage.ts`
  - ORM: Drizzle ORM (`server/storage.ts`, schema at `shared/schema.ts`)
  - Single table: `radar_snapshots(id, captured_at, payload TEXT)`
  - Purpose: Snapshot persistence for fallback when live feeds fail

**File Storage:**
- Local filesystem only — no cloud object storage

**Caching:**
- In-memory only: `memoryCache` variable in `server/routes.ts` (25-second TTL)
- `lastGoodSnapshot` — in-process last-known-good snapshot for deadline fallbacks
- `inflightSnapshot` — in-process promise coalescing to prevent concurrent radar builds

## Authentication & Identity

**Auth Provider:**
- Not active in current routes — `passport` and `passport-local` packages are installed but no auth middleware or login routes are registered in `server/routes.ts`
- `express-session` + `memorystore` are installed but unused in current code

**SVS API Auth:**
- Bearer token via `SVS_API_KEY` env var
- Auth failures (401/403) trigger a 5-minute cooldown; status surfaced to UI via `/api/svs/health`

## Monitoring & Observability

**Error Tracking:**
- None — no Sentry, Datadog, or similar SDK installed

**Logs:**
- Custom `log()` function in `server/index.ts` — timestamps all API requests with method, path, status, duration
- Response body summarization for `/api/radar`, `/api/grpc/status`, `/api/svs/health` to avoid logging large payloads (referenced comment: "spamming the Railway log pipeline")
- gRPC stream errors logged to `console.error` with `[grpc]` prefix

**Health Endpoints (internal):**
- `GET /api/svs/health` — SVS API + RPC + gRPC worker health with overall status
- `GET /api/grpc/status` — Real-time gRPC stream diagnostics (events/min, candidate count, filter state)

## CI/CD & Deployment

**Hosting:**
- Railway (referenced in comments throughout `server/grpcStream.ts` and docs)
- Single-dyno setup: Express serves API + static client from same process
- Port from `process.env.PORT` (Railway-injected), defaults to 5000
- Bind address: `0.0.0.0` with `reusePort: true`

**CI Pipeline:**
- Not detected — no GitHub Actions, CircleCI, or similar config files found

**Build:**
- Two-stage: `npm run build` → Vite client build to `dist/public/` then esbuild server bundle to `dist/index.cjs`
- Production start: `node dist/index.cjs`

## Webhooks & Callbacks

**Incoming:**
- None detected — no webhook receiver endpoints in `server/routes.ts`

**Outgoing:**
- None — all external calls are request-response or long-lived streaming

## Real-Time / Streaming

**Yellowstone Geyser gRPC (SVS):**
- Protocol: gRPC long-lived subscription stream via `@triton-one/yellowstone-grpc` 5.0.8
- Endpoint: `SVS_GRPC_ENDPOINT` env var (required to enable)
- Auth: `SVS_GRPC_X_TOKEN` env var (optional X-Token header)
- Implementation: `server/grpcStream.ts`
- What it watches: Solana launchpad and DEX pool program IDs (pumpswap, raydium-launchlab, pumpfun, raydium-cpmm, raydium-clmm; AMM v4 opt-in)
- Filter strategy: Two named filters — `launchpads` and `dexPools` — sent to the gRPC subscription
- Reconnect: Exponential backoff (1s–30s), 30-second keepalive pings
- Candidate TTL: 45 minutes, max 1,000 in-memory candidates

**Server-Sent Events (SSE):**
- Endpoint: `GET /api/radar/stream`
- Purpose: Pushes live `RadarSnapshot` to browser clients every 20 seconds
- Used by: `client/src/App.tsx` `EventSource` connection when live mode is active

## Blockchain / On-Chain

**Solana RPC:**
- HTTP endpoint: `SVS_RPC_HTTP_URL` env var
- WebSocket: `SVS_RPC_WS_URL` env var (configured but not actively consumed in current code)
- Probed via `getLatestBlockhash` in `server/svs.ts` (`probeRpcReachability`)
- Used for health checks; main data comes from SVS API and gRPC, not direct RPC calls

**Solana Program IDs watched via gRPC (defaults):**
- pumpswap: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`
- raydium-launchlab: `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`
- raydium-cpmm: `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`
- raydium-amm-v4: `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` (opt-in only)
- pumpfun: no default ID (must be provided via `WATCH_PUMPFUN_PROGRAM`)

## Environment Configuration

**Required env vars:**
- `SVS_GRPC_ENDPOINT` — enables live gRPC ingestion; without it, gRPC worker does not start
- `SVS_API_KEY` — enables SVS metadata/price enrichment; radar works on DexScreener alone without it

**Optional env vars:**
- `SVS_API_BASE_URL` — override SVS API host
- `SVS_RPC_HTTP_URL` — Solana RPC for health probing
- `SVS_RPC_WS_URL` — Solana WS (configured but currently unused beyond health config)
- `SVS_GRPC_X_TOKEN` — gRPC auth token
- `PORT` — HTTP listen port (Railway injects this)
- `ENABLE_GRPC_DEX_POOLS` — toggle DEX pool gRPC filters (default `true`)
- `ENABLE_RAYDIUM_AMM_V4` — enable high-volume AMM v4 filter (default `false`)
- `WATCH_PUMPSWAP_PROGRAM`, `WATCH_RAYDIUM_LAUNCHLAB_PROGRAM`, `WATCH_PUMPFUN_PROGRAM`, `WATCH_RAYDIUM_CPMM_PROGRAM`, `WATCH_RAYDIUM_CLMM_PROGRAM`, `WATCH_RAYDIUM_AMM_V4_PROGRAM` — program ID overrides

**Secrets location:**
- `.env` file at repo root (gitignored); `.env.example` documents all keys without values

---

*Integration audit: 2026-05-05*
