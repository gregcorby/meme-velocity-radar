# External Integrations

**Analysis Date:** 2026-05-04

## APIs & External Services

**Public market-data feed (always-on, no auth):**
- **DexScreener public API** (`https://api.dexscreener.com`) — trending pairs, price/volume/liquidity, profile metadata, boost info; the always-on fallback that lets the radar function without any SVS keys.
  - Constant: `const DEX = "https://api.dexscreener.com";` (`server/routes.ts:74`)
  - Helper: `fetchJson()` (`server/routes.ts:139-178`) — wraps every call with an `AbortController` 6 s timeout plus a "hard-deadline" `Promise.race` 2 s past the abort to defend against event-loop starvation
  - Calls are paged through `mapPool()` (`server/routes.ts:180-191`) with concurrency cap, and bounded by `MAX_CANDIDATES = 14`
  - SDK/Client: none — raw `fetch` with `User-Agent: meme-velocity-radar/1.0`
  - Auth: none (public)

**Solana data — Solana Vibe Station (SVS), all optional:**
- **SVS REST API** (default base `https://free.api.solanavibestation.com`, override via `SVS_API_BASE_URL`) — token metadata, mint info, price windows.
  - Endpoints called: `/metadata`, `/price`, `/mint_info` (batched POST, batch size 36 — `server/svs.ts:8`, `server/svs.ts:144-149`)
  - SDK/Client: raw `fetch` via `fetchWithTimeout()` (`server/svs.ts:63-71`), 8 s timeout (3 s for probes)
  - Auth: `Authorization: Bearer ${process.env.SVS_API_KEY}` (`server/svs.ts:57-61`)
  - Auth-cooldown logic: on a 401/403 response, paid SVS calls are short-circuited for 5 minutes (`AUTH_REJECTED_COOLDOWN_MS`, `server/svs.ts:14-35`); probes still run so the badge can recover.
- **SVS RPC HTTP / WS** (`SVS_RPC_HTTP_URL`, `SVS_RPC_WS_URL`) — used today only to probe `getLatestBlockhash` for health.
  - Reserved for future on-chain reads (P1.2 risk scoring per `docs/ROADMAP.md`).
- **SVS Geyser gRPC** (Yellowstone) (`SVS_GRPC_ENDPOINT`) — live transaction firehose for the watched program IDs.
  - SDK/Client: `@triton-one/yellowstone-grpc` 5.0.8 (`server/grpcStream.ts:9` imports `bs58`; the Yellowstone client is dynamically loaded inside `startGrpcWorker()` further down the file)
  - Auth: `SVS_GRPC_X_TOKEN` (optional on IP-whitelist plans)
  - Subscribes to **transactions** with `vote: false`, `failed: false`, grouped into two named filters: `launchpads` and `dexPools` (`server/grpcStream.ts:142-168`)
  - Reconnect: exponential backoff, base 1 s → max 30 s (`RECONNECT_BASE_MS`, `RECONNECT_MAX_MS`, `server/grpcStream.ts:73-74`)
  - Keepalive: ping every 30 s (`KEEPALIVE_MS`, `server/grpcStream.ts:72`)

## Data Storage

**Databases:**
- **SQLite** via `better-sqlite3` 11.7.0
  - Connection: local file `./data.db` (path is hard-coded in both the runtime client and `drizzle.config.ts`)
  - Client: Drizzle ORM (`drizzle-orm/better-sqlite3`) — `db = drizzle(sqlite)` (`server/storage.ts:7-17`)
  - PRAGMA: `journal_mode = WAL` (`server/storage.ts:8`)
  - Schema: created at boot via inline `CREATE TABLE IF NOT EXISTS radar_snapshots ...` (`server/storage.ts:9-15`); also defined in Drizzle (`shared/schema.ts:5-9`)
  - Tables: `radar_snapshots(id, captured_at, payload)` — only the most recent row matters; the table grows monotonically and is **never pruned** (see `CONCERNS.md`)
  - Migrations directory: `./migrations` (configured in `drizzle.config.ts`; not currently checked in)

**File Storage:**
- Local filesystem only. SQLite (`data.db`, `data.db-wal`, `data.db-shm`, `data.db-journal`) is the only persisted state. All gitignored.

**Caching:**
- Process-local only:
  - In-process radar snapshot cache: `memoryCache` with `CACHE_MS = 25_000` and `lastGoodSnapshot` (`server/routes.ts:75-85`)
  - In-memory gRPC candidate cache: 45-minute TTL, 1000-entry hard cap (`CANDIDATE_TTL_MS`, `CANDIDATE_MAX`, `server/grpcStream.ts:75-76`)
- No Redis, Memcached, Cloudflare KV, etc.

## Authentication & Identity

