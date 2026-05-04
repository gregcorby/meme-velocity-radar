# Concerns

The project is in a deliberately stable "P0 stabilise" state per `docs/ROADMAP.md`, so most concerns below are correctness / hygiene issues that the next milestone (P1) will need to clear, not active outages.

---

## HIGH

### H1. `radar_snapshots` table grows unbounded (append-only, never pruned)
**Where:** `server/storage.ts:7-32`, write site `server/routes.ts:766-771`.
**Problem:** `saveRadarSnapshot` does a plain `INSERT … RETURNING` on every successful `buildSnapshot`. There is no `DELETE`, no `LIMIT`, no upsert, and no scheduled prune. Each row stores the full JSON `payload` (`scannedTokens` plus up to 24 `tokens` plus `metas`, typically 50–200KB per row per `summarizeResponseBody` evidence in `server/index.ts:42-65`). With `REFRESH_SECONDS = 20` (`server/routes.ts:76`) the cache opens the door to a write per ~25s under any pull traffic, and `/api/radar/stream` calls `buildSnapshot(true)` on every tick (`server/routes.ts:921-934`).
**Impact:** On a default Railway container the SQLite file grows by hundreds of MB per day with light traffic and several GB per day under SSE load, which violates P0 acceptance criterion #3 ("container memory stays flat … no Railway restart"). It will also make `getLatestRadarSnapshot()` (`ORDER BY id DESC LIMIT 1`) slower over time because the table scan walks an ever-larger B-tree page set.
**Fix:** Either (a) keep one row using `INSERT OR REPLACE INTO radar_snapshots(id, captured_at, payload) VALUES (1, ?, ?)` and treat the table as a single-row cache, or (b) keep the append-only design but add a TTL cleanup at write time: `DELETE FROM radar_snapshots WHERE id < (SELECT max(id) - 200 FROM radar_snapshots)`. Run `VACUUM` on startup after pruning to actually reclaim disk.

### H2. `/api/radar`, `/api/radar/stream`, `/api/grpc/status`, `/api/svs/health` have no rate limiting, no auth, no `Cache-Control`
**Where:** `server/routes.ts:856-941`. No middleware in `server/index.ts:9-89`.
**Problem:** All four routes are world-readable with zero protection. `/api/radar/stream` opens an SSE connection that triggers `buildSnapshot(true)` (forced cache bypass) every `REFRESH_SECONDS * 1000`ms (`server/routes.ts:934`) and **does not** route through the in-flight coalescer `buildSnapshotWithDeadline` (`server/routes.ts:787-805`). Every additional SSE client therefore launches its own concurrent fan-out of 4 DexScreener calls + SVS metadata/price/mint_info + up to 14 pair lookups. The non-stream `/api/radar` returns no `Cache-Control` header at all, so intermediaries (and the browser) treat responses as freely cacheable while the dataset is actually live.
**Impact:** A single curl loop or N tabs will saturate the DexScreener allowance, push the SVS API into the 401/403 cooldown (`server/svs.ts:14-21`), and exhaust the 12s `RADAR_BUILD_DEADLINE_MS`. Status endpoints can also be used as cheap unauthenticated probes for whether the operator has SVS keys installed (`hasToken`, `endpointConfigured`, `watchedPrograms` are all returned).
**Fix:** Add `express-rate-limit` keyed on `req.ip` with a tight window for `/api/radar*` (e.g. 10 req/min) and a looser window for status routes. Set `Cache-Control: no-store` on `/api/radar` and `/api/radar/stream`, `Cache-Control: max-age=10` on `/api/grpc/status`, and `Cache-Control: max-age=30` on `/api/svs/health`. Make `/api/radar/stream` reuse `buildSnapshotWithDeadline(false)` instead of `buildSnapshot(true)` so multiple SSE clients share work, and cap simultaneous SSE connections (drop with 503 if a counter exceeds 5). If exposure must stay public, at least strip `watchedPrograms` from `getGrpcStatus()` before returning over the wire.

