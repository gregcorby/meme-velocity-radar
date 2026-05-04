# Concerns — Tech Debt, Bugs, Risks

**Analysis Date:** 2026-05-04

The radar is in a deliberately stable state (`docs/ROADMAP.md` P0 = "stabilise"). The list below is the gap between current and "boring and predictable", grouped by severity.

---

## Severity: HIGH

### H1. Snapshots table grows unbounded — no pruning

**Where:** `server/storage.ts:25-31`, `shared/schema.ts:5-9`.

**Problem:** Every successful `/api/radar` build appends a row to `radar_snapshots` (with `payload` = the full JSON snapshot, typically 50–200 KB). The table is never pruned. Only the latest row is ever queried (`getLatestRadarSnapshot()` does `orderBy(desc(id)).limit(1)`). At a 20 s refresh that is 4,320 inserts/day → ~430 MB/day of SQLite growth, all of it dead weight. On a small Railway container this exhausts disk within days.

**Impact:** Disk OOM on long-running deploys; slower `INSERT` over time as the WAL grows; backups become unwieldy.

**Fix:** Either (a) add a `DELETE FROM radar_snapshots WHERE id < (SELECT MAX(id) - K)` after each insert (keep the last K snapshots, e.g. K = 50), or (b) flip `saveRadarSnapshot` to an UPSERT on a single fixed-id row. Option (b) is the cleaner fit because the table is already used as a single-row cache. If you ever want a time-series, that's a different table with retention from day one.

---

### H2. `/api/radar` and `/api/radar/stream` have no rate limit, no cache key, no auth

**Where:** `server/routes.ts:893-911` (`/api/radar`), `server/routes.ts:913-939` (`/api/radar/stream`).

**Problem:** A public radar URL on Railway is hit by anyone who finds it. Both endpoints proxy DexScreener and SVS. There is:
- No `express-rate-limit` (the package is in the `script/build.ts` allowlist but not in `package.json`).
- No CDN / cache header on `/api/radar` — every request is a fresh build (mitigated by the 25 s in-process `memoryCache`, but the cache key does not differentiate `?force=1` correctly: any caller passing `force=1` bypasses the cache for everyone).
- No IP/per-key throttle on the SSE stream — N open EventSource connections all push every 20 s.

**Impact:** A single bored user holding 100 SSE tabs open will keep the server permanently building snapshots; if DexScreener rate-limits us we lose the fallback path entirely.

**Fix:** Add `express-rate-limit` to `package.json`, apply a global limit on `/api/*`, and add a per-IP cap on `/api/radar/stream` concurrent connections. Add `Cache-Control: public, max-age=15` on `/api/radar` for non-`force` calls.

---

### H3. Build-script allowlist references packages not installed

**Where:** `script/build.ts:7-31`.

**Problem:** The `allowlist` (deps that get bundled into `dist/index.cjs`) lists 21 packages, but only 9 are present in `package.json` dependencies. The missing entries — `@google/generative-ai`, `axios`, `cors`, `express-rate-limit`, `jsonwebtoken`, `multer`, `nodemailer`, `openai`, `stripe`, `uuid`, `xlsx`, `nanoid` — appear to be scaffold residue from another project. The build still succeeds because esbuild silently treats absent allowlist entries as "no override" (everything not present in `package.json` is automatically external by virtue of the filter). However:

- The list is misleading documentation. A reader will assume those packages are deliberately bundled.
- If `script/build.ts` is ever changed to throw on unknown allowlist entries, the build breaks.
- It hides what is actually bundled — the real bundled set is the **intersection** of the allowlist with `package.json` deps.

**Fix:** Replace the hard-coded allowlist with the actual list of deps you want bundled, computed against `package.json` at build time. Or document why the historical list is left in place (and add a check that warns on misses).

---

### H4. Unused dependencies pulled in by scaffold (auth, Supabase, Pump-related deps)

