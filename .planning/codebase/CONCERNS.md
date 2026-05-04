# Codebase Concerns

**Analysis Date:** 2026-05-04

## Tech Debt

**Oversized monolithic route file:**
- Issue: `server/routes.ts` is 942 lines and mixes HTTP route registration, DexScreener client, fetch helpers, scoring logic, meme classification, snapshot building, deadline plumbing, in-memory caching, SQLite persistence, and SSE delivery in one file.
- Files: `server/routes.ts`
- Impact: Any change to scoring or to the snapshot pipeline forces edits in the same file as transport plumbing, raising regression risk and making review/diff noisy. Hard to unit-test pieces in isolation since pure functions are co-located with module-level state (`memoryCache`, `lastGoodSnapshot`, `inflightSnapshot`).
- Fix approach: Split into `server/scoring.ts` (`scorePair`, `buildGrpcOnlyToken`, `classifyMeme`, `firstSentence`, `compactUrlLabel`, `logNorm`, `clamp`, `n`), `server/dexscreener.ts` (DexScreener types + `fetchJson` + `mapPool`), `server/snapshot.ts` (`buildSnapshot`, caching, deadline/inflight), and keep `server/routes.ts` as a thin Express wiring layer.

**Hardcoded scoring constants spread across functions:**
- Issue: Velocity / virality / upside / risk weights and thresholds are inlined as magic numbers throughout `scorePair` and `buildGrpcOnlyToken` (e.g. `0.22`, `0.18`, `45_000`, `350_000`, `cap < 1_500_000 ? 78 : ...`).
- Files: `server/routes.ts:309-371`, `server/routes.ts:451-455`
- Impact: Tuning the scoring requires hand-counting weights in three places. Easy to break score normalization (weights summing past 1.0). Documented as "heuristic, not predictive" in `docs/ARCHITECTURE.md:88` so this is by design but unmaintainable.
- Fix approach: Lift weights into a named constants object (`SCORING_WEIGHTS`) co-located with a unit test that asserts each component sums correctly and the final clamp range is [0,100].

**Wide `any` surface in gRPC parser:**
- Issue: Yellowstone proto types are intentionally accessed as `any` (acknowledged in the file header), but this means a proto schema change from the upstream package will silently produce `null` mints rather than a TypeScript compile error.
- Files: `server/grpcStream.ts:148`, `server/grpcStream.ts:302-368`, `server/grpcStream.ts:438`, `server/grpcStream.ts:490`
- Impact: Upgrading `@triton-one/yellowstone-grpc` could cause `extractAccountKeys` / `extractMints` to return empty arrays, sending `candidateCount` to 0 with `eventsReceived` still high. The `ignoredReasonCounts` diagnostic mitigates detection but not prevention.
- Fix approach: Define narrow Zod schemas for the subset of proto fields actually consumed (`info.transaction.message.accountKeys`, `info.meta.preTokenBalances[].mint`, `info.signature`) and validate before extraction. Keep `any` only at the proto boundary.

**Build allowlist references uninstalled packages:**
- Issue: `script/build.ts:7-31` lists packages in `allowlist` (`@google/generative-ai`, `axios`, `cors`, `express-rate-limit`, `jsonwebtoken`, `multer`, `nanoid`, `nodemailer`, `openai`, `stripe`, `uuid`, `xlsx`) that are not declared in `package.json`. This is presumably copied from a template starter.
- Files: `script/build.ts:7-31`, `package.json`
- Impact: Confusing — implies the project depends on Stripe/OpenAI/etc. when it does not. Also signals the build script wasn't audited for this repo. Harmless at runtime since esbuild externals resolution doesn't require them, but a future contributor will be misled.
- Fix approach: Trim the allowlist to packages actually in `dependencies` (`drizzle-orm`, `drizzle-zod`, `express`, `memorystore`, `passport`, `passport-local`, `ws`, `zod`, `zod-validation-error`).

