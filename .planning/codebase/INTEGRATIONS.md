# External Integrations

**Analysis Date:** 2026-05-04

## APIs & External Services

**Solana Vibe Station (SVS) — primary upstream:**
- SVS REST API — token metadata, prices, mint info, ranking, price subscriptions.
  - SDK/Client: built-in `fetch` (native Node fetch). See `server/svs.ts` lines 144-184 (`postBatch`), 196-250 (`fetchSvsMintInfo`).
  - Endpoints called: `POST {SVS_API_BASE_URL}/metadata`, `POST .../price`, `POST .../mint_info`. Default base = `https://free.api.solanavibestation.com`.
  - Auth: env `SVS_API_KEY` sent as `Authorization: Bearer <key>` (`server/svs.ts` line 60). 401/403 triggers a 5-minute global cooldown that short-circuits subsequent calls (`AUTH_REJECTED_COOLDOWN_MS`, lines 14-26).
  - Timeouts: 8s normal (`SVS_TIMEOUT_MS`), 3s for health probes (`SVS_PROBE_TIMEOUT_MS`). Batches mints in chunks of 36 (`BATCH_SIZE`).
- SVS Solana JSON-RPC — health probe and fallback reads.
  - SDK/Client: native `fetch` posting `getLatestBlockhash` JSON-RPC (`server/svs.ts` lines 259-293, `probeRpcReachability`).
  - Endpoint: `SVS_RPC_HTTP_URL` (HTTP) and `SVS_RPC_WS_URL` (WebSocket — declared but no active subscriber wires it up in current code).
  - Auth: API key embedded in URL as `?api_key=...` per the example template.