**Where:** `package.json` dependencies; not imported anywhere in `server/` or `client/`.

- `passport` 0.7.0, `passport-local` 1.0.0, `@types/passport*` — auth scaffolding.
- `express-session` 1.18.1 + `memorystore` 1.6.7 — session scaffolding.
- `@supabase/supabase-js` 2.49.4 — Supabase client.
- `framer-motion` 11.13.1 — barely used.
- `recharts` 2.15.2 — chart library; minimal usage.
- `embla-carousel-react`, `react-day-picker`, `react-resizable-panels`, `vaul`, `cmdk`, `input-otp`, `react-icons`, `next-themes`, `tw-animate-css`, `@tailwindcss/vite` — shadcn-pulled but not all referenced.

**Impact:** Larger `node_modules` (slows Railway builds), larger lockfile, broader supply-chain attack surface, version-bump churn for code you don't run.

**Fix:** Audit each, remove or actually-use. `npx depcheck` would surface the full set. Removing the auth set (passport/express-session/memorystore) is the highest-leverage quick win — none of it is wired and it's the most invasive scaffolding to keep around.

---

## Severity: MEDIUM

### M1. `client/src/App.tsx` is 924 lines in one file

**Where:** `client/src/App.tsx`.

**Problem:** Every component (`Logo`, `SvsBadge`, `GrpcBadge`, `ScorePill`, `TokenAvatar`, `TokenCard`, `DetailPanel`, `MetaRail`, `SnapshotBar`, `RadarHome`, `AppRouter`, `App`), every formatter (`fmtMoney`, `fmtPct`, `fmtAge`, `scoreTone`, `riskTone`, `trendIcon`, `normalizeChart`), the `exportCsv` helper, and the `RadarHome` page state all live in one file. The component graph is shallow but the file is at the point where every change carries a wide blast radius.

**Impact:** Slows every UI change; merge conflicts; impossible to lazy-load any part of the page; React Refresh boundaries are coarse.

**Fix:** Split per existing structure cue:
- `client/src/components/header/SvsBadge.tsx`, `GrpcBadge.tsx`, `Logo.tsx`
- `client/src/components/radar/TokenCard.tsx`, `TokenAvatar.tsx`, `ScorePill.tsx`, `DetailPanel.tsx`, `MetaRail.tsx`, `SnapshotBar.tsx`
- `client/src/lib/format.ts` for `fmtMoney/fmtPct/fmtAge/scoreTone/riskTone/trendIcon/normalizeChart`
- `client/src/lib/csv.ts` for `exportCsv`
- `client/src/pages/Radar.tsx` for `RadarHome`
- `App.tsx` keeps only theme + providers + router.

Treat as a multi-step refactor; do one component at a time so PRs stay reviewable.

---

### M2. `server/routes.ts` is 942 lines with three responsibilities

**Where:** `server/routes.ts`.

**Problem:** The file mixes (a) the DexScreener fetcher, (b) the per-token scoring + meme-narrative classifier, and (c) the HTTP route handlers. The scoring code (`scorePair`, `classifyMeme`, `firstSentence`, `buildLinks`) is the most product-critical logic in the repo and is buried in the same file as the SSE handler.

**Fix:** Extract:
- `server/dexscreener.ts` for `fetchJson`, the trending/profiles/boosts fetchers, the result-object types.
- `server/scoring.ts` for `scorePair`, `classifyMeme`, `firstSentence`, `buildLinks`, `logNorm`, `getTxns`, `getVolume`, `getChange`.
- `server/snapshot.ts` for `buildSnapshot`, `buildSnapshotWithDeadline`, `withDeadline`, the cache + single-flight state.
- `server/routes.ts` keeps only `registerRoutes()` and the route handlers themselves.

---

### M3. `EVENT_BASE`/`API_BASE` placeholder string is fragile

**Where:** `client/src/lib/queryClient.ts:3`, `client/src/App.tsx:49`.

```ts
const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
const EVENT_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
```