**Unused auth dependencies:**
- Issue: `package.json` declares `passport`, `passport-local`, `express-session`, `memorystore`, `@supabase/supabase-js`, but no code references them (`grep -rn "passport\|express-session"` in `server/` returns nothing).
- Files: `package.json:43,57,59-63`
- Impact: Bundle bloat, supply-chain surface area for packages that aren't even wired up. Implies a planned auth feature that was never built or was removed without dependency cleanup.
- Fix approach: Either remove or wire them in. The product is described as single-operator (`docs/ROADMAP.md:113`) so removal is likely correct.

**Frontend build-time string substitution for port:**
- Issue: `__PORT_5000__` placeholder pattern in `client/src/lib/queryClient.ts:3` and `client/src/App.tsx:49` — the string `"__PORT_5000__".startsWith("__")` falls through to empty string at runtime, but this is a templating remnant from a template/scaffold. There is no build step that does the substitution.
- Files: `client/src/lib/queryClient.ts:3`, `client/src/App.tsx:49`
- Impact: Dead code masquerading as configurable. A future dev will assume there is a port-rewriting build step that doesn't exist.
- Fix approach: Replace with a plain `const API_BASE = ""` and document that the API is served same-origin.

## Known Bugs

**SSE stream ignores in-process cache and rebuild deadline:**
- Symptoms: `/api/radar/stream` calls `buildSnapshot(true)` directly every `REFRESH_SECONDS * 1000` (20s) on the same `setInterval`, bypassing the in-flight coalescing, the 25s `memoryCache`, and the 12s `RADAR_BUILD_DEADLINE_MS`. Multiple concurrent SSE clients each fire their own forced rebuilds.
- Files: `server/routes.ts:913-939`, contrast with `buildSnapshotWithDeadline` at `server/routes.ts:787-853`
- Trigger: Two or more browser tabs open `/api/radar/stream`; each spawns a parallel forced build every 20s. Under DexScreener slowness this can pile up unbounded background builds even though `/api/radar` callers would have been merged onto one.
- Workaround: Limit clients to one tab; rely on the 25s `memoryCache` keeping `force=false` rebuilds cheap (but `force: true` is what the SSE loop passes). A real fix is to route SSE through `buildSnapshotWithDeadline(false)` and let the cache window reduce work.

**Snapshot-rebuild cleared on `setImmediate` may admit duplicate work:**
- Symptoms: `inflightSnapshot` is cleared via `setImmediate` after build completion (`server/routes.ts:798-800`), so a new caller arriving after the build resolves but before the immediate fires will reuse the resolved promise (intended). However, callers that arrive shortly *after* `setImmediate` clears it but before `memoryCache` is checked will start a brand-new full rebuild — there's no observable bug, but the optimization comment understates the race window.
- Files: `server/routes.ts:787-853`
- Trigger: Burst of `/api/radar` requests at the moment the inflight clears.
- Workaround: None needed unless throughput becomes an issue; `memoryCache` (25s window) absorbs most cases.

**Optional `bufferutil` may cause perf surprises across hosts:**
- Symptoms: `optionalDependencies.bufferutil` (`package.json:103-105`) is used by `ws` for binary frame masking. If install fails on the deploy host, gRPC/WS performance degrades silently.
- Files: `package.json:103-105`
- Trigger: Container has no native build toolchain (some Alpine variants).
- Workaround: Pin `bufferutil` to a prebuild-providing version or document the requirement; a runtime check could log a one-line warning on boot.

**Frontend cannot recover from SSE error:**
- Symptoms: When EventSource `onerror` fires, the client closes the source and never retries until `live` is toggled (`client/src/App.tsx:665-668`). React Query polling does not resume because `refetchInterval` is conditional on `!live` (`client/src/App.tsx:641`).
- Files: `client/src/App.tsx:639-669`
- Trigger: SSE upstream temporarily closes (proxy timeout, deploy restart).
- Workaround: User toggles the live button off and on. Better: re-open EventSource with backoff, or fall back to polling automatically.

## Security Considerations

