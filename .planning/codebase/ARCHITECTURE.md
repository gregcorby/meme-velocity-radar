<!-- refreshed: 2026-05-04 -->
# Architecture

**Analysis Date:** 2026-05-04

## System Overview

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                          Browser — React SPA                                 │
│   `client/src/App.tsx`  (radar UI, header badges, CSV export, SSE consumer)  │
└──────────────┬─────────────────────────────────────────────┬─────────────────┘
               │ HTTP /api/radar, /api/svs/health,           │ SSE
               │      /api/grpc/status                       │ /api/radar/stream
               ▼                                             ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                        Single Node / Express process                         │
│                              `server/index.ts`                               │
│                                                                              │
│   ┌────────────────────────┐   ┌──────────────────────────────────────────┐  │
│   │  HTTP routes + scoring │   │   SVS gRPC live worker (Yellowstone)     │  │
│   │   `server/routes.ts`   │◄──┤        `server/grpcStream.ts`            │  │
│   │   • DexScreener fetch  │   │   • subscribes to watched program IDs    │  │
│   │   • SVS enrichment     │   │   • parses token-balance deltas          │  │
│   │   • snapshot builder   │   │   • in-mem candidate cache (45m / 1k)    │  │
│   │   • deadline guards    │   │   • exponential reconnect, 30s keepalive │  │
│   │   • SSE push           │   └──────────────────────────────────────────┘  │
│   └─────────┬──────────────┘                  ▲                              │
│             │                                 │                              │
│             ▼                                 │                              │
│   ┌────────────────────────┐                  │                              │
│   │  SVS REST + RPC client │                  │                              │
│   │     `server/svs.ts`    │                  │                              │
│   │  • metadata/price/mint │                  │                              │
│   │  • RPC health probe    │                  │                              │
│   │  • auth-cooldown logic │                  │                              │
│   └────────────────────────┘                  │                              │
│             │                                 │                              │
│             ▼                                 │                              │
│   ┌────────────────────────┐   ┌─────────────────────────────────────────┐   │
│   │   Snapshot persistence │   │   Vite dev middleware (NODE_ENV=dev)    │   │
│   │   `server/storage.ts`  │   │     `server/vite.ts`                    │   │
│   │   • Drizzle + SQLite   │   │   Static SPA serve (NODE_ENV=production)│   │
│   │   • stale-fallback     │   │     `server/static.ts`                  │   │
│   └─────────┬──────────────┘   └─────────────────────────────────────────┘   │
└─────────────┼────────────────────────────────────────────────────────────────┘
              │
              ▼
       ┌─────────────────┐         ┌────────────────────┐    ┌─────────────────┐
       │  SQLite WAL     │         │  DexScreener API   │    │  SVS Geyser     │
       │  `./data.db`    │         │  (public, no auth) │    │  gRPC + REST    │
       └─────────────────┘         └────────────────────┘    └─────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| HTTP entrypoint | Boots Express + Node `http.Server`, wires JSON/urlencoded body parsers, request-summary logger, error handler, dev-Vite vs static serving, starts the gRPC worker after the port is listening. | `server/index.ts` |
| Routes & snapshot builder | DexScreener scanner, scoring (velocity/virality/upside/risk), meme-narrative decoding, snapshot assembly, deadline guards, SSE stream, stale-fallback path. | `server/routes.ts` |
| SVS REST/RPC client | `getMetadata` / `getPrice` / `getMintInfo` batched POSTs, RPC health probe (`getLatestBlockhash`), auth-cooldown state machine, env-driven config (`getSvsConfig`). | `server/svs.ts` |
| gRPC live worker | Yellowstone subscription, watched-program filter management, token-balance parser, in-memory candidate cache + diagnostics counters, reconnect + keepalive, sanitised status export. | `server/grpcStream.ts` |
| Storage | `DatabaseStorage.saveRadarSnapshot()` / `getLatestRadarSnapshot()` over Drizzle + better-sqlite3, `WAL` journal mode, inline `CREATE TABLE IF NOT EXISTS`. | `server/storage.ts` |
| Static SPA serve (prod) | Resolves `__dirname/public` relative to the bundled `dist/index.cjs`, serves built assets, falls through to `index.html`. | `server/static.ts` |
| Vite middleware (dev) | Wraps Vite in middleware mode, mounts `vite.middlewares`, transforms `client/index.html` per request with a fresh `nanoid()` cache-buster on `main.tsx`. | `server/vite.ts` |
| Shared schema | Zod schemas + inferred TS types for `RadarSnapshot`, `TokenSignal`, `MetaSignal`, `GrpcSummary`; Drizzle table for `radar_snapshots`. Imported by both server and client via `@shared/*`. | `shared/schema.ts` |
| Build script | Two-stage build: `vite build` for the client, `esbuild` for the server (single minified CJS bundle, hard-coded allowlist of bundled deps). | `script/build.ts` |
| Client entrypoint | Mounts React root, normalises `window.location.hash` to `#/` so the hash router has a value to read on first paint. | `client/src/main.tsx` |
| Client app shell | Single-file SPA: theme handling, query client, header (logo + badges), radar grid, detail sheet, snapshot bar, CSV export, SSE consumption, score formatting. | `client/src/App.tsx` |
| HTTP query client | Thin wrapper around `fetch` for TanStack Query — `apiRequest`, `getQueryFn`. Resolves API base from a build-time placeholder. | `client/src/lib/queryClient.ts` |
| Toast hook | Local toast store + reducer hook, derived from shadcn/ui's `use-toast` recipe. | `client/src/hooks/use-toast.ts` |
| Mobile breakpoint hook | `useIsMobile()` boolean from a `matchMedia` listener. | `client/src/hooks/use-mobile.tsx` |
| Class-name util | `cn()` = `twMerge(clsx(...))`. Used by every shadcn/ui component. | `client/src/lib/utils.ts` |
| 404 page | Wouter route fallback. | `client/src/pages/not-found.tsx` |

