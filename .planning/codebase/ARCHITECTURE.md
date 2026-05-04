<!-- refreshed: 2026-05-04 -->

# Architecture — Meme Velocity Radar

## System Overview

A single Node/Express process serves both the JSON API and the Vite/React SPA. A long-lived gRPC worker streams Solana transactions from Yellowstone in the background, deposits candidate mints into an in-memory cache, and the snapshot builder fuses those candidates with DexScreener pair data and optional SVS enrichment into a single `RadarSnapshot` returned by `/api/radar`.

```
+--------------------------------------+
|      Browser (React SPA)             |
|  client/src/main.tsx                 |
|  client/src/App.tsx (RadarHome)      |
|   - TanStack Query: /api/radar,      |
|     /api/svs/health, /api/grpc/status|
|   - EventSource: /api/radar/stream   |
+------------------|-------------------+
                   | HTTPS (hash-routed SPA + JSON)
                   v
+--------------------------------------+
|  Node / Express (single process)     |
|  server/index.ts (boot + log mw)     |
|  server/routes.ts                    |
|   - /api/radar  (deadline-bound)     |
|   - /api/radar/stream (SSE, 20s)     |
|   - /api/svs/health                  |
|   - /api/grpc/status                 |
|  server/vite.ts  (dev middleware)    |
|  server/static.ts (prod static)      |
+---|--------|----------|-----|--------+
    |        |          |     |
    v        v          v     v
+------+ +-------+ +-------+ +----------------+
| SVS  | | SVS   | | Dex   | | gRPC worker    |
| API  | | RPC   | | Scrnr | | server/        |
| /met | | HTTP  | | api.  | | grpcStream.ts  |
| /pri | | (jsn  | | dexs  | |  - Yellowstone |
| /min | |  rpc) | | crnr. | |    subscribe   |
+------+ +-------+ +-------+ |  - CandidateStr|
                             |  - 45m TTL,    |
                             |    1k cap      |
                             +-------|--------+
                                     | xToken
                                     v
                             +----------------+
                             | SVS Geyser     |
                             | gRPC endpoint  |
                             +----------------+

+-------------------------+
| SQLite (data.db)        |
| server/storage.ts       |
| radar_snapshots table   |
| (drizzle schema in      |
|  shared/schema.ts)      |
+-------------------------+
       ^
       | persist + stale-fallback
       |
   server/routes.ts
```

External services: DexScreener (`https://api.dexscreener.com`), SVS API (`https://free.api.solanavibestation.com` default), SVS RPC HTTP, SVS Geyser gRPC. Local store: `data.db` (better-sqlite3 WAL).

## Component Responsibilities

| Component | Responsibility | File |
| --- | --- | --- |
| Express boot + logging | Initializes Express, captures rawBody, summarizes API responses for logs, mounts routes, starts gRPC worker, picks dev (Vite middleware) vs prod (static) serving. | `server/index.ts` |
| Routes + snapshot builder | Defines all `/api/*` endpoints, scoring logic, snapshot assembly, deadline guards, SSE stream, single-flight build coalescing. | `server/routes.ts` |
| SVS HTTP enrichment | Batch `/metadata`, `/price`, per-mint `/mint_info`; auth-cooldown short-circuit on 401/403; reachability probes for the health report. | `server/svs.ts` |
| gRPC live worker | Yellowstone subscribe loop, watch-program loader (env-toggled), filter builder, defensive proto parsing, candidate cache (`CandidateStore`), reconnect + keepalive, diagnostics counters. | `server/grpcStream.ts` |
| Storage layer | `IStorage` abstraction backed by Drizzle on better-sqlite3; persists each successful snapshot, retrieves the latest for fallback. | `server/storage.ts` |
| Static serving (prod) | Resolves `__dirname/public` and serves the built SPA with SPA fallback to `index.html`. | `server/static.ts` |
| Vite middleware (dev) | Spins up Vite in middleware mode with HMR over the same HTTP server; rewrites `index.html` per request. | `server/vite.ts` |
| Cross-cutting schema | Drizzle SQLite table + Zod schemas (`tokenSignalSchema`, `metaSignalSchema`, `radarSnapshotSchema`, `grpcSummarySchema`) shared between server and client. | `shared/schema.ts` |
| SPA bootstrap | Mounts React, sets a default hash (`#/`) so wouter's hash router has a route. | `client/src/main.tsx` |
| App shell + router | Providers (TanStack Query, Tooltip, Toaster), wouter `Switch` mapping `/` to `RadarHome` and the catch-all to `NotFound`. | `client/src/App.tsx:902-924` |
| Radar dashboard | Hosts state + queries + EventSource subscription + filter/sort/search; composes all sub-components. | `client/src/App.tsx:628-900` (RadarHome) |
| Header badges | `SvsBadge`, `GrpcBadge` render health/stream summaries from `/api/svs/health` and `/api/grpc/status`. | `client/src/App.tsx:158-218` |
| Token UI | `TokenAvatar`, `TokenCard`, `DetailPanel`, `MetaRail`, `SnapshotBar`, `ScorePill`, `exportCsv`. | `client/src/App.tsx:220-626` |
| Theme hook | Local light/dark toggle reading/writing `localStorage` and a class on `<html>`. | `client/src/App.tsx:80-91` (useTheme) |
| Query client | TanStack Query default `queryFn` that maps `queryKey` array → URL path; wraps `apiRequest`. | `client/src/lib/queryClient.ts` |
| 404 page | Static "page not found" card. | `client/src/pages/not-found.tsx` |
| shadcn/ui primitives | 47 Radix-based primitives generated by the shadcn CLI (button, card, sheet, tabs, badge, ...). | `client/src/components/ui/*.tsx` |
| Build pipeline | Vite client build to `dist/public`; esbuild server bundle to `dist/index.cjs` with curated allowlist of bundled deps. | `script/build.ts` |