**No rate limiting on public endpoints:**
- Risk: `/api/radar`, `/api/radar?force=1`, `/api/radar/stream`, `/api/svs/health`, `/api/grpc/status` are all unauthenticated and unbounded. `force=1` triggers a fresh DexScreener + SVS rebuild that costs upstream-API budget; `/api/radar/stream` opens an SSE per request and will keep rebuilding every 20s for the lifetime of the connection.
- Files: `server/routes.ts:855-941`, `server/index.ts` (no `helmet`, no `express-rate-limit`)
- Current mitigation: `RADAR_BUILD_DEADLINE_MS = 12_000`, `inflightSnapshot` coalescing for `/api/radar`, in-memory `memoryCache` 25s. Auth-cooldown protects SVS. None of these protect DexScreener from a determined caller flooding `force=1`.
- Recommendations: Add `express-rate-limit` (per-IP, e.g. 30 req/min for `/api/radar*` and 5 SSE connections per IP). Cap `/api/radar/stream` concurrent client count. Reject `force=1` more than once per 25s globally. Consider basic auth for the radar UI given the single-operator product framing.

**No CORS configuration:**
- Risk: With Express defaults, `Access-Control-Allow-Origin` is not set; same-origin works (since the SPA is served from the same Node process), but cross-origin browser fetches and SSE will fail without a clear error.
- Files: `server/index.ts`
- Current mitigation: SPA is co-served, so this only matters for embedding the UI elsewhere. Not a leak — actually safer than over-permissive CORS.
- Recommendations: Document the same-origin assumption in `docs/RUNBOOK.md`; if a separate UI host is ever introduced, add `cors()` with an explicit allowlist rather than `*`.

**No input validation on query params:**
- Risk: `req.query.force === "1"` (`server/routes.ts:894`) is the only query param parsed. There is no body-validation of mutating endpoints because there are no mutating endpoints. Express body-parser accepts any JSON up to its default limit (`server/index.ts:18-24`).
- Files: `server/index.ts:18-24`
- Current mitigation: Read-only API surface; no SQL or system commands take user input.
- Recommendations: Set an explicit `limit` on `express.json()` (e.g., `'32kb'`) since there are no real bodies to accept; reject any non-empty body on the GET endpoints.

**`dangerouslySetInnerHTML` in chart UI:**
- Risk: `client/src/components/ui/chart.tsx:81` uses `dangerouslySetInnerHTML` to inject CSS variables for theme tokens. The injected content is built from `THEME_CONFIG` keys controlled by code, not user input — but this is an XSS-shaped pattern.
- Files: `client/src/components/ui/chart.tsx:76-95`
- Current mitigation: Input to the template is the chart `config` object passed by the developer, not user data. Token names rendered in charts go through React's normal escaping.
- Recommendations: Confirm chart `config.label` and color values can never accept untrusted data. Currently safe; flag for review if chart config ever becomes user-derived.

**SQLite WAL files exposed in repo path:**
- Risk: `data.db`, `data.db-shm`, `data.db-wal`, `data.db-journal` are correctly gitignored (`.gitignore:5-9`), but the runtime file is created at `process.cwd()/data.db` (`server/storage.ts:7`). On Railway this lives in the container filesystem, which is ephemeral but could leak in a misconfigured volume mount.
- Files: `server/storage.ts:7`, `.gitignore:5-9`
- Current mitigation: Gitignore prevents commit. SQLite holds only the latest radar snapshot — no PII, no secrets.
- Recommendations: Consider making the db path configurable via env so a writable volume can be used for persistence; today a Railway redeploy wipes the snapshot cache.

**Bearer token forwarded via env at request time:**
- Risk: `SVS_API_KEY` is read from `process.env` on every `authHeaders()` call (`server/svs.ts:57-61`). If env is mutated at runtime (via something like a `/admin/reload`), behavior changes mid-request. Currently no such surface exists.
- Files: `server/svs.ts:57-61`, `server/grpcStream.ts:545-546,565-566`
- Current mitigation: No reload endpoint. Auth-cooldown limits damage if the key is invalid (`server/svs.ts:14-21`).
- Recommendations: Read the key once at startup into a captured constant; treat env mutation as out of scope.

