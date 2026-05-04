# External Integrations

## APIs & External Services

### Solana Vibe Station (SVS) — REST API
- **Base URL:** `process.env.SVS_API_BASE_URL` or default `https://free.api.solanavibestation.com` (`server/svs.ts:5`, `server/svs.ts:49`).
- **SDK:** None. Plain `fetch` with an `AbortController`-backed timeout helper (`server/svs.ts:63-71`).
- **Auth:** `Authorization: Bearer ${SVS_API_KEY}` injected backend-only (`server/svs.ts:57-61`).
- **Endpoints called:**
  - `POST /metadata` — batched mint metadata, BATCH_SIZE 36 (`server/svs.ts:188`, batch in `server/svs.ts:160-165`).
  - `POST /price` — batched price/volume; also used as health probe (`server/svs.ts:193`, `server/svs.ts:311-318`).
  - `POST /mint_info` — per-mint creator/authority enrichment, concurrency 3 (`server/svs.ts:222`).
- **Failure behavior:** 401/403 triggers a 5-minute auth cooldown that short-circuits subsequent calls (`server/svs.ts:14-21`, `server/svs.ts:166-172`); the radar falls back to DexScreener data (`README.md:160`).

### Solana Vibe Station — JSON-RPC
- **URL:** `process.env.SVS_RPC_HTTP_URL` (e.g. `https://basic.rpc.solanavibestation.com/?api_key=...`) (`.env.example:11`, `server/svs.ts:260`).
- **WS URL:** `process.env.SVS_RPC_WS_URL` declared (`.env.example:12`, `server/svs.ts:52`) but no WebSocket subscription code is wired; the var is only inspected for presence in `getSvsConfig()`.
- **SDK:** None. Raw JSON-RPC `POST` with method `getLatestBlockhash` for health probing (`server/svs.ts:266-271`).
- **Auth:** API key embedded in URL query string by the operator (`.env.example:11`).

### Solana Vibe Station — Geyser gRPC
- **Endpoint:** `process.env.SVS_GRPC_ENDPOINT` (e.g. `https://basic.grpc.solanavibestation.com`) (`.env.example:16`, `server/grpcStream.ts:545`).
- **SDK:** `@triton-one/yellowstone-grpc@^5.0.8`, lazy-loaded (`server/grpcStream.ts:433`).
- **Auth:** Optional `X-Token` via `process.env.SVS_GRPC_X_TOKEN` passed as constructor arg (`server/grpcStream.ts:546`, `server/grpcStream.ts:439`). IP-whitelist plans may omit it.
- **Subscription:** `subscribe()` with `commitment: 1` (confirmed), `vote: false`, `failed: false`, two filter groups `launchpads` and `dexPools` keyed on `accountInclude` against watched program IDs (`server/grpcStream.ts:142-167`, `server/grpcStream.ts:443-463`).
- **Resilience:** Exponential reconnect 1s → 30s (`server/grpcStream.ts:73-74`, `server/grpcStream.ts:521-541`); 30s keepalive ping (`server/grpcStream.ts:72`, `server/grpcStream.ts:466-487`); 45-min / 1k-cap candidate cache (`server/grpcStream.ts:75-76`).

### DexScreener — Public REST
- **Base URL:** `https://api.dexscreener.com` constant (`server/routes.ts:74`).
- **SDK:** None. `fetch` with custom `User-Agent: meme-velocity-radar/1.0` (`server/routes.ts:160-163`).
- **Auth:** None (public endpoint).
- **Endpoints called:**
  - `GET /token-boosts/latest/v1` (`server/routes.ts:543`).
  - `GET /token-profiles/latest/v1` (`server/routes.ts:544`).
  - `GET /token-profiles/recent-updates/v1` (`server/routes.ts:545`).
  - `GET /metas/trending/v1` (`server/routes.ts:546`).
  - `GET /token-pairs/v1/solana/{address}` (`server/routes.ts:599`).
- **Concurrency / deadlines:** Pool of 7 (`server/routes.ts:598`); per-call timeout 6s (`server/routes.ts:139,599`); hard build deadline 12s (`server/routes.ts:81`, `server/routes.ts:806`).