## Pattern Overview

**Architectural pattern:** Single-process Node/Express server that owns all I/O (HTTP, gRPC, SQLite) and serves a Vite/React SPA from the same port. The product surface is a single JSON contract — `RadarSnapshot` — produced by the snapshot builder and consumed by the SPA either as JSON (`/api/radar`), as a deadline-bound JSON (`/api/radar?force=1` to bypass cache), or as Server-Sent Events (`/api/radar/stream`). There is no separate API server, no microservice boundary, and no client/server schema drift because the Zod schemas live in `shared/schema.ts` and are imported by both sides.

**Layering (top → bottom):**
1. **Transport / SPA** — Express HTTP, SSE, static serving (or Vite middleware in dev); React app with hash router.
2. **Domain orchestration** — `buildSnapshot()` in `server/routes.ts` is the orchestrator: it gathers DexScreener pairs/profiles + gRPC candidates + SVS enrichment, scores them, and emits a `RadarSnapshot`.
3. **External I/O adapters** — `server/svs.ts` (SVS REST + RPC), `server/grpcStream.ts` (Yellowstone gRPC), inline DexScreener fetches in `server/routes.ts` (`fetchJson()`).
4. **Persistence** — `server/storage.ts` (Drizzle / better-sqlite3, single table, only the latest row matters).

**Data flow (per radar build):**
1. `GET /api/radar` → `buildSnapshotWithDeadline(force)` (`server/routes.ts:893-911`).
2. `withDeadline()` (`server/routes.ts:87-114`) races the live build against a 12 s wall-clock; on timeout it returns the most recent `lastGoodSnapshot` or a synthesised `dataMode: "deadline-fallback"` snapshot.
3. `buildSnapshot()` consults the 25 s `memoryCache` first; on miss it issues parallel `fetchJson()` calls to DexScreener (trending pairs, profile data, boosts) via `mapPool()` with bounded concurrency.
4. The gRPC candidate cache is read with `getRecentGrpcCandidates()`, gRPC-only mints (no DexScreener pair) are surfaced as conservative `grpc-only` `TokenSignal` entries.
5. When `SVS_API_KEY` is set and not in auth cooldown, `fetchSvsMetadata` / `fetchSvsPrices` / `fetchSvsMintInfo` enrich the merged candidate list (`server/svs.ts:144-149`).
6. Per-token scoring computes `velocity / virality / upside / risk / final`, derives `riskFlags` and `opportunityFlags`, decodes the meme narrative, and tags `sourceTags`.
7. The completed `RadarSnapshot` is validated against `radarSnapshotSchema` shape, written to SQLite via `storage.saveRadarSnapshot`, cached in `memoryCache` for 25 s, and returned.
8. SSE consumers receive a freshly built snapshot every 20 s (`REFRESH_SECONDS`, `server/routes.ts:913-939`).

**Concurrency model:**
- Single Node event loop. No worker threads, no cluster.
- The gRPC worker runs as a long-lived async loop inside the same process (`startGrpcWorker()` is invoked from the `httpServer.listen()` callback in `server/index.ts:131-145`). Failures are caught and logged; they never crash the HTTP server.
- All outbound HTTP I/O uses `AbortController` timeouts plus a `Promise.race` "hard deadline" two seconds past the abort, to defend against event-loop starvation delaying the abort.
- `inflightSnapshot` (`server/routes.ts:85`) deduplicates concurrent radar builds — when the cache is cold, only one build runs at a time and all callers await the same promise.

## Abstractions

**`IStorage` (`server/storage.ts:19-22`)** — minimal interface (`saveRadarSnapshot`, `getLatestRadarSnapshot`) with a single `DatabaseStorage` impl. Reserves space for future swap-out (e.g. Postgres) without touching `routes.ts`.

