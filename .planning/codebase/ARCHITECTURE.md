<!-- refreshed: 2026-05-05 -->
# Architecture

**Analysis Date:** 2026-05-05

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                         External Data Sources                                │
├────────────────────┬────────────────────┬──────────────────┬────────────────┤
│  SVS Geyser gRPC   │    SVS REST API    │   SVS RPC HTTP   │  DexScreener   │
│ (Yellowstone/live) │ metadata/price/    │  (health probe)  │  public feed   │
│                    │ mint_info          │                  │ (always-on)    │
└────────┬───────────┴────────┬───────────┴──────────┬───────┴────────┬───────┘
         │                   │                       │                │
         ▼                   │                       │                │
┌────────────────────┐       │                       │                │
│  gRPC Worker       │       │                       │                │
│  server/grpcStream │       │                       │                │
│  CandidateStore    │       │                       │                │
│  (45m TTL, 1k cap) │       │                       │                │
└────────┬───────────┘       │                       │                │
         │                   │                       │                │
         ▼                   ▼                       ▼                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Radar Snapshot Builder                                   │
│                       server/routes.ts                                       │
│  buildSnapshot() → scorePair() / buildGrpcOnlyToken() → RadarSnapshot        │
│  In-process cache: 25s TTL │ inflight coalescing │ 12s build deadline        │
└──────────────────────────┬──────────────────────────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
┌─────────────────────────┐   ┌────────────────────────────────────────────┐
│  SQLite (better-sqlite3) │   │  Express Routes (server/routes.ts)          │
│  server/storage.ts       │   │  GET /api/radar          (poll + deadline)  │
│  data.db (stale fallback)│   │  GET /api/radar/stream   (SSE, 20s push)    │
└─────────────────────────┘   │  GET /api/svs/health     (health probe)      │
                               │  GET /api/grpc/status    (sync status)       │
                               └───────────────────────┬────────────────────┘
                                                       │
                                                       ▼
                               ┌────────────────────────────────────────────┐
                               │  React SPA (client/src/App.tsx)             │
                               │  TanStack Query polls /api/radar            │
                               │  SSE EventSource (/api/radar/stream)        │
                               │  Badges: SVS health · gRPC status           │
                               └────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Express entrypoint | HTTP server boot, middleware wiring, gRPC worker start | `server/index.ts` |
| Radar routes | Snapshot builder, scorePair, meme classification, SSE, deadline guards | `server/routes.ts` |
| SVS integration | Token metadata, price, mint_info fetches, auth cooldown, RPC/API health probes | `server/svs.ts` |
| gRPC worker | Yellowstone subscription, transaction parsing, CandidateStore, diagnostics | `server/grpcStream.ts` |
| Storage layer | SQLite snapshot persistence via Drizzle ORM | `server/storage.ts` |
| Static / Vite glue | Production static serve; Vite HMR middleware in dev | `server/static.ts`, `server/vite.ts` |
| Shared schema | Zod schemas + TypeScript types for RadarSnapshot, TokenSignal, MetaSignal, GrpcSummary | `shared/schema.ts` |
| React SPA | Dashboard UI, filter/sort/search, detail panel, CSV export, live SSE client | `client/src/App.tsx` |
| Query client | TanStack Query configuration, apiRequest helper | `client/src/lib/queryClient.ts` |

## Pattern Overview

**Overall:** Monolithic full-stack Node/Express application with a co-located Vite/React SPA. Single process hosts the web server, live gRPC background worker, and snapshot builder. One HTTP port serves both API endpoints and the client SPA.

**Key Characteristics:**
- Pull-based polling (DexScreener) merged with push-based live ingestion (gRPC worker) into a unified in-memory candidate set
- Single authoritative data shape: `RadarSnapshot` (defined in `shared/schema.ts`) consumed by both API routes and the React client
- Defense-in-depth resilience: in-process 25s cache → SQLite stale fallback → empty well-formed response; never hangs under deadline
- No authentication on any route; the server exposes no secret values to the browser (no `VITE_`-prefixed env vars)
- All client<->server communication is JSON over REST or SSE; no WebSocket at the application layer

## Layers