**Problem:** This pattern relies on a build-time string substitution that never happens — there is no Vite `define`, no `replace` plugin, nothing in `script/build.ts` or `vite.config.ts` that rewrites `"__PORT_5000__"`. The runtime value is always `""`, which happens to be correct for same-origin deployments, but the dead-code conditional is misleading and will silently no-op if someone tries to "fix" it.

**Impact:** Future contributor wastes time hunting for the substitution mechanism; a copy-paste of the pattern into a real cross-origin scenario will silently use `""` and break.

**Fix:** Replace with `import.meta.env.VITE_API_BASE_URL ?? ""`. Document that the SPA defaults to same-origin and you only need to set the var if hosting frontend separately. The `VITE_` prefix is safe here because the value is a public URL, not a secret.

---

### M4. Hash-based routing with only one real page

**Where:** `client/src/App.tsx:902`, `client/src/main.tsx:5-7`.

**Problem:** The router uses `wouter`'s hash adapter and there is exactly one route plus the 404. Hash routing is required because `vite.config.ts` uses `base: "./"` (relative paths) and the static-serve fallback at `server/static.ts:17` always serves `index.html` for any unmatched path — so any path-based route would still work, but the hash adapter is in there as belt-and-braces. This is fine until you add deep links: SEO, link previews, and copy-paste-able routes will all break under hash routing.

**Impact:** Future "share this token" feature will need to switch to history routing, which means changing `base`, the static fallback, and possibly Railway's URL handling.

**Fix:** Note the constraint in `STRUCTURE.md` (already done). When deep links become a P1, switch to `wouter`'s default browser-history adapter and set `base` to `/` in `vite.config.ts`.

---

### M5. SQLite path is hard-coded to `./data.db`

**Where:** `server/storage.ts:7` (`new Database("data.db")`), `drizzle.config.ts:7-9`.

**Problem:** The path is a string literal, resolved relative to the cwd. On Railway this happens to be the project root, which works. If the server is ever started from a different directory, or if the deployment splits build dir vs runtime dir, the database will be created in the wrong place and the radar will look like a fresh deploy with no snapshot history (which silently breaks the stale-fallback path).

**Impact:** Production silently loses the stale-fallback safety net.

**Fix:** Read from env (`process.env.DATA_DB_PATH ?? "./data.db"`). Keep the default but make it overridable. Document in `RUNBOOK.md` and `.env.example`.

---

### M6. `data.db-journal` listed in `.gitignore` but WAL mode produces `-wal`/`-shm` only

**Where:** `.gitignore`, `server/storage.ts:8` (`pragma("journal_mode = WAL")`).

**Problem:** Minor — `data.db-journal` is the rollback-journal mode artifact; in WAL mode you get `data.db-wal` and `data.db-shm` instead. Both are in the `.gitignore` already, so this is documentation drift, not a leak risk.