### Watched Solana Programs (gRPC `accountInclude` filters)
- PumpSwap: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` (`server/grpcStream.ts:104`).
- Raydium LaunchLab: `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj` (`server/grpcStream.ts:108`).
- Raydium CPMM: `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` (`server/grpcStream.ts:119`).
- Raydium AMM v4 (opt-in only): `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` (`server/grpcStream.ts:129`).
- Raydium CLMM, Pump.fun: blank by default (`server/grpcStream.ts:122,111`).

### Not Detected
- No Stripe, OpenAI, Anthropic, AWS SDK, Google APIs, Sentry, Datadog, Vercel SDK, Supabase usage. `@supabase/supabase-js` is in `package.json:43` but never imported.

## Data Storage

### SQLite (primary persistence)
- **Driver:** `better-sqlite3@^11.7.0` (`server/storage.ts:4`).
- **ORM:** `drizzle-orm/better-sqlite3` (`server/storage.ts:3`).
- **File:** `./data.db` (relative to CWD), opened at boot (`server/storage.ts:7`).
- **WAL mode:** `journal_mode = WAL` enabled at startup (`server/storage.ts:8`).
- **Schema:** Single table `radar_snapshots(id INTEGER PK AUTOINCREMENT, captured_at TEXT, payload TEXT)` created via `CREATE TABLE IF NOT EXISTS` and mirrored in Drizzle (`server/storage.ts:9-15`, `shared/schema.ts:5-9`).
- **Migrations:** `npm run db:push` → `drizzle-kit push` (`package.json:11`); `out: ./migrations` (`drizzle.config.ts:4`).
- **Lifecycle:** Each radar build inserts a JSON-serialized snapshot (`server/routes.ts:766-771`); `getLatestRadarSnapshot()` reads `ORDER BY id DESC LIMIT 1` (`server/storage.ts:29-31`).
- **Git ignore:** `data.db`, `data.db-shm`, `data.db-wal`, `data.db-journal` (`.gitignore:6-9`).

### File storage
- None. Static assets are served from `dist/public` via `express.static` (`server/static.ts:14`, `vite.config.ts:17`).

### Caching
- **In-memory snapshot cache:** `memoryCache` with 25s TTL (`server/routes.ts:75,83`).
- **Last-good snapshot cache:** `lastGoodSnapshot` for stale-while-failing fallback (`server/routes.ts:84`, `server/routes.ts:775-785`).
- **In-flight coalescing:** `inflightSnapshot` collapses concurrent `/api/radar` calls onto one build (`server/routes.ts:85`, `server/routes.ts:787-805`).
- **gRPC candidate store:** in-memory `Map` with 45-min TTL, 1000-entry cap (`server/grpcStream.ts:75-76`, `server/grpcStream.ts:170-238`).
- **SVS auth cooldown:** 5-minute in-memory window after 401/403 (`server/svs.ts:14`).

## Authentication & Identity

- **End-user auth:** None. The app is a public-read dashboard; no login UI, no sessions, no cookies.
- **Passport / express-session / memorystore:** Listed in `package.json` and `script/build.ts:16-24` allowlist but never imported in source — dead packages.
- **Service-to-service auth:**
  - SVS API: `Authorization: Bearer ${SVS_API_KEY}` (`server/svs.ts:60`).
  - SVS RPC: API key in URL query string (operator-supplied) (`.env.example:11`).
  - SVS gRPC: `X-Token` constructor arg, optional (`server/grpcStream.ts:439,546`).
  - DexScreener: unauthenticated.

## Monitoring & Observability

### Health endpoints
- **`GET /api/svs/health`** (`server/routes.ts:856-880`) — overall SVS API + RPC + gRPC status, includes `authCooldown` and gRPC `diagnostics`. Wrapped in 6s deadline (`server/routes.ts:82,878`).
- **`GET /api/grpc/status`** (`server/routes.ts:882-891`) — synchronous gRPC worker snapshot: `status`, `activeStreams`, `filters`, `lastEventAt`, `eventsReceived`, `eventsPerMinute`, `candidateCount`, `watchedPrograms`, `diagnostics` (parse counters, ignored-mint reasons, last-candidate age) — see `server/grpcStream.ts:564-597`.
- **`GET /api/radar`** (`server/routes.ts:893-911`) — main snapshot; falls back to last persisted snapshot on failure. Hard build deadline 12s (`server/routes.ts:81`).
- **`GET /api/radar/stream`** (`server/routes.ts:913-939`) — Server-Sent Events stream, see Webhooks section.

### Error tracking
- Not detected. No Sentry, Bugsnag, Rollbar, or Datadog SDK in source.
- Express error middleware logs to `console.error` and returns JSON (`server/index.ts:94-105`).

### Logs
- Structured request log emitted by middleware: `${time} [${source}] ${method} ${path} ${status} in ${ms}ms :: <summary>` (`server/index.ts:28-36`, `server/index.ts:67-89`).
- Per-route summarization avoids dumping 50–200KB radar JSON into logs (`server/index.ts:42-65`).
- gRPC errors logged via `console.error("[grpc] ...")` (`server/grpcStream.ts:502`, `server/grpcStream.ts:533`).
- No log shipper / aggregator integration detected.

## CI/CD & Deployment

### CI
- Not detected. No `.github/`, `.gitlab-ci.yml`, `.circleci/`, or other CI config files in repo root.

### Deployment target
- **Railway**, documented in `README.md:44-51` and `README.md:64-87`.
- **Build command:** `npm install && npm run build` → runs `script/build.ts` (`package.json:8`).
- **Start command:** `npm start` → `NODE_ENV=production node dist/index.cjs` (`package.json:9`).
- **Build output:** `dist/public/` (Vite SPA) + `dist/index.cjs` (esbuild CJS server bundle) (`vite.config.ts:17`, `script/build.ts:51`).
- **Runtime port:** Reads `PORT` env, defaults to 5000, binds `0.0.0.0`, `reusePort: true` (`server/index.ts:121-127`).
- **Static serving:** Production serves `dist/public` via `express.static`; SPA fallback to `index.html` for any non-API route (`server/static.ts:14-19`). Development swaps in Vite middleware mode (`server/vite.ts:11-30`, `server/index.ts:110-115`).
- **No Dockerfile, no Procfile, no `railway.json`, no `nixpacks.toml`, no `vercel.json`** in the repository.

## Environment Configuration

### Required
- None for the app to boot — radar runs on the public DexScreener feed without any SVS keys (`README.md:33`, `README.md:160`).

### Optional (reads from `process.env`)
- `PORT` — default `5000` (`server/index.ts:121`).
- `NODE_ENV` — `production` switches to static serving + node CJS bundle (`server/index.ts:110`).
- `SVS_API_BASE_URL` — default `https://free.api.solanavibestation.com` (`server/svs.ts:5,49`).
- `SVS_API_KEY` — gates `/metadata`, `/price`, `/mint_info` enrichment (`server/svs.ts:50,58`).
- `SVS_RPC_HTTP_URL` — JSON-RPC for health probe (`server/svs.ts:51,260`).
- `SVS_RPC_WS_URL` — declared but unused beyond presence check (`server/svs.ts:52`).
- `SVS_GRPC_ENDPOINT` — gates the entire gRPC worker (`server/grpcStream.ts:545`).
- `SVS_GRPC_X_TOKEN` — optional gRPC auth token (`server/grpcStream.ts:546`).
- `ENABLE_GRPC_DEX_POOLS` — default `true` (`server/grpcStream.ts:91`).
- `ENABLE_RAYDIUM_AMM_V4` — default `false` (`server/grpcStream.ts:92`).
- `WATCH_PUMPSWAP_PROGRAM`, `WATCH_RAYDIUM_LAUNCHLAB_PROGRAM`, `WATCH_PUMPFUN_PROGRAM`, `WATCH_RAYDIUM_CPMM_PROGRAM`, `WATCH_RAYDIUM_CLMM_PROGRAM`, `WATCH_RAYDIUM_AMM_V4_PROGRAM` — set blank to disable each program (`server/grpcStream.ts:100,127`).
- `SVS_STAKED_RPC_URL`, `SVS_LIGHTSPEED_URL` — listed in `.env.example:41-42` for "Phase 2 only", **not read by current source**.