## Pattern Overview

The system is a **single-process layered backend-for-frontend** for a public data feed. The server is the only authoritative integration point: it owns secrets (SVS_API_KEY, SVS_GRPC_X_TOKEN), normalizes three heterogeneous upstreams (gRPC stream, paid REST API, public REST API) into a single `RadarSnapshot` Zod-typed contract, applies a heuristic scoring pass, persists each snapshot to SQLite for stale-while-degraded fallback, and exposes both pull (`/api/radar`) and push (`/api/radar/stream` SSE) channels. The client is a thin hash-routed React SPA that consumes that contract, manages only UI state, and never speaks to upstream services directly.

## Layering

Top to bottom:

1. **Browser SPA** (`client/src/`) — React + TanStack Query + wouter (hash router). UI state, sort/filter/search, light/dark theme. Subscribes to SSE for live updates. Reads only `/api/*` JSON.
2. **HTTP transport** (`server/index.ts`, `server/routes.ts`) — Express 5; JSON/urlencoded body parsers; per-request log line with sanitized response summary; SPA serving (Vite middleware in dev, static in prod) mounted last so it doesn't shadow `/api`.
3. **Snapshot builder** (`server/routes.ts:538-773` `buildSnapshot`) — orchestrates concurrent fetches (`Promise.all` for the four DexScreener endpoints, `mapPool` for per-mint pair lookups), merges in gRPC candidates and SVS enrichment, normalizes everything through `scorePair`/`buildGrpcOnlyToken`/`normalizeMeta`, and writes to storage.
4. **Integration adapters** (`server/svs.ts`, `server/grpcStream.ts`) — encapsulate one external system each; expose narrow typed surfaces (`fetchSvsMetadata`, `getRecentGrpcCandidates`, `getGrpcStatus`, `getSvsHealthReport`).
5. **Persistence** (`server/storage.ts`) — `IStorage` interface with one Drizzle/SQLite implementation. Single table `radar_snapshots(id, captured_at, payload)` with payload as JSON text.
6. **Cross-cutting contract** (`shared/schema.ts`) — Drizzle table + Zod schemas + inferred TypeScript types imported by both server and client via the `@shared/*` alias.

## Data Flow

A full `/api/radar` request:

1. Browser issues `GET /api/radar` (or `?force=1`); request hits Express middleware in `server/index.ts:67-89` which patches `res.json` to capture the body for the log line.
2. Route handler at `server/routes.ts:893-911` calls `buildSnapshotWithDeadline(force)`.
3. `buildSnapshotWithDeadline` (`server/routes.ts:787-853`) checks the module-level `inflightSnapshot` — if a build is already running, the new request piggybacks on it (single-flight). If not, it creates one and arms a 12s deadline via `withDeadline` (`server/routes.ts:87-114`) that, on timeout, returns a `structuredClone` of `memoryCache` or `lastGoodSnapshot` (or an empty well-formed snapshot if neither exists), with a `deadline` entry prepended to `sourceHealth`.
4. `buildSnapshot` (`server/routes.ts:538-773`) first checks the 25s in-process `memoryCache`; if hit and not forced, returns it immediately.
5. Four DexScreener endpoints are fetched in parallel via `fetchJson` (`server/routes.ts:139-178`): `/token-boosts/latest/v1`, `/token-profiles/latest/v1`, `/token-profiles/recent-updates/v1`, `/metas/trending/v1`. Each is wrapped in an AbortController + a hard-deadline `Promise.race` that fires `timeoutMs + 2000ms` later to defend against event-loop starvation. Each fetch contributes a `sourceHealth` entry.
6. Solana profiles are coalesced by `tokenAddress` into `profileByAddress`. `getRecentGrpcCandidates(40)` (`server/grpcStream.ts:599-601`) returns up to 40 mints from the in-memory candidate cache; these are prepended to the candidate list and the union is deduped and capped at `MAX_CANDIDATES = 14` (`server/routes.ts:77, 597`).
7. `mapPool(candidates, 7, ...)` (`server/routes.ts:180-191, 598-605`) issues per-mint `/token-pairs/v1/solana/{address}` requests with a concurrency cap of 7.
8. If `SVS_API_KEY` is set and not in cooldown, `fetchSvsMetadata` and `fetchSvsPrices` are called in parallel (`server/svs.ts:186-194`), batching mints in groups of 36 (`BATCH_SIZE`). Their results populate `svsMetadataMap` / `svsPriceMap` and append `svs-metadata` / `svs-price` to `sourceHealth`.
9. `scorePair` (`server/routes.ts:263-423`) folds DexScreener pair stats + profile + SVS enrichment into a `TokenSignal`, computing `velocity / virality / upside / risk / final` and emitting `riskFlags` + `opportunityFlags`. gRPC-only candidates without a DexScreener pair are surfaced via `buildGrpcOnlyToken` (`server/routes.ts:425-517`) with conservative scores.
10. Tokens are sorted by `final`, truncated to 24, then the top 6 are enriched with `/mint_info` (`fetchSvsMintInfo`, `server/svs.ts:196-250`), each call gated by the SVS auth cooldown.
11. `getGrpcStatus()` (`server/grpcStream.ts:564-597`) is folded into `snapshot.grpc` and an `svs-grpc` entry is added to `sourceHealth`.
12. `memoryCache` is updated for 25s, `lastGoodSnapshot` is updated if there are tokens, and `storage.saveRadarSnapshot` (`server/storage.ts:25-27`) inserts the snapshot to SQLite (fire-and-forget — failures are swallowed). The snapshot is returned and serialized to JSON in the response.
13. After `res.on("finish")` fires (`server/index.ts:78-86`), the access log line is emitted with a sanitized summary like `tokens=14 sources=8 grpc=connected/12c/30epm`.

## Concurrency Model

- **Single Node process** runs the HTTP server, the snapshot builder, and the gRPC worker. There is no clustering or worker_threads use.
- **gRPC worker as long-lived async** (`server/grpcStream.ts:521-541`): `runStreamLoop` is started from `httpServer.listen` callback in `server/index.ts:130-145` and runs forever, with exponential backoff reconnect (1s → 30s, `RECONNECT_BASE_MS`/`RECONNECT_MAX_MS`) and a 30s keepalive ping (`KEEPALIVE_MS`). Stream errors never throw out of the worker; they trip `status = "reconnecting"` and re-enter the loop.
- **Abort + race deadline pattern**: every outbound HTTP call uses `AbortController` plus a redundant `Promise.race` with a `timeoutMs + 2000ms` hard deadline (`server/routes.ts:139-178`), defending against the case where the abort itself is delayed by event-loop starvation. SVS calls use `fetchWithTimeout` (`server/svs.ts:63-71`).
- **Top-level deadlines**: `/api/radar` is bounded by `RADAR_BUILD_DEADLINE_MS = 12_000` (`server/routes.ts:81, 806`) and `/api/svs/health` by `HEALTH_DEADLINE_MS = 6_000` (`server/routes.ts:82, 878`). On timeout, both return a degraded snapshot/report rather than hang the request.
- **Single-flight builds**: `inflightSnapshot` (`server/routes.ts:85, 787-804`) coalesces concurrent `/api/radar` calls onto one build; the slot is cleared via `setImmediate` so callers in the same tick still get the in-flight promise.
- **Bounded concurrency**: `mapPool` (`server/routes.ts:180-191`) caps per-mint pair-lookup workers; SVS `mint_info` uses its own internal worker pool (`server/svs.ts:216-247`).
- **In-memory state isolation**: `memoryCache`, `lastGoodSnapshot`, `inflightSnapshot`, the SVS auth-cooldown timestamps, and the `CandidateStore` are module-level — safe because there is exactly one process and Node is single-threaded for JS execution.