### H3. `script/build.ts` allowlist is wildly out of sync with `package.json`
**Where:** `script/build.ts:7-31`; cross-reference `package.json:13-104`.
**Problem:** The `allowlist` lists 23 packages to bundle into `dist/index.cjs`. Of those, **13 are not declared anywhere in `package.json`**: `@google/generative-ai`, `axios`, `cors`, `express-rate-limit`, `jsonwebtoken`, `multer`, `nanoid`, `nodemailer`, `openai`, `stripe`, `uuid`, `xlsx`. Conversely, several declared and actually-used server deps are *not* on the allowlist, so they ship as `external` and are loaded via `require()` at runtime: `@triton-one/yellowstone-grpc`, `better-sqlite3`, `bs58`, `dotenv`. Worse: `nanoid` is genuinely imported in `server/vite.ts:7` (used only in dev) but is not a declared dependency — it currently resolves only as a transitive of vite/drizzle-kit and will silently break if either drops it.
**Impact:** Build succeeds because esbuild treats unknown allowlist entries as no-ops, but the comment at line 5 ("bundle to reduce openat(2) syscalls / cold start") is a lie — the things the comment cares about (gRPC, sqlite, dotenv) are still external. Future maintainers copying this file will silently bundle nothing useful. Bundling `bs58` and `dotenv` would make a measurable difference on Railway cold starts.
**Fix:** Replace the allowlist with the actual server runtime imports. Concretely: include `dotenv`, `bs58`, `drizzle-orm`, `drizzle-zod`, `express`, `ws`, `zod`, `zod-validation-error`, `date-fns`. Keep `@triton-one/yellowstone-grpc` and `better-sqlite3` external (they ship native bindings that esbuild cannot bundle). Add `nanoid` to `dependencies` in `package.json` (or replace the cache-buster in `server/vite.ts:49` with `Date.now().toString(36)`). Delete every allowlist entry whose package is not in `package.json` so the file is self-validating.

### H4. ~10 unused but installed dependencies; auth/session stack carries no implementation
**Where:** `package.json:13-80`.
**Problem:** Greps across `server/`, `client/src/`, `shared/`, `script/` show zero imports for: `@hookform/resolvers`, `@supabase/supabase-js`, `framer-motion`, `next-themes`, `react-icons`, `passport`, `passport-local`, `express-session`, `memorystore`. The Passport + express-session + memorystore trio implies a session/auth subsystem that does not exist; nothing in `server/index.ts` mounts session middleware. `@supabase/supabase-js` is a 500KB+ runtime that is not referenced.
**Impact:** ~3-5MB of `node_modules` bloat, slower CI installs, and a confusing surface area for a new contributor who will reasonably assume there is an auth path to wire into. It also enlarges the supply-chain attack surface by ~10 packages plus their transitives. The presence of `passport-local` is particularly misleading because H2 above flags the API as unauthenticated.
**Fix:** Remove from `package.json`: `@hookform/resolvers`, `@supabase/supabase-js`, `framer-motion`, `next-themes`, `react-icons`, `passport`, `passport-local`, `@types/passport`, `@types/passport-local`, `express-session`, `@types/express-session`, `memorystore`. Run `npm install` and commit the lockfile delta. If auth lands later, add it back deliberately. Keep `recharts`, `wouter`, `cmdk`, `embla-carousel-react`, `vaul`, `react-day-picker`, `input-otp`, `react-hook-form`, `react-resizable-panels` — they are all imported by `client/src/components/ui/*`.

