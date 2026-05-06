# Codebase Concerns

**Analysis Date:** 2026-05-05

## Tech Debt

**Unbounded SQLite snapshot table:**
- Issue: Every successful radar build appends a new row to `radar_snapshots`. There is no DELETE, prune, VACUUM, or row-count cap anywhere in storage or routes logic. At one build per 25 seconds, this accumulates ~3,456 rows per day, each storing 50–200 KB of JSON payload text.
- Files: `server/storage.ts` (lines 9–15, 25–31), `server/routes.ts` (lines 767–771)
- Impact: SQLite `data.db` grows without bound. On Railway ephemeral containers this resets on redeploy, but on persistent-disk deployments (or if Railway volumes are used) the file will grow into gigabytes. Also, `getLatestRadarSnapshot()` only reads the single most-recent row — all older rows are write-only dead weight.
- Fix approach: Add a `pruneOldSnapshots()` call after every `saveRadarSnapshot()` that deletes all rows except the most recent N (e.g., 5). A single `DELETE FROM radar_snapshots WHERE id NOT IN (SELECT id FROM radar_snapshots ORDER BY id DESC LIMIT 5)` is sufficient.

**SQLite database path is relative and undocumented:**
- Issue: `new Database("data.db")` in `server/storage.ts` (line 7) uses a bare relative path. The database file location depends entirely on the Node.js working directory at launch, which differs between `npm run dev` (project root) and `npm start` (dist/ subfolder or wherever the CJS bundle is invoked).
- Files: `server/storage.ts` (line 7)
- Impact: Production and dev may write to different files. If the CWD at process start is the `dist/` directory, `data.db` lands there, which is gitignored and cleaned on next build.
- Fix approach: Use `path.resolve(__dirname, "../data.db")` or an absolute path derived from `process.cwd()` at startup. Alternatively, accept a `DATABASE_PATH` env var.

**SSE stream bypasses the inflight-coalescing guard:**
- Issue: `GET /api/radar/stream` calls `buildSnapshot(true)` (force=true) every `REFRESH_SECONDS` (20 seconds) per connected client. The coalescing guard in `buildSnapshotWithDeadline()` only protects the non-SSE path. Each live-stream client triggers an independent full DexScreener + SVS fetch cycle.
- Files: `server/routes.ts` (lines 913–939, specifically line 924)
- Impact: Two browser tabs in live mode double the outbound API rate. On DexScreener's public (unauthenticated) endpoint this can trigger rate limiting quickly. Under load, multiple concurrent `buildSnapshot(true)` calls race and the deadline logic provides no protection.
- Fix approach: Route SSE through `buildSnapshotWithDeadline(false)` and rely on the memory cache, or build a separate SSE broadcaster that multiplexes all subscribers onto a single polling loop.

**Reconnect backoff does not reset on successful connection:**
- Issue: In `server/grpcStream.ts` the exponential backoff variable `backoff` is declared once outside the loop (line 522) and only increments on each loop iteration. It never resets when a connection succeeds and runs for a long time before eventually dropping.
- Files: `server/grpcStream.ts` (lines 521–540)
- Impact: After a transient disconnect on an otherwise-stable connection, the next reconnect attempt backs off as though prior failed attempts just occurred, potentially waiting 30 seconds unnecessarily.
- Fix approach: Reset `backoff = RECONNECT_BASE_MS` immediately after a successful `runStreamOnce()` call that ran for longer than a threshold (e.g., >60 seconds), distinguishing "healthy session ended" from "immediate crash".

**`routes.ts` is a 942-line monolith:**
- Issue: `server/routes.ts` contains all scoring logic (`scorePair`, `buildGrpcOnlyToken`, `classifyMeme`, `buildLinks`), all fetching utilities (`fetchJson`, `mapPool`, `withDeadline`), all snapshot orchestration (`buildSnapshot`, `buildSnapshotWithDeadline`, `latestUsableSnapshot`), and the Express route registrations — all in one file.
- Files: `server/routes.ts`
- Impact: High cognitive overhead when modifying the scoring model. A change to the fetch strategy risks touching scoring code and vice versa. Test isolation is impossible without extracting units.
- Fix approach: Extract scoring functions into `server/scoring.ts`, fetch utilities into `server/fetch.ts`, and snapshot orchestration into `server/snapshot.ts`. Route registrations remain in `routes.ts`.