**No `helmet` / no security headers:**
- Risk: Server emits no `X-Content-Type-Options`, `Strict-Transport-Security`, `Referrer-Policy`, etc. The SPA exposes only public DexScreener-derived data, so direct exposure is low — but a passive XSS via a future radar field would be uncapped.
- Files: `server/index.ts`
- Current mitigation: React's escaping; same-origin deployment.
- Recommendations: Add `helmet()` middleware with sensible defaults; cheap and standard.

## Performance Bottlenecks

**Sequential SVS batch chunks:**
- Problem: `postBatch` in `server/svs.ts:144-184` iterates chunks of `BATCH_SIZE = 36` mints sequentially within a `for` loop. With `MAX_CANDIDATES = 14` this is a single chunk so today it's fine, but if `MAX_CANDIDATES` ever grows past 36 the latency is `chunks * SVS_TIMEOUT_MS`.
- Files: `server/svs.ts:144-184`, `server/routes.ts:77`
- Cause: `await` inside `for` loop instead of `Promise.all`.
- Improvement path: `await Promise.all(chunk(mints, BATCH_SIZE).map(group => fetch(...)))` and merge all results. Keep `noteAuthRejected` short-circuit by checking the cooldown after the parallel batch.

**Per-candidate DexScreener pair fetch (N+1 pattern):**
- Problem: After the four trending-list fetches, `mapPool(candidates, 7, ...)` issues one HTTP call per mint to `/token-pairs/v1/solana/<address>` with a 7-wide concurrency pool. With 14 candidates that's up to 14 sequential round-trips bucketed in 2 waves of 7.
- Files: `server/routes.ts:598-605`
- Cause: DexScreener does not support a batch token-pairs endpoint at this URL; they offer `/tokens/v1/solana/<addresses-comma>` for batch which the code does not use.
- Improvement path: Switch to the batch tokens endpoint where available; the current pair lookup also fetches all pairs per token then keeps only one (`server/routes.ts:653-655`), which wastes payload.

**Snapshot serialized to JSON string for SQLite write on every build:**
- Problem: Every successful build runs `JSON.stringify(snapshot)` and inserts the entire payload as a TEXT column (`server/routes.ts:766-771`). At ~50–200KB per snapshot (per `server/index.ts:42` comment) and a 20s refresh cycle, that's ~864K writes/day, ~120GB/day of disk churn in WAL on a hot deploy.
- Files: `server/routes.ts:766-771`, `server/storage.ts`
- Cause: SQLite is used as a single-row latest-snapshot cache, but every build appends a new row with no eviction.
- Improvement path: Either upsert into a single-row table (id=1) so disk usage is bounded, or add a periodic `DELETE FROM radar_snapshots WHERE id < (SELECT MAX(id))` job. Documented limitation in `docs/ARCHITECTURE.md:92` (no time-series store) — but the table grows unboundedly today regardless.

**Re-read of full snapshot payload on fallback:**
- Problem: `latestUsableSnapshot` reads the latest row, parses the entire JSON, and returns it; called inside the deadline path (`server/routes.ts:775-785`). With unbounded table growth, `ORDER BY id DESC LIMIT 1` is fine on the index, but parsing 200KB JSON on every fallback adds latency.
- Files: `server/routes.ts:775-785`
- Cause: Fallback path doesn't use the in-process `lastGoodSnapshot` cache when memory cache is empty.
- Improvement path: `lastGoodSnapshot` is already kept in memory; rely on it first (the function does — `server/routes.ts:776`). Combine with bounded-table fix above.

**Unmemoized client list rendering with full token cards:**
- Problem: `RadarHome` renders all `visibleTokens` (up to 24) as `TokenCard` on every state change — `selectedId` change, search input keystroke, theme toggle. `TokenCard` itself isn't memoized and rebuilds avatar img/effects.
- Files: `client/src/App.tsx:830-836`, `client/src/App.tsx:254-316`
- Cause: No `React.memo` on `TokenCard`, `MetaRail`, `SnapshotBar`. `useMemo` only wraps `visibleTokens` and `selectedToken`.
- Improvement path: Wrap `TokenCard` in `React.memo` keyed on `(token.id, active)`, and move the `data-testid` interpolations out of the hot path. With 24 cards this isn't urgent but accumulates with future filters.