**gRPC Ingestion Layer:**
- Purpose: Subscribe to live Solana transactions and maintain a short-lived mint candidate cache
- Location: `server/grpcStream.ts`
- Contains: Yellowstone gRPC client, filter builder, `CandidateStore` class, transaction parser, diagnostics counters
- Depends on: `@triton-one/yellowstone-grpc`, `bs58`, env vars `SVS_GRPC_ENDPOINT` / `SVS_GRPC_X_TOKEN`
- Used by: `server/routes.ts` (`getRecentGrpcCandidates`, `getGrpcStatus`)

**Radar Build Layer:**
- Purpose: Assemble `RadarSnapshot` from all data sources, score each token, classify meme type
- Location: `server/routes.ts` (functions: `buildSnapshot`, `scorePair`, `buildGrpcOnlyToken`, `classifyMeme`)
- Contains: DexScreener API calls via `fetchJson`, SVS enrichment integration, scoring math, in-process cache, inflight coalescing, deadline wrapper
- Depends on: `server/svs.ts`, `server/grpcStream.ts`, `server/storage.ts`, `shared/schema.ts`
- Used by: Express route handlers registered in `registerRoutes`

**SVS Enrichment Layer:**
- Purpose: Optional enrichment of candidate mints with metadata, price windows, mint authority info, and health reporting
- Location: `server/svs.ts`
- Contains: `postBatch` helper, auth cooldown state machine, RPC/API health probes, `getSvsHealthReport`
- Depends on: env vars `SVS_API_KEY`, `SVS_API_BASE_URL`, `SVS_RPC_HTTP_URL`, `SVS_GRPC_ENDPOINT`
- Used by: `server/routes.ts`

**Storage Layer:**
- Purpose: Persist the most recent radar snapshot to SQLite for use as stale fallback on upstream failure
- Location: `server/storage.ts`
- Contains: `DatabaseStorage` class implementing `IStorage`, Drizzle ORM setup, WAL mode pragma
- Depends on: `better-sqlite3`, `drizzle-orm`, `shared/schema.ts` (table definitions)
- Used by: `server/routes.ts`

**Shared Schema Layer:**
- Purpose: Single source of truth for all data types crossing the server/client boundary
- Location: `shared/schema.ts`
- Contains: Drizzle table (`radarSnapshots`), Zod schemas (`tokenSignalSchema`, `radarSnapshotSchema`, `grpcSummarySchema`), TypeScript type exports
- Used by: both `server/` and `client/src/`

**React Client Layer:**
- Purpose: Radar dashboard UI — displays scored tokens, meta trends, health badges, and supports sort/filter/search
- Location: `client/src/App.tsx` (monolithic), `client/src/lib/queryClient.ts`, `client/src/components/ui/`
- Contains: All UI components inline in `App.tsx` (RadarHome, TokenCard, DetailPanel, MetaRail, SnapshotBar, ScorePill, etc.), TanStack Query integration, SSE EventSource client
- Depends on: `shared/schema.ts` types, `@tanstack/react-query`, Radix UI primitives, Recharts, Wouter router
- Used by: browser only

## Data Flow

### Primary Radar Request Path

1. Browser polls or SSE receives → hits `GET /api/radar` or `GET /api/radar/stream` (`server/routes.ts:893`)
2. `buildSnapshotWithDeadline(force)` called — coalesces concurrent requests onto single `inflightSnapshot` promise (`server/routes.ts:787`)
3. `buildSnapshot()` checks 25s in-process `memoryCache`; if fresh, returns immediately (`server/routes.ts:539`)
4. Four parallel DexScreener fetches: boosts, profiles, recent-updates, trending metas (`server/routes.ts:542`)
5. `getRecentGrpcCandidates(40)` merges live gRPC mints into candidate priority list (`server/routes.ts:583`)
6. Up to 14 candidates selected; parallel `mapPool` fetches DexScreener pair data (7 concurrent) (`server/routes.ts:598`)
7. Optional SVS batch fetches for metadata and price (`server/svs.ts:fetchSvsMetadata`, `fetchSvsPrices`)
8. `scorePair()` computes velocity/virality/upside/risk for each pair, `classifyMeme()` decodes meme type
9. gRPC-only candidates (no DexScreener pair) built via `buildGrpcOnlyToken()` with conservative scores
10. Tokens sorted by final score, capped at 24; top 6 get optional `fetchSvsMintInfo` enrichment
11. Snapshot written to SQLite via `storage.saveRadarSnapshot()` as fire-and-forget (`server/routes.ts:766`)
12. Snapshot returned as JSON; SSE path writes `event: radar\ndata: {...}\n\n`