**Auth Provider:**
- None. The product is a single-tenant, read-only dashboard. There is no login screen, no session, no per-user state.
- `passport`, `passport-local`, `express-session`, `memorystore`, `@types/passport*` are present in `package.json` and listed in the `script/build.ts` allowlist but **never imported** by `server/`. Treat as unused scaffold residue.

## Monitoring & Observability

**Error Tracking:**
- None. No Sentry, Datadog, OpenTelemetry, etc.
- The Express error middleware logs to `console.error` and returns `{ message }` to the client (`server/index.ts:94-105`).

**Logs:**
- Custom one-liner formatter `log(message, source)` (`server/index.ts:28-37`) — local time + `[source]` prefix, written to `console.log`
- Per-request response logger summarises payloads instead of dumping JSON (`summarizeResponseBody`, `server/index.ts:42-65`) — explicitly designed to keep Railway log volume manageable (e.g. radar response is collapsed to `tokens=N sources=M grpc=…`)
- gRPC worker exposes counters (`/api/grpc/status.diagnostics`) instead of per-event logs (`server/grpcStream.ts:19-29`)

**Health endpoints:**
- `GET /api/svs/health` — overall SVS status, gRPC summary, auth-cooldown state, deadline-bound at `HEALTH_DEADLINE_MS = 6_000` (`server/routes.ts:856-880`)
- `GET /api/grpc/status` — synchronous, never reaches outside the process; returns connection state, filters, watched programs, parse-counter diagnostics (`server/routes.ts:882-891`)
- `GET /api/radar` — current snapshot, deadline `RADAR_BUILD_DEADLINE_MS = 12_000`, falls back to last cached SQLite snapshot if the live build fails (`server/routes.ts:893-911`)

## CI/CD & Deployment

**Hosting:**
- Railway (documented target in `README.md` and `docs/RUNBOOK.md`)
- Build command: `npm install && npm run build`; start command: `npm start`
- Server binds `0.0.0.0:$PORT` with `reusePort: true` (`server/index.ts:121-127`)
- `dist/` is gitignored — Railway must build from source on every deploy.

**CI Pipeline:**
- None checked in. No `.github/workflows/`, no `.gitlab-ci.yml`, no `circleci/`, no `azure-pipelines.yml`. Deployment is a Railway redeploy on push to GitHub.

## Environment Configuration

**Required env vars:**
- `PORT` — host-injected; defaults to `5000` (`server/index.ts:121`).
- `NODE_ENV` — `development` (npm run dev) or `production` (npm start). Controls dev-Vite vs static-serving (`server/index.ts:110-115`).

**Optional env vars (radar is fully functional with all of these unset):**
- `SVS_API_BASE_URL` — defaults to `https://free.api.solanavibestation.com`
- `SVS_API_KEY` — enables `/metadata`, `/price`, `/mint_info` enrichment
- `SVS_RPC_HTTP_URL`, `SVS_RPC_WS_URL` — enable RPC health probe
- `SVS_GRPC_ENDPOINT`, `SVS_GRPC_X_TOKEN` — enable Yellowstone live worker
- Stream toggles: `ENABLE_GRPC_DEX_POOLS` (default `true`), `ENABLE_RAYDIUM_AMM_V4` (default `false`, **safe production default**)
- Watched programs: `WATCH_PUMPSWAP_PROGRAM`, `WATCH_RAYDIUM_LAUNCHLAB_PROGRAM`, `WATCH_RAYDIUM_CPMM_PROGRAM`, `WATCH_RAYDIUM_AMM_V4_PROGRAM`, `WATCH_RAYDIUM_CLMM_PROGRAM`, `WATCH_PUMPFUN_PROGRAM` — set to empty string to disable; defaults baked into `loadWatchPrograms()` (`server/grpcStream.ts:94-134`)
- Phase-2 placeholders not yet wired into code: `SVS_STAKED_RPC_URL`, `SVS_LIGHTSPEED_URL`

**Secrets location:**
- Local: `.env` at the repo root (gitignored). Loaded by `dotenv/config` at server boot.
- Production: Railway "Variables" tab.
- **Never prefix with `VITE_`.** The repo intentionally keeps every secret server-side; the SPA only reads `/api/svs/health` and `/api/grpc/status`, which return statuses/booleans rather than raw values.

## Webhooks & Callbacks

**Incoming:**
- None. There is no webhook receiver, no payload-verifying middleware (the `req.rawBody` capture in `server/index.ts:18-24` is plumbed but unused).

**Outgoing:**
- None. The server makes outbound HTTP calls to DexScreener and SVS, and a long-lived gRPC subscription to SVS Geyser, but does not invoke any third-party webhook URLs.

**Server-Sent Events (outgoing push to client):**
- `GET /api/radar/stream` — pushes a fresh radar snapshot every 20 s over SSE (`server/routes.ts:913-939`). This is not a webhook, but it is the live push channel from server to browser.

---

*Integration audit: 2026-05-04*