**`App.tsx` is a 924-line single-file component:**
- Issue: The entire React application — routing, data fetching, all UI components (`TokenCard`, `DetailPanel`, `MetaRail`, `SnapshotBar`, `ScorePill`, etc.), all helper functions, all type definitions — is in `client/src/App.tsx`.
- Files: `client/src/App.tsx`
- Impact: Difficult to navigate, test, or extend. Any new feature requires editing the same file as unrelated UI. Bundle-splitting and lazy loading are impossible at this granularity.
- Fix approach: Extract each major component into `client/src/components/` (e.g., `TokenCard.tsx`, `DetailPanel.tsx`, `MetaRail.tsx`) and each custom hook into `client/src/hooks/` (e.g., `useRadarStream.ts`).

**Duplicate type definitions between client and server:**
- Issue: `SvsHealthStatus`, `SvsHealthReport`, `GrpcWorkerStatus`, and `GrpcStatusReport` are independently defined in `client/src/App.tsx` (lines 54–78) and also defined (or implied by return types) in `server/svs.ts` and `server/grpcStream.ts`. The shared schema at `shared/schema.ts` does not export these types.
- Files: `client/src/App.tsx` (lines 54–78), `server/svs.ts` (lines 37–45, 342–350), `server/grpcStream.ts` (lines 31–45)
- Impact: Drift risk — adding a field to the server health report requires a separate update in the client type or the UI silently drops the field. Already observed: `authCooldown` is present in `SvsHealthReport` on the server but absent from the client type (App.tsx line 55–62).
- Fix approach: Export `SvsHealthReport`, `SvsHealthStatus`, `GrpcStatus` from `shared/schema.ts` as Zod schemas so client and server share a single source of truth.

**Hardcoded scoring weights with no tunability:**
- Issue: All velocity/virality/upside/risk score weights are bare numeric literals scattered throughout `scorePair()` and `buildGrpcOnlyToken()` in `server/routes.ts` (lines 309–364, 451–455). There are over 20 distinct magic numbers (e.g., `0.22`, `75_000`, `45_000`, `0.45`, `220`).
- Files: `server/routes.ts` (lines 309–364)
- Impact: Tuning the scoring model requires code changes, a rebuild, and a redeploy. No A/B comparison is possible. The relationship between weights is not documented, making it hard to reason about combined effect.
- Fix approach: Consolidate weights into a named `SCORE_CONFIG` constant object at the top of the file (or a separate `server/scoreConfig.ts`). This at minimum makes the parameters visible and grouped without requiring env-var machinery.

## Security Considerations

**No rate limiting on any API endpoint:**
- Risk: `/api/radar`, `/api/radar/stream`, `/api/svs/health`, and `/api/grpc/status` are all public and unauthenticated with no rate limiting. A single client can call `/api/radar?force=1` in a loop to cause the server to hammer DexScreener and SVS with continuous requests, potentially triggering upstream bans or exhausting the Railway container.
- Files: `server/index.ts`, `server/routes.ts`
- Current mitigation: The 25-second memory cache and 12-second deadline guard help, but `force=1` bypasses the cache. `express-rate-limit` is in the build allowlist (`script/build.ts` line 15) but never imported or applied.
- Recommendations: Apply `express-rate-limit` middleware to all `/api/*` routes, with a stricter limit on `/api/radar?force=1`. At minimum, require that `force=1` is admin-gated or rate-limited to 1 req/minute per IP.