### gRPC Live Ingestion Path

1. `startGrpcWorker()` called at server startup after HTTP listen (`server/index.ts:131`)
2. `runStreamLoop()` connects Yellowstone client, subscribes with launchpad + DEX pool filters (`server/grpcStream.ts:521`)
3. Each `data` event parsed by `processTransactionUpdate()` — extracts token-balance mints, drops stablecoins
4. Valid mints upserted into `CandidateStore` (in-memory Map with 45m TTL, 1000 max entries)
5. On next radar build, `getRecentGrpcCandidates(40)` returns top 40 by recency

### Health Probe Path

1. `GET /api/svs/health` triggers `getSvsHealthReport()` under 6s deadline (`server/routes.ts:856`)
2. `probeSvsApiReachability()` and `probeRpcReachability()` run in parallel (`server/svs.ts:362`)
3. gRPC status merged from in-process `getGrpcStatus()` state variables
4. Client polls this endpoint every 60s and renders `SvsBadge` / `GrpcBadge` in header

**State Management (client):**
- TanStack Query with `staleTime: Infinity` and `refetchInterval: false` by default — radar data manually refreshed or pushed via SSE
- `streamSnapshot` state: SSE updates override TanStack Query cache with `useState`
- `selectedId`, `sortMode`, `filterMode`, `search` are local `useState` inside `RadarHome` component

## Key Abstractions

**RadarSnapshot:**
- Purpose: The single product surface — everything the UI renders derives from this object
- Examples: `shared/schema.ts:101` (Zod schema), `server/routes.ts:727` (construction)
- Pattern: Defined once in `shared/schema.ts`, validated by Zod, serialized as JSON through the API

**TokenSignal:**
- Purpose: A single scored meme token candidate with all display and risk fields
- Examples: `shared/schema.ts:33` (schema), `server/routes.ts:263` (`scorePair` returns this)
- Pattern: Constructed from merged DexScreener + SVS + gRPC data; never mutated after sort

**CandidateStore:**
- Purpose: In-memory ring buffer for gRPC-observed mint addresses, keyed by mint, ordered by recency
- Examples: `server/grpcStream.ts:170`
- Pattern: Map with upsert semantics; eviction by TTL + size cap on every write

**GrpcSummary:**
- Purpose: Snapshot of gRPC worker internal state serialized into RadarSnapshot
- Examples: `shared/schema.ts:88` (schema), `server/grpcStream.ts:564` (`getGrpcStatus` returns GrpcStatus)
- Pattern: Read-only projection of module-level state variables in `grpcStream.ts`

**withDeadline:**
- Purpose: Race a promise against a timeout and call a fallback factory if the timeout fires first
- Examples: `server/routes.ts:87` (implementation), `server/routes.ts:806` (used for radar build)
- Pattern: Defensive wrapper used on `/api/radar` build (12s) and `/api/svs/health` probe (6s)

## Entry Points

**HTTP Server:**
- Location: `server/index.ts:91` (IIFE async boot)
- Triggers: `tsx server/index.ts` (dev), `node dist/index.cjs` (prod)
- Responsibilities: Creates Express app, registers routes, sets up Vite or static serving, starts listening, launches gRPC worker

**React SPA:**
- Location: `client/src/main.tsx`
- Triggers: Browser load of `index.html`
- Responsibilities: Mounts `App` into `#root`, initializes hash-based routing, ensures `#/` is set

**gRPC Worker:**
- Location: `server/grpcStream.ts:543` (`startGrpcWorker`)
- Triggers: Called from `server/index.ts:131` after HTTP server is listening
- Responsibilities: Starts reconnect loop, manages Yellowstone subscription, populates CandidateStore

**Build Script:**
- Location: `script/build.ts`
- Triggers: `npm run build`
- Responsibilities: Runs Vite client build then esbuild server bundle to `dist/index.cjs`

## Architectural Constraints