### H5. SSE handler bypasses the in-flight coalescer and has no heartbeat or backpressure
**Where:** `server/routes.ts:913-939`.
**Problem:** The handler calls `buildSnapshot(true)` directly (line 924) instead of `buildSnapshotWithDeadline(false)`, so each SSE client triggers an independent forced rebuild every 20s; the `inflightSnapshot` deduplication only protects `/api/radar`. There is also no SSE heartbeat (`: keepalive\n\n` comment), so proxies and Cloudflare-style edges will silently drop the connection after their idle timeout. There is no backpressure check on `res.write()` — under a slow client, the Node socket buffer can grow unbounded. Finally, if `buildSnapshot` rejects, the error path writes an `event: error` frame but does not close the connection, so a persistently failing upstream produces an error frame every 20s forever.
**Impact:** Multiplies upstream API cost linearly with SSE clients, makes the stream brittle behind any reverse proxy, and leaks memory under slow consumers. Combined with H2 (no rate limiting, no client cap), one badly-behaved client can degrade the whole worker.
**Fix:** (a) Replace `buildSnapshot(true)` with `buildSnapshotWithDeadline(false)`; the existing 20s polling already provides freshness. (b) Send a `: ping\n\n` comment every 15s. (c) Track `res.writableNeedDrain` and skip a tick when true. (d) After 3 consecutive errors, write a final frame, call `res.end()`, and stop the interval. (e) Add a module-level `Set<Response>` of active streams capped at 5 and reject the 6th with 503.