- SVS Geyser gRPC (Yellowstone) — live transaction stream for launchpads/DEXes.
  - SDK/Client: `@triton-one/yellowstone-grpc` 5.0.8, dynamically imported in `server/grpcStream.ts` line 433 to keep cold-start fast.
  - Endpoint: `SVS_GRPC_ENDPOINT` (default in `.env.example`: `https://basic.grpc.solanavibestation.com`).
  - Auth: env `SVS_GRPC_X_TOKEN` (optional — IP-whitelist plans don't need it). Passed as the `xToken` constructor arg.
  - Subscribes to transaction updates with `vote: false`, `failed: false`, commitment `confirmed`. Filter groups: `launchpads` (PumpSwap, Raydium LaunchLab, Pump.fun) + `dexPools` (Raydium CPMM/AMM v4/CLMM) gated by `ENABLE_GRPC_DEX_POOLS` and `ENABLE_RAYDIUM_AMM_V4`. Reconnects with exponential backoff 1s → 30s, sends a 30s keepalive ping.

**DexScreener (public fallback feed):**
- DexScreener REST — token profiles, pair stats, narrative metas. The radar always queries DexScreener and treats SVS as enrichment.
  - SDK/Client: native `fetch` (`server/routes.ts` line 160). `User-Agent: meme-velocity-radar/1.0`.
  - Base: `https://api.dexscreener.com` (`server/routes.ts` line 74, constant `DEX`).
  - Auth: none (public).
  - Resilience: per-request `AbortController` with explicit timeout, plus a "hard deadline" `+2000ms` `Promise.race` to defend against event-loop starvation (`server/routes.ts` lines 140-178).

**Solana program IDs watched (configurable, gRPC filter targets):**
- PumpSwap (`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`)
- Raydium LaunchLab (`LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`)
- Raydium CPMM (`CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`)
- Raydium AMM v4 / Raydium CLMM / Pump.fun — opt-in via env (default blank).

## Data Storage

**Databases:**
- SQLite (local file) via better-sqlite3 11.7.0.
  - Connection: hard-coded file path `./data.db` (`server/storage.ts` line 7). NOT configured by an env var. WAL journal mode enabled.
  - Client/ORM: drizzle-orm 0.45.2 (`drizzle-orm/better-sqlite3`). Schema in `shared/schema.ts`. Migrations directory `./migrations` (configured but no migrations checked in — `drizzle-kit push` is the workflow per `package.json` script `db:push`).
  - Tables: `radar_snapshots` (id INTEGER PK, captured_at TEXT, payload TEXT — JSON-encoded snapshot blob). Auto-created at boot via inline `CREATE TABLE IF NOT EXISTS` (`server/storage.ts` lines 9-15).
  - Persistence purpose: store last good radar snapshot so `/api/radar` can serve from disk if upstream feeds all fail (`server/routes.ts` lines 899-907).

**File Storage:**
- Local filesystem only. No S3/GCS/Cloudinary/etc detected. Static client bundle is served from `dist/public/`.

**Caching:**
- In-process only. `server/routes.ts` keeps a 25s in-memory snapshot cache (`CACHE_MS = 25_000`, line 75), an `inflightSnapshot` deduper (line 85), and a `lastGoodSnapshot` fallback. The gRPC worker holds an in-memory candidate cache with 45-minute TTL and a 1000-entry cap (`server/grpcStream.ts` lines 75-76). No Redis/Memcached.

## Authentication & Identity

**Auth Provider:**
- None — the app has no user accounts or login flow. There are no protected endpoints.
- `passport`, `passport-local`, `express-session`, `memorystore`, and `@supabase/supabase-js` are listed in `package.json` `dependencies` but no source file imports them — they appear to be vestigial scaffolding.
- Implementation: API keys (SVS) live exclusively on the backend; the frontend never sees them. `README.md` line 158 explicitly forbids `VITE_`-prefixed secrets.

## Monitoring & Observability

**Error Tracking:**
- None (no Sentry, Datadog, Bugsnag, OpenTelemetry, etc).
- Top-level Express error handler in `server/index.ts` lines 94-105 logs to stderr via `console.error` and returns JSON `{ message }` to clients.

**Logs:**
- `console.log` via the local `log()` helper in `server/index.ts` lines 28-37 (timestamp + source tag).
- Per-request access log middleware at `server/index.ts` lines 67-89 captures status + duration and emits a sanitized `summarizeResponseBody` summary for `/api/*` paths only — body summaries are intentionally compact (e.g. `tokens=N sources=N grpc=...`) to avoid log spam from 50-200KB radar payloads.
- gRPC worker tagged logs use `log(msg, "grpc")` (`server/index.ts` lines 132-143).

## CI/CD & Deployment

**Hosting:**
- Railway (primary, documented in `README.md` lines 44-86). Build = `npm install && npm run build`. Start = `npm start`. Port from `PORT` env. The `0.0.0.0` host + `reusePort: true` listener (`server/index.ts` lines 121-127) is tuned for Railway's proxy.
- The runtime is otherwise platform-agnostic — any Node 20 host that can run a single CJS bundle and persist `data.db` would work.

**CI Pipeline:**
- None detected. No `.github/workflows/`, no `.gitlab-ci.yml`, no `circleci/`, no Jenkinsfile.

## Environment Configuration

**Required env vars (names only, taken from `.env.example`):**
- `NODE_ENV` — `development` (set by `npm run dev`) or `production`.
- `PORT` — server listen port (read in `server/index.ts` line 121, defaults to `5000`).
- `SVS_API_BASE_URL` — optional override; default `https://free.api.solanavibestation.com`.
- `SVS_API_KEY` — bearer token for the SVS REST API (metadata/price/mint_info). Without it, the app runs on DexScreener-only.
- `SVS_RPC_HTTP_URL` — Solana JSON-RPC endpoint (with embedded api_key).
- `SVS_RPC_WS_URL` — Solana JSON-RPC WebSocket endpoint (declared; no active subscriber in current code).
- `SVS_GRPC_ENDPOINT` — Yellowstone gRPC endpoint. Presence enables the gRPC worker.
- `SVS_GRPC_X_TOKEN` — optional gRPC `x-token`.
- `ENABLE_GRPC_DEX_POOLS` — toggle Raydium CPMM/CLMM streams (default true).
- `ENABLE_RAYDIUM_AMM_V4` — toggle Raydium AMM v4 firehose (default false; OOM risk on small hosts).
- `WATCH_PUMPSWAP_PROGRAM`, `WATCH_RAYDIUM_LAUNCHLAB_PROGRAM`, `WATCH_RAYDIUM_CPMM_PROGRAM`, `WATCH_RAYDIUM_AMM_V4_PROGRAM`, `WATCH_RAYDIUM_CLMM_PROGRAM`, `WATCH_PUMPFUN_PROGRAM` — Solana program IDs to subscribe to (set blank to disable individually).
- `SVS_STAKED_RPC_URL`, `SVS_LIGHTSPEED_URL` — phase 2 only (not consumed by current code).

**Secrets location:**
- Local dev: `.env` file in repo root (gitignored — `.gitignore` lines 11-13). `.env.example` ships as the template.
- Production: Railway's "Variables" tab per `README.md` step 5 (lines 47, 71). No vault/secret manager is integrated.
- Forbidden files present in repo: only `.env.example` (safe to read). No `.env`, `*.pem`, `*.key`, `credentials.*`, or `secrets.*` are tracked.

## Webhooks & Callbacks

**Incoming:**
- None. The Express app exposes only read-only GET endpoints — no webhook receivers.
- API endpoints (`server/routes.ts`):
  - `GET /api/svs/health` (line 856) — overall SVS status with gRPC summary; deadline-bound 6s.
  - `GET /api/grpc/status` (line 882) — synchronous gRPC worker snapshot (instant; never awaits the stream).
  - `GET /api/radar` (line 893) — radar snapshot; deadline-bound 12s; falls back to last cached/saved snapshot.
  - `GET /api/radar/stream` (line 913) — Server-Sent Events stream; pushes a fresh snapshot every 20s.

**Outgoing:**
- DexScreener REST: `GET https://api.dexscreener.com/<path>` (token-profiles + pair queries, see `server/routes.ts`).
- SVS REST: `POST {SVS_API_BASE_URL}/metadata`, `POST .../price`, `POST .../mint_info` (see `server/svs.ts`).
- SVS RPC: `POST {SVS_RPC_HTTP_URL}` JSON-RPC `getLatestBlockhash` (health probe only).
- SVS Geyser gRPC: persistent subscription stream to `SVS_GRPC_ENDPOINT` (`server/grpcStream.ts`).
- No outbound webhooks (no Slack/Discord/Stripe/etc notifications).

---

*Integration audit: 2026-05-04*