- **Threading:** Single-threaded Node.js event loop. The gRPC stream is async I/O, not a worker thread. The `mapPool` helper controls concurrency of outbound HTTP calls (7 concurrent DexScreener pair fetches, 3 concurrent SVS mint_info fetches).
- **Global state:** Module-level singletons in `server/grpcStream.ts` (status, counters, `candidates` CandidateStore, `WATCH_PROGRAMS`) and `server/routes.ts` (`memoryCache`, `lastGoodSnapshot`, `inflightSnapshot`). These are process-scoped and lost on restart.
- **Circular imports:** No known circular dependency chains. `shared/schema.ts` is a leaf with no server/client imports. `server/routes.ts` imports from `server/svs.ts` and `server/grpcStream.ts` only.
- **Build output:** Server bundles to a single CJS file `dist/index.cjs`; client bundles to `dist/public/`. The production server serves `dist/public/` as static assets from within the same process.
- **No horizontal scaling:** A single process owns the gRPC stream and in-memory state. Deploying multiple instances would result in independent candidate caches and independent snapshot builds with no coordination.
- **No secrets in client:** No `VITE_` env vars are used. API keys are read server-side only. `shared/schema.ts` contains only type definitions, no configuration.

## Anti-Patterns

### gRPC and scoring logic co-located with route handlers

**What happens:** `server/routes.ts` is a 940-line file containing HTTP route handlers, the full snapshot builder (`buildSnapshot`), scoring math (`scorePair`), meme classification (`classifyMeme`), DexScreener fetch helpers (`fetchJson`, `mapPool`), link normalization (`buildLinks`), and all related types.
**Why it's wrong:** Makes isolated testing of scoring logic impossible without standing up routes; any change to scoring requires modifying a route file.
**Do this instead:** Extract `scorePair`, `classifyMeme`, `buildSnapshot`, and `fetchJson` into separate modules (e.g., `server/scorer.ts`, `server/dex.ts`) and keep `server/routes.ts` as a thin registration layer.

### Monolithic App.tsx client

**What happens:** `client/src/App.tsx` is ~800 lines and contains all UI components (TokenCard, DetailPanel, MetaRail, SnapshotBar, ScorePill, TokenAvatar, GrpcBadge, SvsBadge, RadarHome) plus all formatting helpers, inline type definitions that duplicate `shared/schema.ts`, and all query logic.
**Why it's wrong:** No component isolation, no per-component test surface, type duplication between client-local types and shared schema.
**Do this instead:** Split into `client/src/components/TokenCard.tsx`, `client/src/components/DetailPanel.tsx`, etc. Use `shared/schema.ts` types directly instead of re-declaring `SvsHealthReport` and `GrpcStatusReport` locally.

## Error Handling

**Strategy:** Defensive — every external call is wrapped to produce a typed `{ ok: true; data } | { ok: false; error }` result. Failures populate `sourceHealth` on the snapshot rather than aborting the build. Hard deadlines prevent request hangs.

**Patterns:**
- `fetchJson()` in `server/routes.ts` returns tagged union; callers check `.ok` before using `.data`
- `postBatch()` in `server/svs.ts` returns `{ ok: true; map } | { ok: false; error }`; auth 401/403 triggers cooldown
- Route-level try/catch falls back to SQLite snapshot, then returns 502 with message
- gRPC parser errors increment `parseErrorCount` and are swallowed to prevent stream crash
- Express global error handler at `server/index.ts:94` catches unhandled errors and returns 500 JSON

## Cross-Cutting Concerns

**Logging:** Custom `log(message, source)` function in `server/index.ts:28`. API requests logged on response finish via monkey-patched `res.json`. Radar and health responses use `summarizeResponseBody` to emit compact single-line summaries instead of full JSON payloads (prevents log buffer saturation on Railway).

**Validation:** Zod schemas in `shared/schema.ts` define the canonical shape; no runtime validation is applied to incoming API responses from DexScreener or SVS — callers use safe accessor helpers (`n()`, `safeString()`) and optional chaining throughout `server/routes.ts`.

**Authentication:** None. All API endpoints are public. Secret values (SVS_API_KEY, SVS_GRPC_X_TOKEN) are used exclusively server-side and never included in responses.

---

*Architecture analysis: 2026-05-05*