**No CORS policy defined:**
- Risk: The Express server accepts cross-origin requests from any origin. Any page on the internet can make requests to `/api/radar` and receive the full snapshot payload, including internal health details.
- Files: `server/index.ts`
- Current mitigation: None. The `cors` package is not listed as a dependency and is not imported.
- Recommendations: Add `cors` with an explicit origin allowlist (the Railway public domain). For a public read-only radar this may be intentional, but it should be a deliberate choice with documentation.

**No security headers:**
- Risk: HTTP responses lack `X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy`, or `Referrer-Policy`. The `helmet` package is absent from dependencies.
- Files: `server/index.ts`
- Current mitigation: None.
- Recommendations: Add `helmet` as a dependency and apply it as the first middleware in `server/index.ts`.

**SVS API key exposed in health endpoint response detail strings:**
- Risk: `probeSvsApiReachability()` in `server/svs.ts` (lines 321–326) returns error detail strings like `"auth rejected (403) — check SVS_API_KEY / API entitlement"`. While the key value is not exposed, the detail field is forwarded verbatim to the client via `/api/svs/health`. If SVS error responses ever include partial key material in their body, it would propagate.
- Files: `server/svs.ts` (lines 301–339), `server/routes.ts` (lines 856–880)
- Current mitigation: Key values themselves are not echoed; only status codes are.
- Recommendations: Ensure `detail` strings are constructed server-side from fixed templates only, never from raw upstream response bodies that might leak credentials.

**gRPC token logged in status endpoint:**
- Risk: `getGrpcStatus()` returns `hasToken: Boolean(token)` — a boolean, which is safe. However, the `SVS_GRPC_X_TOKEN` value is accessed at module initialization time in `startGrpcWorker()` (line 546) and again in `getGrpcStatus()` (line 566) by re-reading `process.env.SVS_GRPC_X_TOKEN`. If error reporting were ever extended to include the token string in `lastError`, it would appear in `/api/grpc/status` responses.
- Files: `server/grpcStream.ts` (lines 564–597)
- Current mitigation: Only the boolean presence is returned, not the value.
- Recommendations: Low risk currently, but any future error formatting that interpolates the token value should be guarded.

## Performance Bottlenecks

**`eventTimestamps` array grows to 60-second window at high event volume:**
- Problem: The sliding window for `eventsPerMinute()` uses `Array.shift()` to drain expired entries (line 270). `shift()` on a large array is O(n) in V8. At AMM v4 event rates (tens of thousands per minute), this array grows to tens of thousands of entries and each call to `eventsPerMinute()` drains thousands of elements.
- Files: `server/grpcStream.ts` (lines 246–272)
- Cause: Linear-time front-removal on a plain JS array.
- Improvement path: Replace with a circular buffer or use a counter approach: track `eventsInWindow` with a `setInterval` that decrements the count as the window slides, avoiding per-event array writes entirely.

**SVS mint-info enrichment runs serially against top 6 tokens, each as an individual POST:**
- Problem: `fetchSvsMintInfo()` in `server/svs.ts` (lines 196–249) fires one HTTP request per mint with concurrency 3. At the call site in `routes.ts` (line 693), 6 mints are enriched — meaning 2 serial rounds of 3 parallel fetches, each with an 8-second timeout, adding up to 16 seconds in the worst case inside an already-deadline-bound build.
- Files: `server/svs.ts` (lines 196–249), `server/routes.ts` (lines 691–712)
- Cause: The SVS `/mint_info` endpoint takes a single mint, so batching isn't possible without backend API changes.
- Improvement path: Reduce the top-mint count to 3 (not 6), or cap `fetchSvsMintInfo`'s timeout to 4 seconds to stay well within the 12-second build deadline.

**`mapPool` fetches DexScreener pairs serially in batches of 7:**
- Problem: `mapPool(candidates, 7, ...)` in `routes.ts` (line 598) processes 14 addresses with 7 concurrent fetches, meaning 2 sequential rounds. Each round can take up to 6 seconds (the per-fetch timeout). In the worst case this adds 12 seconds of serial fetch time before SVS enrichment begins.
- Files: `server/routes.ts` (lines 598–605)
- Cause: Concurrency cap of 7 on 14 candidates means 2 sequential waves.
- Improvement path: Increase concurrency limit to match `MAX_CANDIDATES` (14) so all pair fetches run in a single parallel wave, reducing worst-case pair fetch time from 12s to 6s.