**Live SSE forces `buildSnapshot(true)` every 20s per connected client:**
- Problem: Already noted in Known Bugs — multiplies upstream cost by client count.
- Files: `server/routes.ts:913-939`
- Cause: SSE handler doesn't share work via inflight promise.
- Improvement path: Route via `buildSnapshotWithDeadline(false)` so the 25s `memoryCache` and `inflightSnapshot` apply.

## Fragile Areas

**gRPC stream parser:**
- Files: `server/grpcStream.ts:282-428`
- Why fragile: All the proto decoding lives behind `any` casts (`info: any`) with manual fallthrough for `Uint8Array | string | number[]`. A proto schema change, an unexpected nested format from a new program, or a parser exception would silently bump `parseErrorCount` and continue (`server/grpcStream.ts:498-504`). The stream contract is "never let parser errors kill the stream" which is correct for resilience but means breakage manifests as `candidateCount: 0` with no obvious cause beyond `ignoredReasonCounts`.
- Safe modification: Add a sample-event capture toggle (env-gated) that logs one full update payload per program every N minutes for forensics. Wrap each new field access in `try/catch` and bump a named counter.
- Test coverage: Zero. No fixtures of real Yellowstone payloads checked into the repo.

**Snapshot building deadline + cache + inflight interplay:**
- Files: `server/routes.ts:787-853`, `server/routes.ts:538-773`
- Why fragile: Three separate caches/coalescers (`memoryCache`, `inflightSnapshot`, `lastGoodSnapshot`) interact with `withDeadline` and the SSE refresh loop. Edge cases include: deadline fires while build is still running and resolves `inflightSnapshot` later (memory leak risk?), `setImmediate` clearing inflight before the next caller arrives, deadline fallback selecting a `structuredClone` of `memoryCache.snapshot` while the underlying snapshot is being mutated by the still-running build (it isn't — but the assertion is implicit).
- Safe modification: Unit-test the matrix of (cache hit / miss) × (build success / timeout / error) × (lastGood present / absent) on the deadline path. Add a comment block explaining the lifecycle.
- Test coverage: Zero.

**SVS auth cooldown is global mutable state:**
- Files: `server/svs.ts:14-35`
- Why fragile: `authRejectedUntil` and `lastAuthRejectStatus` are module-level. If two batches race and one gets a 401, both will short-circuit subsequent calls correctly, but the state survives across requests with no reset hook. A user fixing their `SVS_API_KEY` in Railway env must wait 5 minutes for the cooldown to expire even though probes (`probeSvsApiReachability`) bypass it.
- Safe modification: Expose a `resetAuthCooldown()` admin endpoint or reset on probe success.
- Test coverage: Zero.

**Frontend EventSource lifecycle:**
- Files: `client/src/App.tsx:658-669`
- Why fragile: An `onerror` event closes the source permanently. Network blips or proxy idle timeouts cause the radar to silently freeze on the last received snapshot.
- Safe modification: Replace with a small custom reconnector (close + setTimeout 2s + reopen, capped attempts) or a known SSE library.
- Test coverage: Zero.

## Scaling Limits

**Single Node process:**
- Current capacity: Worker, snapshot builder, HTTP, SQLite all in one process (`docs/ARCHITECTURE.md:94`).
- Limit: Documented as needing horizontal split before scaling (`docs/ARCHITECTURE.md:94`). Memory pressure from gRPC firehose drives the AMM v4 opt-in design (`docs/ARCHITECTURE.md:82`).
- Scaling path: Extract gRPC worker into its own process and have it write candidates to Redis or a shared queue; HTTP layer reads from there. Multi-process means SQLite needs swap to Postgres.

**Candidate cache 1000-mint hard cap:**
- Current capacity: `CANDIDATE_MAX = 1_000` and `CANDIDATE_TTL_MS = 45 * 60_000` (`server/grpcStream.ts:75-76`).
- Limit: With AMM v4 firehose at multi-thousand events/min, the cache turns over fast. With launchpad-only it's well-bounded.
- Scaling path: Increase cap and add a real LRU rather than insertion-order Map eviction.

**SQLite snapshot table grows unboundedly:**
- Current capacity: One row per 20s × snapshot size (50–200KB) = ~700MB/day at 100KB avg.
- Limit: Disk fills on long-running deploys. Documented in `docs/ARCHITECTURE.md:92` only as "no time-series store" — does not call out unbounded growth.
- Scaling path: Bounded retention (keep last N snapshots) or single-row upsert.

**`MAX_CANDIDATES = 14`:**
- Current capacity: Per-snapshot scoring is bounded to 14 candidate mints (`server/routes.ts:77`).
- Limit: gRPC may emit hundreds of unique mints in a 45-minute window; only 14 ever get DexScreener-pair-checked.
- Scaling path: Tier the budget — top-K from gRPC by recency get a full pair check, the rest surface as `grpc-only` only.

## Dependencies at Risk

**`drizzle-orm` ^0.45.2 with `drizzle-zod` ^0.7.0:**
- Risk: Drizzle has had several breaking schema-API changes in the 0.x line. Pinning to a minor range with caret is liberal.
- Impact: A `npm install` on a fresh box could pick up a newer drizzle that breaks `createInsertSchema` (`shared/schema.ts:11`).
- Migration plan: Ship a `package-lock.json` (already present at the repo root) — and verify lockfile is committed. Pin drizzle to exact versions for production stability.

**`@triton-one/yellowstone-grpc` ^5.0.8:**
- Risk: Rapidly evolving SDK. Proto field names have shifted historically.
- Impact: All gRPC parsing breaks silently if the proto layout changes (covered in fragile-areas above).
- Migration plan: Pin to exact version; add a smoke test that runs the parser against a fixture; CI-gated upgrade.

**`vite` ^7.3.0:**
- Risk: Vite 7 is recent and bundling/SSR semantics shift across majors. The dev server flow imports `./vite` dynamically (`server/index.ts:113`).
- Impact: `npm run dev` could break on dependency drift.
- Migration plan: Lockfile holds it; explicit pin if drift becomes a problem.

**`better-sqlite3` ^11.7.0:**
- Risk: Native module; rebuild required when Node major changes. The Dockerfile/Railway build runs `npm install` so fresh deploys are fine, but local-then-deploy flow can break.
- Impact: Container failed to boot if native module ABI mismatches.
- Migration plan: Document Node version requirement; consider `engines` field in `package.json` (currently absent).

**Unused dependencies enlarge attack surface:**
- Risk: `passport`, `passport-local`, `express-session`, `memorystore`, `@supabase/supabase-js` are installed but unused.
- Impact: Unnecessary supply-chain exposure and bundle size.
- Migration plan: Remove or wire up. See Tech Debt section.

## Missing Critical Features

**No authentication on the radar UI / API:**
- Problem: All endpoints are open. The product is described as "single operator deploys" (`docs/ROADMAP.md:113`) but has no access control.
- Blocks: Public Railway URL exposes the radar to anyone who guesses the domain. They can hit `/api/radar?force=1` to burn the operator's SVS API quota and DexScreener rate-limit budget.

**No protocol-specific decoders:**
- Problem: gRPC parser is generic — reads token-balance deltas only, doesn't decode pool-create / launch instructions per protocol. Documented as P1.1 gap (`docs/ROADMAP.md:37-54`, `docs/ARCHITECTURE.md:89`).
- Blocks: Cannot tag launches by event type (`launch.created`, `pool.created`, `launch.graduated`); cannot expose creator wallet, initial liquidity, decimals.

**No on-chain risk signals:**
- Problem: Mint authority, freeze authority, top-holder concentration, creator-wallet history are all absent. Documented as P1.2 (`docs/ROADMAP.md:56-67`, `docs/ARCHITECTURE.md:90`).
- Blocks: The risk score is heuristic over DexScreener metrics; cannot detect unrenounced mint authority — the most basic rug indicator.

**No social-virality ingestion:**
- Problem: "Virality" today is derived from on-chain trading + boosts only; no X / Telegram / Discord ingestion (`docs/ROADMAP.md:69-78`, `docs/ARCHITECTURE.md:91`).
- Blocks: The radar misses tokens going viral on social before on-chain volume reflects it.

**No backtesting / time-series store:**
- Problem: SQLite holds only the most recent snapshot for fallback. P2.1 in roadmap (`docs/ROADMAP.md:85-93`).
- Blocks: Cannot compute hit-rate metrics, replay scoring evolution, or backtest scoring tweaks.

**No execution path:**
- Problem: Observation only. Documented as deliberately deferred P2.2 (`docs/ROADMAP.md:95-102`).
- Blocks: User must manually copy mint to a separate wallet/UI to act on signals — by design.

**No automated test suite:**
- Problem: No `*.test.ts`, `*.spec.ts`, no Vitest/Jest config.
- Blocks: All scoring/decoder/cache changes ship without regression coverage. See Test Coverage Gaps.

## Test Coverage Gaps

**Scoring functions:**
- What's not tested: `scorePair` and `buildGrpcOnlyToken` — the core product logic. Weight tuning, edge cases (zero liquidity, missing pair age, NaN priceUsd), risk flag thresholds.
- Files: `server/routes.ts:263-422`, `server/routes.ts:425-517`
- Risk: Silent score regressions when DexScreener payload shape changes or when refactoring lifted constants.
- Priority: High.

**Meme classifier:**
- What's not tested: `classifyMeme` regex matching (`server/routes.ts:217-241`).
- Files: `server/routes.ts:217-241`
- Risk: Regex-overlap bugs (e.g., a token matching both "dog" and "AI") are invisible. Adding a new category easily breaks the existing precedence order.
- Priority: Medium.

**gRPC parser:**
- What's not tested: `processTransactionUpdate`, `extractAccountKeys`, `extractMints`, `findWatchedProgram` (`server/grpcStream.ts:282-428`).
- Files: `server/grpcStream.ts`
- Risk: A proto change or a malformed update would change `candidateCount` semantics with no compile-time signal.
- Priority: High — this is the live-data ingress; everything downstream depends on it.

**Snapshot deadline / cache / inflight:**
- What's not tested: The `withDeadline` helper, `buildSnapshotWithDeadline` fallback selection, `memoryCache` TTL boundaries, `inflightSnapshot` clearing.
- Files: `server/routes.ts:87-114`, `server/routes.ts:787-853`
- Risk: Race conditions surface only under load; one tab works fine, three tabs OOM the container.
- Priority: High.

**SVS client:**
- What's not tested: `postBatch` chunking, auth-cooldown trigger and bypass for probes, `recordsByMint` polymorphic input handling (array, `{data}`, `{results}`, mint-keyed object).
- Files: `server/svs.ts`
- Risk: SVS API response format is taken on faith; a shape change silently zeroes enrichment.
- Priority: Medium.

**Frontend rendering / SSE:**
- What's not tested: `RadarHome`, EventSource reconnection, filter/search behaviors, CSV export quoting (`exportCsv` at `client/src/App.tsx:597-626` uses naive `replaceAll('"', '""')` quoting which is correct but worth a unit test).
- Files: `client/src/App.tsx`
- Risk: UI regressions only catchable by manual click-through.
- Priority: Medium.

**Storage layer:**
- What's not tested: `DatabaseStorage.saveRadarSnapshot` / `getLatestRadarSnapshot`, schema migrations (none today — SQLite table is `CREATE TABLE IF NOT EXISTS`).
- Files: `server/storage.ts`
- Risk: Drizzle version drift could change `returning().get()` semantics.
- Priority: Low (single trivial usage).

---

*Concerns audit: 2026-05-04*