## Abstractions

- **`IStorage`** interface — `server/storage.ts:19-22`. Two methods (`saveRadarSnapshot`, `getLatestRadarSnapshot`); single implementation `DatabaseStorage` (`server/storage.ts:24-32`).
- **`withDeadline<T>(promise, ms, onTimeout)`** — `server/routes.ts:87-114`. Generic race-with-fallback used by `/api/radar` and `/api/svs/health`.
- **`fetchJson<T>` result-object pattern** — `server/routes.ts:139-178`. Returns `{ ok: true; data: T } | { ok: false; error: string; label: string }` so callers branch on `.ok` instead of try/catch and can stream errors into `sourceHealth`. Mirrored in SVS via `postBatch` returning `{ ok, map | error }` (`server/svs.ts:144-184`).
- **`recordsByMint<T>(items)`** — `server/svs.ts:116-142`. Defensive normalizer that accepts SVS responses in any of three shapes (array of records, `{ data: [...] }`, or `{ [mint]: {...} }`) and returns a `Map<string, T>`.
- **`mapPool<T, R>(items, limit, mapper)`** — `server/routes.ts:180-191`. Tiny generic worker-pool primitive used wherever bounded concurrency is required.
- **Zod schema-as-contract** — `shared/schema.ts:33-117`. `tokenSignalSchema`, `metaSignalSchema`, `radarSnapshotSchema`, `grpcSummarySchema` define the wire format; `z.infer` produces the TypeScript types both layers import.
- **`CandidateStore` class** — `server/grpcStream.ts:170-238`. Encapsulates LRU-with-TTL semantics over the gRPC candidate set (45m TTL, 1000-entry cap, recency-ordered iteration via `Map` re-insertion).
- **SVS auth cooldown** — `server/svs.ts:14-35`. Module-level `authRejectedUntil` short-circuits SVS calls for 5 minutes after a 401/403; probes still go through so the user can see the key recover.

## Entry Points

| Entry | Command | What it runs | File |
| --- | --- | --- | --- |
| Dev server | `npm run dev` | `tsx server/index.ts` with Vite middleware mode, HMR over `/vite-hmr`. | `package.json:7`, `server/index.ts:1`, `server/vite.ts` |
| Production server | `npm start` | `node dist/index.cjs`, serves bundled SPA from `dist/public`. | `package.json:9`, `server/index.ts`, `server/static.ts` |
| Build | `npm run build` | `tsx script/build.ts` — Vite client build + esbuild server bundle. | `package.json:8`, `script/build.ts` |
| Type-check | `npm run check` | `tsc --noEmit` over `client/src/**`, `shared/**`, `server/**`. | `package.json:10`, `tsconfig.json` |
| DB schema push | `npm run db:push` | Drizzle Kit pushes `shared/schema.ts` to `data.db`. | `package.json:11`, `drizzle.config.ts` |
| HTTP entry | `httpServer.listen(PORT, "0.0.0.0", { reusePort: true })` | Default port 5000. Same socket serves API + SPA. | `server/index.ts:121-129` |
| SPA entry | `createRoot(document.getElementById("root")!).render(<App/>)` | Forces hash to `#/` first to seed the wouter hash router. | `client/src/main.tsx:1-9` |
| HTML entry | `client/index.html` (loaded by Vite) | `<script src="/src/main.tsx">` (rewritten with cache-bust nonce in dev). | `client/index.html`, `server/vite.ts:46-50` |

## State Management

- **Server-side ephemeral (in-memory):**
  - `memoryCache` — last `RadarSnapshot` for 25s (`server/routes.ts:83`).
  - `lastGoodSnapshot` — most recent snapshot with non-empty tokens, used as a richer fallback (`server/routes.ts:84`).
  - `inflightSnapshot` — single-flight slot for in-progress builds (`server/routes.ts:85`).
  - `authRejectedUntil`, `lastAuthRejectStatus` — SVS auth cooldown (`server/svs.ts:15-16`).
  - `CandidateStore` instance + status counters (`status`, `lastError`, `eventsReceived`, `eventTimestamps[]`, `eventsByProgram`, etc.) in `server/grpcStream.ts:240-261`.
