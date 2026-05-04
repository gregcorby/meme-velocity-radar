<!-- refreshed: 2026-05-04 -->
# Architecture

**Analysis Date:** 2026-05-04

## System Overview

```text
                          ┌─────────────────────────────────────────────────┐
                          │                  Browser (SPA)                  │
                          │  React 18 + Wouter (hash routing)               │
                          │  TanStack Query · Tailwind · Radix UI           │
                          │  EventSource (SSE) ─→ /api/radar/stream         │
                          └─────────────────────────────────────────────────┘
                                              │  fetch / SSE
                                              ▼
                          ┌─────────────────────────────────────────────────┐
                          │             Express 5 HTTP Server               │
                          │             server/index.ts                     │
                          │   ┌──────────────┐   ┌──────────────────────┐   │
                          │   │ JSON middleware  │ Vite dev middleware  │   │
                          │   │ + summarized log │ (dev) / static (prod)│   │
                          │   └──────┬───────┘   └──────────┬───────────┘   │
                          │          │ registerRoutes()      │              │
                          │          ▼                       │              │
                          │   ┌──────────────────────────────▼──────────┐   │
                          │   │ Routes (server/routes.ts)               │   │
                          │   │  GET /api/radar          (snapshot)     │   │
                          │   │  GET /api/radar/stream   (SSE)          │   │
                          │   │  GET /api/svs/health     (health probe) │   │
                          │   │  GET /api/grpc/status    (gRPC status)  │   │
                          │   └────┬───────────┬──────────────┬─────────┘   │
                          └────────┼───────────┼──────────────┼─────────────┘
                                   │           │              │
              ┌────────────────────┘           │              └────────────────┐
              ▼                                ▼                               ▼
   ┌─────────────────────┐        ┌────────────────────────┐     ┌──────────────────────────┐
   │ DexScreener (HTTPS) │        │ Solana Vibe Station    │     │ Yellowstone Geyser gRPC  │
   │  /token-boosts      │        │  /metadata /price      │     │ (server/grpcStream.ts)    │
   │  /token-profiles    │        │  /mint_info  REST      │     │ background worker, fans  │
   │  /token-pairs       │        │  (server/svs.ts)       │     │ candidate mints into RAM │
   │  /metas/trending    │        └────────────────────────┘     └──────────────────────────┘
   └─────────────────────┘                                                   │
                                                                             ▼
                                                              ┌─────────────────────────────┐
                                                              │  In-process candidate cache │
                                                              │  (Map<mint, GrpcCandidate>) │
                                                              └─────────────────────────────┘

                                          ┌──────────────────────────────────┐
                                          │ SQLite (better-sqlite3 + Drizzle)│
                                          │   data.db · radar_snapshots      │
                                          │   server/storage.ts              │
                                          └──────────────────────────────────┘

   ┌────────────────────────────────────────────────────────────────────────────────────┐
   │ shared/schema.ts  — Drizzle table + Zod schemas (TokenSignal, RadarSnapshot, …)    │
   │ Imported by both client (`@shared`) and server for end-to-end type contract.       │
   └────────────────────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Express bootstrap | HTTP listener, JSON middleware, response-summary logging, error handler, env-aware Vite/static wiring, gRPC worker boot | `server/index.ts` |
| Route handlers | Defines `/api/radar`, `/api/radar/stream`, `/api/svs/health`, `/api/grpc/status`; orchestrates snapshot build with deadlines and stale fallbacks | `server/routes.ts` |
| Snapshot builder | Pulls DexScreener feeds, merges gRPC candidates and SVS enrichment, scores tokens (velocity/virality/upside/risk), persists snapshot | `server/routes.ts` (`buildSnapshot`) |
| SVS client | Authenticated batch calls to `/metadata`, `/price`, `/mint_info`; auth-cooldown guard; RPC and API health probes | `server/svs.ts` |
| gRPC stream worker | Background Yellowstone Geyser subscription; parses transactions into `GrpcCandidate` map with TTL/eviction; exposes status + diagnostics | `server/grpcStream.ts` |
| Storage layer | SQLite (better-sqlite3 + Drizzle) `radar_snapshots` insert/getLatest | `server/storage.ts` |
| Static server | Serves `dist/public` and SPA fallback in production | `server/static.ts` |
| Vite dev integration | Mounts Vite middleware in development, transforms `index.html` per request | `server/vite.ts` |
| Build script | Cleans `dist/`, runs `vite build`, esbuilds server to `dist/index.cjs` with selective bundling | `script/build.ts` |
| Shared schema | Drizzle table + Zod types shared between client and server | `shared/schema.ts` |
| React entry | Mounts `<App />`, ensures hash route default | `client/src/main.tsx` |
| App shell + dashboard | TanStack Query + Wouter routing, hash router, SSE consumer, the entire radar dashboard UI | `client/src/App.tsx` |
| Query client | Default `QueryFunction` that fetches `queryKey.join("/")`, wraps `apiRequest` | `client/src/lib/queryClient.ts` |
| UI primitives | shadcn/Radix + Tailwind component library | `client/src/components/ui/*` |
| Hooks | `use-toast`, `use-mobile` | `client/src/hooks/*` |

## Pattern Overview

**Overall:** Vite + React 18 SPA + Express 5 API + Drizzle/SQLite single-process monorepo, with a long-lived background gRPC worker enriching an in-memory candidate cache.

**Key Characteristics:**
- Single Node process serves both API and (via Vite middleware in dev / static files in prod) the SPA on one port.
- Snapshot pipeline is **pull-based** (every poll/SSE tick rebuilds via DexScreener + SVS) but enriched by **push-based** gRPC candidates living in process memory.
- Hard deadlines (`RADAR_BUILD_DEADLINE_MS`, `HEALTH_DEADLINE_MS`) plus an in-flight promise singleton coalesce concurrent requests and degrade gracefully to last-known-good snapshots.
- End-to-end types come from `shared/schema.ts` (Drizzle table + Zod), imported via the `@shared/*` alias on both sides.
- No auth on API routes; secrets (`SVS_API_KEY`, `SVS_GRPC_X_TOKEN`) live only on the server side and are gated behind `server/svs.ts` / `server/grpcStream.ts` (explicit "backend-only" comments warn against client imports).

## Layers

**Client (presentation):**
- Purpose: Render the radar dashboard, poll/stream snapshots, decode memes, allow filtering/sorting/CSV export.
- Location: `client/src/`
- Contains: One main page (`App.tsx`), one fallback page (`pages/not-found.tsx`), shadcn/Radix UI primitives, two hooks, two lib helpers.
- Depends on: `@shared/schema` types, `@tanstack/react-query`, `wouter`, `recharts`, native `fetch` and `EventSource`.
- Used by: Browser (mounted via `client/src/main.tsx` from `client/index.html`).

**Shared (contract):**
- Purpose: Single source of truth for DB table shape and API payload types.
- Location: `shared/schema.ts`
- Contains: Drizzle `radarSnapshots` table, Zod schemas for `TokenSignal`/`MetaSignal`/`RadarSnapshot`/`GrpcSummary`, exported TS types.
- Depends on: `drizzle-orm/sqlite-core`, `drizzle-zod`, `zod`.
- Used by: Both `server/*` and `client/src/*`.

**Server (application + integration):**
- Purpose: HTTP endpoints, scoring/snapshot orchestration, third-party integrations, persistence, dev-mode SPA hosting.
- Location: `server/`
- Contains: Bootstrap (`index.ts`), routes/scoring (`routes.ts`), SVS REST (`svs.ts`), gRPC worker (`grpcStream.ts`), storage (`storage.ts`), Vite/static glue (`vite.ts`, `static.ts`).
- Depends on: `express`, `better-sqlite3`, `drizzle-orm`, `@triton-one/yellowstone-grpc`, `bs58`, `vite` (dev only).
- Used by: Browser via HTTP; nothing else imports server modules.

**Persistence:**
- Purpose: Durable last-known snapshot for stale-while-degraded fallbacks.
- Location: `data.db` (gitignored), schema in `shared/schema.ts`, DAO in `server/storage.ts`.
- Contains: `radar_snapshots(id, captured_at, payload)` — `payload` is the JSON-serialized `RadarSnapshot`.

## Data Flow

### Primary Request Path (radar snapshot)

1. Browser mounts `<App />` (`client/src/main.tsx:9`) and `RadarHome` issues `useQuery({ queryKey: ["/api/radar"] })` (`client/src/App.tsx:639`).
2. Default `QueryFunction` calls `fetch("/api/radar")` via `getQueryFn` (`client/src/lib/queryClient.ts:32`).
3. Express receives the request; the JSON+logging middleware records method/path (`server/index.ts:67`).
4. `app.get("/api/radar")` calls `buildSnapshotWithDeadline(force)` which coalesces concurrent calls into a single in-flight promise (`server/routes.ts:893`, `:787`).
5. `buildSnapshot` fetches four DexScreener endpoints in parallel, pulls recent gRPC candidates from the in-memory worker, calls `fetchSvsMetadata`/`fetchSvsPrices`/`fetchSvsMintInfo`, scores each pair via `scorePair`, and synthesizes gRPC-only entries with `buildGrpcOnlyToken` (`server/routes.ts:538`).
6. Result is cached in memory (`memoryCache`, `lastGoodSnapshot`) and persisted via `storage.saveRadarSnapshot` (`server/storage.ts:24`).
7. Response is JSON-encoded; the response-summary middleware logs `tokens=N sources=M grpc=…` (`server/index.ts:42`).
8. React Query stores the result; `RadarHome` derives `visibleTokens` and renders `TokenCard` list + `DetailPanel` (`client/src/App.tsx:671`).

### Live Stream Path (SSE)

1. When `live` is true, the browser opens `EventSource("/api/radar/stream")` (`client/src/App.tsx:660`).
2. Server writes `text/event-stream` headers, calls `buildSnapshot(true)`, emits `event: radar`/`data: …` every `REFRESH_SECONDS` (20s) (`server/routes.ts:913`).
3. Client replaces `streamSnapshot` state on each event; React rerenders with the merged `snapshot = streamSnapshot ?? data` (`client/src/App.tsx:656`).

### Background gRPC Path

1. `startGrpcWorker()` is invoked once after `httpServer.listen` (`server/index.ts:131`).
2. The worker subscribes to Yellowstone Geyser, parses transactions, deduplicates against `STABLE_BLOCKLIST`, and inserts/refreshes `GrpcCandidate` entries with TTL eviction (`server/grpcStream.ts`).
3. `getRecentGrpcCandidates(40)` and `getGrpcStatus()` are read by `buildSnapshot` and `/api/grpc/status` to expose live mints (`server/routes.ts:583`, `:882`).

### State Management

- **Server-side, ephemeral:** `memoryCache`, `lastGoodSnapshot`, `inflightSnapshot`, `authRejectedUntil`, gRPC candidate `Map`. All process-local; no Redis/cross-process coordination.
- **Server-side, durable:** `radar_snapshots` table in `data.db`, only ever read for fallback and only ever written from `buildSnapshot`.
- **Client-side:** TanStack Query (`/api/radar`, `/api/svs/health`, `/api/grpc/status`) plus React `useState` for filters/sort/search/selected token. Theme is local component state, not persisted.

## Key Abstractions

**RadarSnapshot:**
- Purpose: The full JSON contract returned by `/api/radar`; carries tokens, metas, source health, and gRPC summary.
- Examples: `shared/schema.ts:101` (`radarSnapshotSchema`), persisted in `radar_snapshots.payload`, consumed by `client/src/App.tsx`.
- Pattern: Zod schema → inferred TS type → reused across layers.

**TokenSignal:**
- Purpose: One scored token row with raw metrics, derived ratios, narrative copy, and `{velocity, virality, upside, risk, final}` scores.
- Examples: produced by `scorePair` (`server/routes.ts:263`) and `buildGrpcOnlyToken` (`server/routes.ts:425`).
- Pattern: Pure-function builder that fuses DexScreener, profile, and SVS records into a single normalized record.

**GrpcCandidate:**
- Purpose: Lightweight in-memory representation of a mint observed via Geyser before it has a DEX pair.
- Examples: `server/grpcStream.ts:47`.
- Pattern: TTL-bounded `Map` with eviction; exported via `getRecentGrpcCandidates` / `getGrpcStatus`.

**withDeadline:**
- Purpose: Race a promise against a timer to guarantee bounded latency on user-facing endpoints.
- Examples: `server/routes.ts:87`.
- Pattern: Resolve-only timeout wrapper with a fallback factory.

**Storage interface:**
- Purpose: Pluggable snapshot persistence (`saveRadarSnapshot` / `getLatestRadarSnapshot`).
- Examples: `IStorage` + `DatabaseStorage` (`server/storage.ts:19`).
- Pattern: Interface-first with single SQLite implementation.

## Entry Points

**Server entry (`npm run dev` / `npm start`):**
- Location: `server/index.ts`
- Triggers: `tsx server/index.ts` in dev, `node dist/index.cjs` in prod.
- Responsibilities: Configure Express, register routes, start HTTP listener on `PORT` (default 5000) and `0.0.0.0`, bootstrap gRPC worker, set up Vite middleware (dev) or static fallback (prod).

**Client entry:**
- Location: `client/src/main.tsx`
- Triggers: `<script type="module" src="/src/main.tsx">` in `client/index.html`.
- Responsibilities: Default the URL hash to `#/`, mount `<App />` into `#root`, import global CSS.

**Build entry:**
- Location: `script/build.ts`
- Triggers: `npm run build`.
- Responsibilities: Wipe `dist/`, run `vite build` (writes `dist/public`), esbuild server to `dist/index.cjs` with allowlisted bundled deps.

**DB push entry:**
- Location: `drizzle.config.ts` consumed by `drizzle-kit push`.
- Triggers: `npm run db:push`.
- Responsibilities: Sync `shared/schema.ts` against `./data.db`.

## Architectural Constraints

- **Threading:** Single Node.js event loop. No worker threads. The gRPC stream is async I/O on the same loop, which is why `buildSnapshot` defends with `withDeadline` and a `hardDeadline` race in `fetchJson` against event-loop starvation (`server/routes.ts:139`).
- **Global state:** Module-level mutable singletons in `server/routes.ts` (`memoryCache`, `lastGoodSnapshot`, `inflightSnapshot`) and `server/svs.ts` (`authRejectedUntil`, `lastAuthRejectStatus`) and `server/grpcStream.ts` (candidate map, status). `server/storage.ts` opens a process-wide `Database("data.db")` at import time.
- **Single-port deployment:** Comment in `server/index.ts:117` calls out that only `PORT` is reachable; both API and SPA must coexist on it.
- **Circular imports:** None detected. `routes.ts → svs.ts`, `routes.ts → grpcStream.ts`, `routes.ts → storage.ts`, and `storage.ts → @shared/schema` all flow one direction.
- **Hash-only routing:** `client/src/main.tsx` forces `window.location.hash = "#/"` and `App.tsx` uses `useHashLocation`, so no server-side route handling is needed for SPA links.

## Anti-Patterns

### Hardcoded build-time placeholder for API base URL

**What happens:** `client/src/lib/queryClient.ts:3` and `client/src/App.tsx:49` use `const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__"` to detect whether a deploy substituted the literal string `__PORT_5000__`.
**Why it's wrong:** The placeholder is opaque, isn't documented in `.env.example`, and silently falls back to a relative URL. New environments that genuinely need a different host will not know to patch the literal.
**Do this instead:** Use a real Vite env variable (`import.meta.env.VITE_API_BASE`) and document it in `.env.example`.

### Single-file mega-component for the dashboard

**What happens:** `client/src/App.tsx` is ~925 lines and contains the brand logo, badges, score pill, token card, detail panel, meta rail, snapshot bar, CSV export, the page itself, the router, and the `<App>` provider tree.
**Why it's wrong:** Hard to test in isolation, encourages prop drilling, and forces re-renders to re-evaluate large memoized blocks.
**Do this instead:** Split into `client/src/pages/Radar.tsx` and `client/src/components/radar/{Logo,SvsBadge,GrpcBadge,ScorePill,TokenCard,DetailPanel,MetaRail,SnapshotBar}.tsx` mirroring the existing `components/ui/` convention.

### Implicit dependency on a freshly-on-disk SQLite file

**What happens:** `server/storage.ts:7` opens `new Database("data.db")` relative to the **current working directory**, not the project root, and creates the table inline if missing.
**Why it's wrong:** Running the server from another directory creates a second `data.db` and silently disables the stale-fallback path. Migrations are also bypassed because the `CREATE TABLE` lives outside Drizzle.
**Do this instead:** Resolve `data.db` relative to a known root (e.g. `path.resolve(import.meta.dirname, "..", "data.db")`) and keep the schema as the only source of truth, applied via `npm run db:push`.

### `buildSnapshot` does too much in one function

**What happens:** A ~230-line function (`server/routes.ts:538`) handles fetching, dedup, scoring, SVS enrichment, mint-info enrichment, gRPC fallback synthesis, sorting/truncation, persistence, and caching.
**Why it's wrong:** Hard to unit-test, every change risks a regression in an unrelated stage, and observability is coarse-grained.
**Do this instead:** Extract `fetchDexFeeds`, `mergeProfiles`, `enrichWithSvs`, `composeTokens`, `persistSnapshot` into named helpers and keep `buildSnapshot` as the orchestrator.

## Error Handling

**Strategy:** Defensive, non-throwing happy paths. Most network calls return `{ ok: true, data } | { ok: false, error }` discriminated unions; downstream code records the failure into `sourceHealth` and continues.

**Patterns:**
- Hard deadlines on every external boundary: `fetchJson` has dual `AbortController` + `setTimeout` race (`server/routes.ts:139`), `withDeadline` wraps `buildSnapshot` and `getSvsHealthReport` (`server/routes.ts:87`).
- Auth-cooldown circuit breaker: 5-minute pause on SVS calls after a 401/403 (`server/svs.ts:14`), with health probes still allowed to detect recovery.
- Stale-while-error fallback chain: in-memory `lastGoodSnapshot` → `memoryCache.snapshot` → `storage.getLatestRadarSnapshot()` → empty-but-shaped snapshot (`server/routes.ts:750`, `:806`, `:898`).
- Express terminal error handler converts uncaught errors into JSON `{ message }` with a sane status (`server/index.ts:94`).
- Client-side: TanStack Query exposes `error`; `RadarHome` renders an inline `<Card>` error state, image loads degrade to initial-letter avatars (`client/src/App.tsx:233`, `:810`).

## Cross-Cutting Concerns

**Logging:**
- Server-only `log()` helper with sanitized response summaries (`server/index.ts:28`, `:42`) — radar payloads are reduced to `tokens=N sources=M grpc=…` to avoid Railway log spam.
- `console.error` for the terminal Express handler.
- gRPC worker emits `[grpc] …` lines through the same `log()`.

**Validation:**
- Zod schemas in `shared/schema.ts` define the contract but are **not** runtime-validated on the wire — server objects are constructed to satisfy the type, client calls `JSON.parse` and trusts the shape.
- Form-level validation isn't needed because the UI is read-only.

**Authentication:**
- None on HTTP routes. The deps include `passport`, `passport-local`, `express-session`, and `memorystore`, but no usage was detected in `server/*`.
- Server-to-SVS auth uses `Authorization: Bearer ${SVS_API_KEY}` only (`server/svs.ts:60`); gRPC uses `SVS_GRPC_X_TOKEN` consumed only inside `server/grpcStream.ts`.

**Secrets:**
- Loaded via `dotenv/config` at the top of `server/index.ts`. `.env*` files are gitignored except `.env.example`. Never imported from `client/*`.

---

*Architecture analysis: 2026-05-04*