## Fragile Areas

**gRPC Yellowstone client imported with double `any` cast:**
- Files: `server/grpcStream.ts` (lines 433–439)
- Why fragile: The `@triton-one/yellowstone-grpc` client is imported with `await import(...)` and then cast through `Client as unknown as new(...) => any`. All stream event data is typed as `any`. If the library changes its API or the proto schema changes, TypeScript will not surface any breakage. The entire parsing pipeline (`processTransactionUpdate`, `extractMints`, `extractAccountKeys`) relies on runtime shape checks rather than generated proto types.
- Safe modification: Any change to `processTransactionUpdate` or the `buildFilters()` filter shape must be manually validated against the current Yellowstone proto definition. There are no compile-time guards.
- Test coverage: Zero — no test files exist in the project at all.

**`SVS_RPC_WS_URL` is configured and health-checked but never used:**
- Files: `server/svs.ts` (lines 51–52), `server/svs.ts` (lines 259–292)
- Why fragile: `getSvsConfig()` returns `hasRpcWs` and the health report checks `SVS_RPC_HTTP_URL`, but `SVS_RPC_WS_URL` is never connected to or read beyond `hasRpcWs: Boolean(...)`. Operators who configure it expecting WebSocket functionality receive no error, just silence.
- Safe modification: Document that `SVS_RPC_WS_URL` is planned but not yet implemented. Do not add WebSocket logic without also wiring `probeRpcReachability()` to validate it.

**`buildSnapshot` lacks input validation on external API responses:**
- Files: `server/routes.ts` (lines 538–773)
- Why fragile: All four DexScreener responses (`boosts`, `profiles`, `updates`, `metas`) are cast directly with `as TokenProfile[]` or `as DexMeta[]` without schema validation. If DexScreener changes a field name or adds an unexpected shape, the response is consumed silently and produces incorrect scores rather than an error.
- Safe modification: Validate API responses against Zod schemas at the boundary. The `radarSnapshotSchema` in `shared/schema.ts` exists for the output but not for the DexScreener inputs.

**`data.db` path relies on relative CWD at startup:**
- Files: `server/storage.ts` (line 7)
- Why fragile: In development (CWD = project root), `data.db` appears at `/project/data.db`. In production after `npm run build`, the built CJS is executed from the project root too (`node dist/index.cjs`), so `data.db` also lands at the project root — but the `__dirname` inside the bundle points to `dist/`, so if the path were ever changed to use `__dirname`-relative resolution, it would move. Currently it works by accident of how `node dist/index.cjs` is invoked.

## Scaling Limits

**Single-process, single-threaded, in-memory state:**
- Current capacity: One Railway container, one Node.js process. All state (`memoryCache`, `lastGoodSnapshot`, `inflightSnapshot`, `candidates` store, all diagnostic counters) lives in process memory.
- Limit: Horizontal scaling (multiple Railway replicas) is impossible without external shared state. Each replica maintains its own independent candidate store and snapshot cache. Load balancing across replicas would produce inconsistent responses.
- Scaling path: Externalize the snapshot cache to Redis or a shared SQLite with WAL (on a volume). The candidate store from gRPC is inherently per-process and cannot be shared without a message queue.

**DexScreener public API has no authenticated tier:**
- Current capacity: Up to 14 candidates per build cycle. At 25-second cache TTL, this is ~57 pairs-endpoint calls per minute to DexScreener's unauthenticated API.
- Limit: DexScreener's public API has undocumented rate limits. Adding more candidates (`MAX_CANDIDATES`) or reducing `CACHE_MS` will hit rate limits. `sourceHealth` will show errors but the radar degrades gracefully to stale cache.
- Scaling path: Obtain a DexScreener API key (if available) or throttle `MAX_CANDIDATES` down during high-load periods.