- **Server-side persisted (SQLite):** `radar_snapshots(id, captured_at, payload)` table holding the JSON-serialized snapshot, queried by `desc(id) limit 1` for fallback (`server/storage.ts:9-15, 29-31`). WAL mode enabled.
- **Client-side:**
  - **TanStack Query** for `/api/radar`, `/api/svs/health`, `/api/grpc/status` with custom refetch intervals (`client/src/App.tsx:639-655`); default `queryFn` derives URLs from the `queryKey` array (`client/src/lib/queryClient.ts:28-41`).
  - **React local state** in `RadarHome` for `live` toggle, `sortMode`, `filterMode`, `search`, `selectedId`, `sheetOpen`, `streamSnapshot`, `refreshing` (`client/src/App.tsx:629-637`).
  - **EventSource subscription** for `/api/radar/stream`, replacing the cached snapshot on every SSE `radar` event (`client/src/App.tsx:658-669`).
  - **Theme** — `useTheme` reads/writes `localStorage("mvr-theme")` and toggles a class on `<html>` (`client/src/App.tsx:80-91`).
  - **URL hash routing** via wouter's `useHashLocation` (`client/src/App.tsx:3, 916`), seeded by `main.tsx`.

## Error Handling

- **Server (request-level):** Express error handler at `server/index.ts:94-105` returns `{ message }` with the err's status code (default 500), logs the full error to `console.error`. Headers-sent errors are forwarded to the default handler.
- **Outbound calls:** Always go through `fetchJson` (`server/routes.ts:139-178`) or `fetchWithTimeout` (`server/svs.ts:63-71`). Errors become `{ ok: false, error }` results that are folded into `sourceHealth` with `status: "degraded" | "error"` instead of throwing.
- **`/api/radar` failure:** Catch block at `server/routes.ts:898-910` reads the latest SQLite snapshot, prepends `{ name: "cache", status: "degraded", detail: "serving last saved snapshot" }`, and returns it; only when no fallback exists does it 502.
- **Streaming SSE:** `server/routes.ts:913-939` writes `event: error\ndata: {...}` frames on builder errors instead of closing the stream. Client `onerror` closes the EventSource (`client/src/App.tsx:665-667`).
- **gRPC worker:** Stream parser exceptions are caught per-update so a single bad frame can't kill the stream (`server/grpcStream.ts:498-503`); reconnect loop catches everything and exponentially backs off (`server/grpcStream.ts:521-541`); the worker startup wraps `runStreamLoop` in `.catch` so an early throw flips status to `"error"` without crashing the process (`server/index.ts:130-145`, `server/grpcStream.ts:557-560`).
- **SVS auth failures:** 401/403 trigger a 5-minute cooldown (`server/svs.ts:14-21, 166-172, 227-231`); subsequent calls short-circuit until expiry, but probes still run.
- **Client:** TanStack Query default has `retry: false` and `staleTime: Infinity` (`client/src/lib/queryClient.ts:43-55`); failures surface in the UI via the `error` field of `useQuery`. `apiRequest` throws on non-OK; `throwIfResNotOk` formats the status + body text (`client/src/lib/queryClient.ts:5-10`).

## Notable Files

- **`client/src/App.tsx` (924 lines)** — entire SPA in one file: types, formatters (`fmtMoney`, `fmtPct`, `fmtAge`), tone helpers, `useTheme` hook, every component (`Logo`, `SvsBadge`, `GrpcBadge`, `ScorePill`, `TokenAvatar`, `TokenCard`, `DetailPanel`, `MetaRail`, `SnapshotBar`, `RadarHome`, `AppRouter`, `App`), `exportCsv`, and the Toaster/QueryClient/Router providers. No code-splitting; intentionally monolithic per the team's pattern.
- **`server/routes.ts` (942 lines)** — owns the entire snapshot pipeline: scoring functions, source orchestration, deadlines, single-flight, SSE, and the Express handlers. The largest file in the server tree.
- **`server/grpcStream.ts` (605 lines)** — Yellowstone client + filter builder + defensive proto parsing + `CandidateStore` + diagnostics counters; all `any` access lives here so the rest of the app can stay strongly typed.
- **`server/svs.ts` (378 lines)** — SVS REST integration including the auth-cooldown logic, batch helpers, and the three-shape response normalizer.
- **`shared/schema.ts` (122 lines)** — surprisingly small for how load-bearing it is; the Zod schemas form the JSON contract referenced by both layers.
- **`script/build.ts` (65 lines)** — bundle pipeline; the curated `allowlist` of bundled deps is the only place that decides what ships inside `dist/index.cjs` vs. what stays as a runtime `external`.

*Architecture analysis: 2026-05-04*