### H6. `inflightSnapshot` reset uses `setImmediate`, which can wedge the deadline-fallback path
**Where:** `server/routes.ts:787-805`.
**Problem:** When a `buildSnapshot` exceeds `RADAR_BUILD_DEADLINE_MS` (12s), the wrapping `withDeadline` resolves to a cached fallback, **but `inflightSnapshot` is still pointing at the slow-running build**. Every subsequent caller within that build's lifetime races onto the same `inflightSnapshot` promise and immediately hits the deadline path again, so the user sees the "deadline" `sourceHealth` line for tens of seconds even though the actual build will eventually succeed. The reset only happens via `setImmediate` after the build settles, not when the deadline fires.
**Impact:** Under a single slow DexScreener fetch, the dashboard shows degraded snapshots for the full duration of the slow upstream rather than just one cycle. This violates the "stale-while-rate-limited" UX the cache was supposed to provide.
**Fix:** Track build start time and let `buildSnapshotWithDeadline` start a fresh build when `Date.now() - startedAt > RADAR_BUILD_DEADLINE_MS` even if `inflightSnapshot` is non-null. Alternatively, in the `withDeadline` `onTimeout` callback, also clear `inflightSnapshot` so the next caller can start a new build (the old promise's eventual `setImmediate` reset becomes a harmless no-op).

---

## MEDIUM

### M1. `__PORT_5000__` placeholder branch is dead code with a misleading name
**Where:** `client/src/lib/queryClient.ts:3`, `client/src/App.tsx:49`.
**Problem:** Both files compute `const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__"`. The literal `"__PORT_5000__"` always starts with `__`, so the ternary unconditionally evaluates to `""`. The branch that returns the placeholder is unreachable. Whatever tool was supposed to substitute this token (looks like a Replit deploy artefact) is not part of this codebase.
**Impact:** New maintainers see two distinct constants (`API_BASE` vs `EVENT_BASE`) and assume there is a configurable base URL, when in fact both are hard-coded to "" (same-origin). The name `EVENT_BASE` for an SSE endpoint is also confusing because it suggests a separate origin.
**Fix:** Replace both with `const API_BASE = ""` (or import it from a shared `client/src/lib/config.ts`). Delete `EVENT_BASE` and use `API_BASE` directly in the `EventSource` call. If a configurable base is genuinely wanted later, read `import.meta.env.VITE_API_BASE` once and document it in `.env.example`.

### M2. `client/src/App.tsx` is a 924-line monolith
**Where:** `client/src/App.tsx:1-924`.
**Problem:** The file contains the router, theme hook, formatters (`fmtMoney`, etc.), CSV exporter, sidebar, header, multiple cards, `RadarHome`, the SSE wiring, and the detail sheet — 100+ functions/consts in a single file. There are no tests and no smaller surface area to import for storybook-style review.
**Impact:** Every change touches the same file, making review painful and turning the file into a merge-conflict magnet. Tree-shaking is fine because Vite handles it, but cognitive load is the real cost.
**Fix:** Split into `client/src/App.tsx` (router only), `client/src/pages/RadarHome.tsx`, `client/src/lib/format.ts` (`fmtMoney`, `fmtPercent`, `compactUrlLabel`), `client/src/lib/exportCsv.ts`, `client/src/components/Sidebar.tsx`, `client/src/components/Header.tsx`, `client/src/components/TokenDetailSheet.tsx`, `client/src/hooks/useTheme.ts`, `client/src/hooks/useRadarStream.ts`. Aim for ~150 lines/file.

### M3. `server/routes.ts` is a 942-line god-file mixing scoring, fetching, caching, and HTTP
**Where:** `server/routes.ts:1-942`.
**Problem:** The file holds DexScreener client code, scoring heuristics (`scorePair` 160 lines), gRPC-only token fabrication (`buildGrpcOnlyToken`), the snapshot builder, the deadline wrapper, the in-flight coalescer, **and** the route handlers. Pure scoring logic cannot be unit-tested without spinning up Express. Module-level mutable state (`memoryCache`, `lastGoodSnapshot`, `inflightSnapshot`) is interleaved with stateless helpers.
**Impact:** Hard to add unit tests for the scoring math (the most decision-critical code in the project) without also stubbing fetch and storage. Large surface area for regressions.
**Fix:** Extract `server/scoring.ts` (`scorePair`, `buildGrpcOnlyToken`, `classifyMeme`, `firstSentence`, `compactUrlLabel`, `clamp`, `n`, `safeString`, `logNorm`), `server/dexscreener.ts` (`fetchJson`, `mapPool`, `DEX` constant), `server/snapshot.ts` (`buildSnapshot`, `buildSnapshotWithDeadline`, cache state). Keep `server/routes.ts` under 200 lines of HTTP wiring.

### M4. `data.db` path is relative — depends on cwd
**Where:** `server/storage.ts:7`, `drizzle.config.ts:8`.
**Problem:** `new Database("data.db")` resolves relative to `process.cwd()`. In `npm run dev` and `npm start` (`package.json:7-9`) this happens to be the repo root, but any deployment that `cd`s elsewhere (or any future systemd unit / Docker `WORKDIR` change) will silently create a fresh empty database next to the new cwd. The previous database becomes orphaned but is not deleted, so two databases can coexist.
**Impact:** Lost history on path changes; confusing debugging when "the snapshot persists locally but not on Railway". Also makes it impossible to put the DB on a mounted persistent volume without a path override.
**Fix:** Read `process.env.DATABASE_PATH` with a default of `path.resolve(import.meta.dirname, "..", "data.db")` and use that in both `server/storage.ts` and `drizzle.config.ts`. Document the env var in `.env.example`.

### M5. `@assets` vite alias points to a directory that does not exist
**Where:** `vite.config.ts:11`.
**Problem:** `"@assets": path.resolve(import.meta.dirname, "attached_assets")` — but `attached_assets/` is not present in the repo. Likely a leftover from a Replit template. No file imports from `@assets`, so the build does not fail, but the alias is a tripwire: someone will eventually `import logo from "@assets/logo.png"`, get a confusing "file not found" error, and waste time figuring out the alias is stale.
**Impact:** Latent footgun; minor cognitive cost.
**Fix:** Delete the `@assets` alias from `vite.config.ts:11`. If assets land later, create `client/src/assets/` and rely on the standard `@/assets/...` path via the existing `@` alias.

### M6. No `unhandledRejection` / `uncaughtException` handler; DB write failures are swallowed silently
**Where:** `server/index.ts:1-147`, `server/routes.ts:766-771`.
**Problem:** The Express error middleware (`server/index.ts:94-105`) only catches errors propagated through Express. The gRPC worker runs in a fire-and-forget `void runStreamLoop(...)` (`server/grpcStream.ts:557`); any rejection inside that escapes the inner try/catch becomes an unhandled rejection. The fire-and-forget `storage.saveRadarSnapshot(...).catch(() => undefined)` silences DB write failures completely — a corrupt or full disk produces no log line.
**Impact:** Silent failures in two of the most important async paths (DB writes and the gRPC worker). Future Node versions terminate on unhandled rejection by default, which would crash the server.
**Fix:** In `server/index.ts`, register `process.on("unhandledRejection", (reason) => log(...))` and `process.on("uncaughtException", (err) => log(...))` immediately after the dotenv import. Replace the silent `.catch(() => undefined)` in `server/routes.ts:771` with `.catch((err) => log("snapshot persist failed: " + err.message, "storage"))`.

### M7. `parseInt(process.env.PORT, 10)` accepts garbage and binds to NaN
**Where:** `server/index.ts:121`.
**Problem:** `parseInt("abc", 10)` returns `NaN`, and `httpServer.listen({ port: NaN, host: ... })` throws asynchronously inside Node's libuv layer with a confusing message. There is no validation that `PORT` is a positive integer in `[1, 65535]`.
**Impact:** Misconfigured `PORT` env produces a boot-time crash with a misleading stack trace.
**Fix:** `const port = (() => { const raw = process.env.PORT; if (!raw) return 5000; const n = Number(raw); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(\`invalid PORT: \${raw}\`); return n; })();`

---

## LOW

### L1. `console.error` in gRPC parser hot path is uncapped
**Where:** `server/grpcStream.ts:498-504`, also `server/grpcStream.ts:533`.
**Problem:** `processTransactionUpdate` increments `parseErrorCount` and prints `[grpc] update parse error:` for every failed parse, with no rate limit or sampling. Under a malformed-update flood (or a yellowstone proto change) this can produce thousands of lines per minute and push the Railway log pipeline over its rate limit, which then drops *useful* logs too. The reconnect log on line 533 has the same issue if the stream flaps.
**Impact:** Log-volume DoS in the worst case; otherwise just noise. The diagnostics counter `parseErrorCount` already provides aggregate visibility.
**Fix:** Throttle to one log per 60s: `if (Date.now() - lastParseErrorLogAt > 60_000) { console.error(...); lastParseErrorLogAt = Date.now(); }`. Keep the counter increment outside the throttle so the diagnostic stays accurate.

### L2. SQLite WAL `.gitignore` lists the wrong sidecar file
**Where:** `.gitignore:6-9`, `server/storage.ts:8`.
**Problem:** The code sets `journal_mode = WAL` (`server/storage.ts:8`), so the actual sidecar files at runtime are `data.db-shm` and `data.db-wal`. `data.db-journal` (the rollback-journal file) is not produced in WAL mode. The `.gitignore` line for it is harmless but misleading. Also missing: a wildcard like `data.db-*` that would defend against future SQLite versions adding new sidecar suffixes.
**Impact:** None today; cosmetic and confusing.
**Fix:** Replace lines 6-9 with two lines: `data.db` and `data.db-*`. Delete the `data.db-journal` entry. Add a comment that the wildcard covers `-wal`, `-shm`, and any future SQLite sidecars.

### L3. CSV export double-quotes every cell, including raw numbers
**Where:** `client/src/App.tsx:597-626`.
**Problem:** `row.map((cell) => \`"${String(cell).replaceAll('"', '""')}"\`)` quotes everything. RFC 4180 permits this but Excel and Google Sheets then treat the numeric columns (`market_cap`, `liquidity`, `volume_*`) as text by default, so spreadsheet sorting breaks until the user manually re-types each column.
**Impact:** Mild UX papercut for the CSV export feature.
**Fix:** Quote only when the cell contains `"`, `,`, `\n`, or starts/ends with whitespace: `const needsQuote = /[",\n\r]/.test(s) || /^\s|\s$/.test(s); return needsQuote ? \`"${s.replaceAll('"', '""')}"\` : s;`. Numeric columns will then export unquoted.

### L4. `dangerouslySetInnerHTML` in the chart theme injector is not currently exploitable but lacks defensive escaping
**Where:** `client/src/components/ui/chart.tsx:81`.
**Problem:** The shadcn chart component generates a `<style>` block via `dangerouslySetInnerHTML` from a `colorConfig` object whose values are passed into a CSS-variable string. The values are not user input today, but if a future caller passes a token symbol or other server-derived string into the chart config, that string will land inside `<style>` with no escaping.
**Impact:** Latent XSS if untrusted strings ever reach the chart config. Not currently exploitable because no caller does that.
**Fix:** Whitelist allowed CSS-color characters before interpolation: `const safe = (v: string) => v.replace(/[^a-zA-Z0-9#().,%\\s-]/g, "")`. Apply it to every value before composing the style block.

### L5. `WATCH_PROGRAMS` is evaluated at module import time, coupling correctness to import order
**Where:** `server/grpcStream.ts:136`, `server/index.ts:1-7`.
**Problem:** `WATCH_PROGRAMS = loadWatchPrograms()` runs the moment `server/grpcStream.ts` is parsed. This works only because `server/index.ts` imports `dotenv/config` *before* importing `./grpcStream`, so `process.env.WATCH_*` is populated in time. If anyone reorders the imports, `WATCH_PROGRAMS` will silently load with empty values and the worker will report `no watched programs configured`.
**Impact:** Silent misconfiguration on import-order changes; tests that try to set env per-case cannot do so without re-importing.
**Fix:** Move `WATCH_PROGRAMS` evaluation inside `startGrpcWorker` (compute on first call, cache to a module-level `let`). That removes the import-order coupling and lets tests pass alternate env without a process restart.

---

## Things checked and clean

- **No SQL injection.** All DB access goes through Drizzle's parameterised query builder (`server/storage.ts:26-30`). The single raw `sqlite.exec` (`server/storage.ts:9-15`) is a static `CREATE TABLE IF NOT EXISTS` with no interpolation.
- **No `eval` and no `new Function(...)`.** Verified by `grep -rn "eval(\|new Function(" server/ client/src/ shared/` — zero hits.
- **No leaked secrets.** `SVS_API_KEY` and `SVS_GRPC_X_TOKEN` are read in `server/svs.ts:58` and `server/grpcStream.ts:546` and never returned to a client, never logged, and never serialized into snapshots. `getGrpcStatus()` exposes only `hasToken: boolean` (a presence flag), not the value. There are zero `VITE_`-prefixed env vars in `client/src/`.
- **No `any`-leak from `grpcStream.ts` to the rest of the app.** All `any` access is fenced into the parser helpers (`extractAccountKeys`, `extractMints`, `processTransactionUpdate`); the public exports `GrpcStatus` and `GrpcCandidate` are fully typed (`server/grpcStream.ts:11-58`).
- **gRPC parse errors do not kill the worker.** The `try/catch` inside the `data` handler (`server/grpcStream.ts:489-503`) increments a counter and logs; `runStreamLoop` (`server/grpcStream.ts:521-541`) reconnects with exponential backoff capped at 30s.
- **DexScreener fetches are deadline-bounded twice.** `AbortController` timeout *and* a `Promise.race` hard deadline (`server/routes.ts:139-178`) defend against event-loop starvation that could delay the abort timer.
- **SSE handler cleans up on client disconnect.** `req.on("close", () => { closed = true; clearInterval(interval); })` (`server/routes.ts:935-938`) prevents the interval from leaking after a hangup. (Backpressure and heartbeat are still missing — see H5.)
- **Snapshot fallback chain is layered correctly.** Memory cache → `lastGoodSnapshot` → SQLite-persisted last snapshot → empty well-formed snapshot (`server/routes.ts:775-851`). Each layer is reached only when the previous fails.
- **No hardcoded credentials or production URLs that should be env-driven.** The only hardcoded URL is `https://api.dexscreener.com` (`server/routes.ts:74`), which is the intended public endpoint and has no auth. SVS endpoints all flow through `process.env.SVS_*`.
- **`zod` schemas mirror the runtime shapes.** `shared/schema.ts:33-122` validates `RadarSnapshot`, `TokenSignal`, `MetaSignal`, and `GrpcSummary` end-to-end and is shared between server and client.

---

*Concerns audit: 2026-05-04*