**`withDeadline<T>()` (`server/routes.ts:87-114`)** — generic deadline wrapper used for both the radar build and the SVS health probe; on timeout it invokes `onTimeout()` to produce a fallback value rather than throw, so callers always get a well-formed response.

**`fetchJson<T>()` (`server/routes.ts:139-178`)** — typed result-object pattern (`{ ok: true, data } | { ok: false, error, label }`) so callers handle failures inline rather than via try/catch.

**`recordsByMint<T>()` (`server/svs.ts:116-142`)** — defensive normaliser that accepts SVS responses in any of three shapes (array, `{ data: [...] }`, `{ [mint]: {...} }`) and produces a `Map<string, T>` keyed by mint.

**`mapPool<T, R>()` (`server/routes.ts:180-191`)** — concurrency-bounded `Promise.all`, used wherever we need to fan out N independent fetches without flooding the upstream.

**Zod schema as contract (`shared/schema.ts`)** — `radarSnapshotSchema` is the single source of truth for the wire format; both `RadarSnapshot` (TS type) and the runtime validator are derived from it.

## Entry Points

| Entry point | File | Started by |
|-------------|------|------------|
| Server (dev) | `server/index.ts` | `tsx server/index.ts` via `npm run dev` |
| Server (prod) | `dist/index.cjs` (bundled by esbuild) | `node dist/index.cjs` via `npm start` |
| Client | `client/src/main.tsx` → `client/src/App.tsx` | Vite middleware (dev) or static `index.html` (prod) |
| Client root HTML | `client/index.html` | Loaded by Vite or served from `dist/public/index.html` |
| Build | `script/build.ts` | `tsx script/build.ts` via `npm run build` |
| DB push | `drizzle-kit push` | `npm run db:push` |
| Type-check | `tsc` | `npm run check` |

## State Management

**Server-side state (in-process, ephemeral):**
- `memoryCache` — most recent radar build, valid for 25 s (`server/routes.ts:83`)
- `lastGoodSnapshot` — most recent successful build, used as deadline fallback (`server/routes.ts:84`)
- `inflightSnapshot` — single-flight guard for concurrent builds (`server/routes.ts:85`)
- `authRejectedUntil` / `lastAuthRejectStatus` — SVS auth-cooldown state (`server/svs.ts:14-21`)
- gRPC worker globals — connection state, candidate cache, diagnostics counters (`server/grpcStream.ts`)

**Server-side state (persisted):**
- SQLite `radar_snapshots` table — every snapshot is appended; only the latest is queried (`server/storage.ts:25-31`).

**Client-side state:**
- TanStack Query cache (`queryClient` in `client/src/lib/queryClient.ts`) with `staleTime: Infinity`, `refetchOnWindowFocus: false`, `retry: false`. Polling is intentionally off — the SSE stream supplies live data; one-shot fetches happen on mount.
- React local state inside `RadarHome()` for sort mode, filter mode, selected token, sheet visibility (`client/src/App.tsx:628`).
- Theme via `useTheme()` (`client/src/App.tsx:80`) — persisted to `localStorage`.
- URL state: hash route via `wouter/use-hash-location`. `client/src/main.tsx:5-7` forces `#/` on first load.

## Error Handling

- Express error middleware logs to `console.error` and returns `{ message }` (`server/index.ts:94-105`); status defaults to 500.
- All upstream fetches return result objects rather than throw (`fetchJson`, SVS helpers), so the snapshot builder never has to wrap I/O in try/catch.
- The gRPC worker catches all errors at the loop level and feeds them into the `lastError` field of the status report; reconnect logic decides whether to retry.
- The SSE handler emits `event: error` payloads on failure rather than terminating the stream (`server/routes.ts:927-930`).
- The SPA receives `{ message }` from failed routes and surfaces them via toast / status badges; nothing crashes the page.

## Notable Files

- `server/routes.ts` (942 lines) — by far the largest server module; holds the snapshot builder, scoring, meme decoding, and all HTTP route handlers. See `CONCERNS.md` for the split-file refactor.
- `client/src/App.tsx` (924 lines) — the entire SPA UI: every component (`Logo`, `SvsBadge`, `GrpcBadge`, `ScorePill`, `TokenAvatar`, `TokenCard`, `DetailPanel`, `MetaRail`, `SnapshotBar`, `RadarHome`, `AppRouter`, `App`) plus the `exportCsv` helper and the formatting utilities live in one file.
- `server/grpcStream.ts` (605 lines) — Yellowstone subscription, parsing, and the candidate-cache lifecycle. Defensive `any` typing is intentional and confined to this file (see header comment).
- `server/svs.ts` (378 lines) — SVS REST + RPC integration with the auth-cooldown state machine.
- `shared/schema.ts` (122 lines) — the wire-format contract.

---

*Architecture analysis: 2026-05-04*