## Dependencies at Risk

**`@supabase/supabase-js` is installed but completely unused:**
- Risk: Dead dependency adding ~150KB+ to `node_modules` and to the build. It was likely scaffolded in the initial project template but never wired up. The codebase uses `better-sqlite3` + Drizzle instead.
- Impact: Unnecessary install time, potential security surface from an unused package, confusing to new contributors.
- Migration plan: Remove `@supabase/supabase-js` from `package.json`. Also remove `passport`, `passport-local`, `express-session`, `memorystore` unless authentication is planned — none of these are imported in any server file currently.

**`passport`, `passport-local`, `express-session`, `memorystore` installed but unused:**
- Risk: Auth scaffolding from the project template that was never implemented. These packages are in `dependencies` (not `devDependencies`), meaning they are included in the production deployment bundle if they fall on the `allowlist` in `script/build.ts`.
- Impact: `express-session`, `passport`, `passport-local`, and `memorystore` are all listed in the build allowlist (lines 15, 22, 24, 25 of `script/build.ts`), meaning they are bundled into `dist/index.cjs` even though none are imported.
- Migration plan: Remove all four from `package.json` and `script/build.ts` allowlist. If auth is planned in future, re-add then.

**Large unused UI component library in `client/src/components/ui/`:**
- Risk: Shadcn/Radix components for `accordion`, `alert-dialog`, `aspect-ratio`, `avatar`, `calendar`, `carousel`, `collapsible`, `command`, `context-menu`, `drawer`, `form`, `hover-card`, `input-otp`, `menubar`, `navigation-menu`, `pagination`, `radio-group`, `resizable`, `scroll-area`, and others are present but `App.tsx` uses only `badge`, `button`, `card`, `progress`, `sheet`, `skeleton`, `tabs`, `toast`, `toaster`, and `tooltip`.
- Impact: Vite tree-shakes these at build time for the client bundle, so production size is not directly affected, but the directory contains ~40 component files (most unused), inflating source maintenance cost.
- Migration plan: No urgency given Vite tree-shaking. But new contributors may waste time reading components that are never rendered.

**`@triton-one/yellowstone-grpc` v5.0.8 has no pinned proto version:**
- Risk: The Yellowstone gRPC proto schema evolves independently from the npm package. A patch bump to `@triton-one/yellowstone-grpc` could change field names or encoding, silently breaking `processTransactionUpdate()` parsing because all fields are accessed via `any`.
- Impact: Silent failure — `candidateCount` drops to 0 with no errors.
- Migration plan: Lock the dependency to an exact version (`5.0.8` without caret) in `package.json` and explicitly audit any bumps.

## Test Coverage Gaps

**Zero test files exist:**
- What's not tested: Everything. There are no unit, integration, or end-to-end tests anywhere in the repository. No test runner is configured.
- Files: Entire `server/` and `client/src/` trees.
- Risk: Any change to the scoring algorithm, DexScreener parsing, gRPC candidate extraction, or SSE stream logic can silently break without detection. The scoring formula has ~25 magic-number weights that are invisible to automated verification.
- Priority: High — especially for `scorePair()` in `server/routes.ts` (lines 263–423), `processTransactionUpdate()` in `server/grpcStream.ts` (lines 368–428), and `extractMints()` / `extractAccountKeys()` (lines 306–366).

**No validation that Zod schema matches live API responses:**
- What's not tested: The `tokenSignalSchema`, `radarSnapshotSchema`, and related Zod schemas in `shared/schema.ts` are defined but never used to validate actual DexScreener or SVS API responses in the server path. The schemas define the output contract but not the input parsing boundary.
- Files: `shared/schema.ts`, `server/routes.ts` (lines 542–548)
- Risk: DexScreener API changes could corrupt scores or produce null fields without triggering any validation error.
- Priority: Medium — add schema validation at the `fetchJson` callsites for DexScreener responses.

---

*Concerns audit: 2026-05-05*