### Secrets location
- Local: `.env` file (loaded by `dotenv/config` in `server/index.ts:1`); template at `.env.example` (existence verified, contents not read here).
- `.env` and `.env.*` are git-ignored except `.env.example` (`.gitignore:11-13`).
- Production: Railway environment variables tab (`README.md:47`).
- **Hard rule:** No `VITE_`-prefixed secrets — all SVS keys are backend-only (`README.md:158`, `server/svs.ts:1-3`, `server/grpcStream.ts:1-3`).

## Webhooks & Callbacks

### Incoming webhooks
- None. No webhook routes defined; only the four `/api/*` GET endpoints exist (`server/routes.ts:856,882,893,913`).

### Outgoing callbacks
- None.

### Server-Sent Events (SSE)
- **`GET /api/radar/stream`** (`server/routes.ts:913-939`).
  - Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive` (`server/routes.ts:914-918`).
  - Emits `event: radar` / `event: error` frames every `REFRESH_SECONDS = 20` seconds (`server/routes.ts:76`, `server/routes.ts:925-934`).
  - Connection cleanup on `req.close` (`server/routes.ts:935-938`).
- Frontend consumes via native `EventSource(`${EVENT_BASE}/api/radar/stream`)` (`client/src/App.tsx:660`).

### Long-lived inbound stream (gRPC, server-side)
- The Yellowstone gRPC bidirectional stream from SVS Geyser is the only persistent upstream connection (`server/grpcStream.ts:432-518`). It is launched once at boot from `server/index.ts:131` via `startGrpcWorker()`.

*Integration audit: 2026-05-04*