**Fix:** Remove `data.db-journal` from `.gitignore` (or keep it — it's defensive, costs nothing).

---

### M7. `attached_assets` Vite alias points to a non-existent directory

**Where:** `vite.config.ts:11`.

**Problem:** `"@assets": path.resolve(import.meta.dirname, "attached_assets")` — but `attached_assets/` does not exist. Imports through `@assets/...` will produce a confusing "file not found" rather than a clear "no such alias".

**Fix:** Either create the directory and add a `.gitkeep`, or remove the alias.

---

## Severity: LOW

### L1. `bs58` 6.0.0 import at top of `grpcStream.ts` — value of import is dynamic later

**Where:** `server/grpcStream.ts:9`.

**Problem:** `import bs58 from "bs58"` is loaded eagerly even when `SVS_GRPC_ENDPOINT` is unset and the worker is disabled. Tiny memory cost; not worth fixing on its own.

**Fix:** None. Note for the record.

---

### L2. `console.error` in gRPC parse path is unbounded

**Where:** `server/grpcStream.ts:502` (`console.error("[grpc] update parse error:", error)`), `server/grpcStream.ts:533` (stream error).

**Problem:** A malformed proto from upstream could log per-event indefinitely. `parseErrorCount` is in `diagnostics`, but the raw error is also `console.error`'d, which defeats the "compact logs" pattern set elsewhere.

**Fix:** Rate-limit these logs (e.g. log the first error, then once per minute). Or drop the per-event log entirely and rely on the diagnostics counter.

---

### L3. `.env` file presence is checked implicitly by `dotenv/config`

**Where:** `server/index.ts:1`.

**Problem:** `dotenv/config` silently no-ops when `.env` is absent. In production this is correct (Railway injects via environment); in dev a missing `.env` produces a radar with all SVS features disabled, which is functional but easy to misdiagnose as "broken".

**Fix:** On dev boot, log which optional features are disabled because their env var is missing. The shape already exists in `getSvsConfig()` (`server/svs.ts:47-55`); just log the booleans on startup.

---

### L4. `Pump.fun` watcher has no default program ID

**Where:** `server/grpcStream.ts:111` — `pushIf("pumpfun", "WATCH_PUMPFUN_PROGRAM", undefined, true)`.

**Problem:** The watcher is "enabled" but there's no fallback program ID, so it does nothing unless the operator finds and pastes the program ID. This matches `docs/PRODUCT.md`'s "Partial — wired, watcher disabled by default" note.

**Fix:** Either bake in a known Pump.fun program ID with a comment ("verify before enabling on a sized host"), or log a one-line "pumpfun watcher idle: WATCH_PUMPFUN_PROGRAM not set" on startup so the operator knows the wiring is intentional.

---

### L5. Image `crossOrigin="anonymous"` on every external token image

**Where:** `client/src/App.tsx:247`.

**Problem:** `crossOrigin="anonymous"` makes the browser drop credentials but also requires the upstream to send `Access-Control-Allow-Origin`. If DexScreener / SVS / IPFS gateways do not set CORS headers, the image fails — but the `onError` fallback already handles that, so it's defensive.

**Fix:** Probably none. Worth noting that adding a backend image proxy would let us strip `crossOrigin`, control caching, and avoid hot-linking.

---

### L6. CSV export uses naive escaping

**Where:** `client/src/App.tsx:597-625` (`exportCsv`).

**Problem:** Naive CSV building rarely handles fields containing commas, quotes, or newlines correctly. Token names can contain any of these; a malicious token name with an embedded `=cmd|...` would also be a CSV-injection vector when opened in Excel.

**Fix:** Use a tiny CSV escape helper (`"${value.replace(/"/g, '""')}"`) and prefix any cell starting with `=`/`+`/`-`/`@` with a single quote. ~10 lines.

---

## Things checked and clean

- **No `TODO` / `FIXME` / `HACK` / `XXX` markers** in `server/*.ts`, `client/src/App.tsx`, `script/build.ts`, `shared/schema.ts`. The team uses commit messages and `docs/ROADMAP.md` to track work.
- **No hardcoded secrets** in source. `.env.example` only has placeholders, and the actual `.env` is gitignored.
- **No `eval` / `Function(...)`** in source.
- **No `process.exit(...)` outside the build script and the Vite logger error path** (which terminates intentionally on dev-vite startup failure, `server/vite.ts:25`).
- **No `any` leak from `grpcStream.ts`** — the file isolates wide `any` types and emits `GrpcCandidate` (well-typed) for the rest of the app.
- **No SQL string concatenation** — all DB access goes through Drizzle's typed query builder.
- **No `dangerouslySetInnerHTML`** in the SPA.
- **No unhandled promise rejections obvious from reading** — all `await` sites are inside try/catch or behind result-object helpers, and the gRPC worker promise is intentionally fire-and-forget with internal error catching (`server/index.ts:130-145`).

---

*Concerns audit: 2026-05-04*
