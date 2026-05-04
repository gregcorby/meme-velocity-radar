# Testing

This document describes the *current* testing posture (essentially: none) and the seams that would make adding tests easy. It is descriptive of today's state and prescriptive only in the final "Recommendation" section.

---

## Framework

**Searched for:**

- `find . -name "*.test.*" -not -path '*/node_modules/*'` — **0 matches.**
- `find . -name "*.spec.*" -not -path '*/node_modules/*'` — **0 matches.**
- `package.json` deps for `jest`, `vitest`, `playwright`, `cypress`, `@testing-library/*` — **none present** (verified against `package.json:13-105`).

**Result: there is no test framework installed and no test files exist.**

Indirect evidence the absence is intentional rather than accidental: `tsconfig.json:3` excludes `**/*.test.ts` from compilation. That exclude is a placeholder for a future framework — when tests are added, `tsc` will not try to compile them as production code.

The only enforced quality gate today is `npm run check`, which is a plain `tsc` run (`package.json:10`). It does not execute code; it only verifies types compile under `"strict": true` (`tsconfig.json:9`).

---

## Structure

There are no tests to organize. If tests are introduced, follow the convention table below — it mirrors the repo's existing top-level layout (`server/`, `shared/`, `client/src/`) so the `**/*.test.ts` pattern in `tsconfig.json:3` already covers them.

| Test type | Recommended location | Rationale |
| --- | --- | --- |
| Server unit (pure helpers) | `server/__tests__/*.test.ts` colocated next to the file under test (e.g. `server/routes.test.ts`) | Keeps the helper and its test in the same import-distance; matches the `tsconfig` exclude pattern. |
| Server integration (HTTP) | `server/__tests__/api.test.ts` | Boots `registerRoutes` against an in-process Express + supertest. One file per route group (`api.radar`, `api.svs.health`, `api.grpc.status`). |
| Shared (Zod schemas) | `shared/schema.test.ts` | Schema is the wire contract — tests should live next to it so a schema change forces a test edit in the same diff. |
| Client unit (hooks / utils) | `client/src/lib/*.test.ts`, `client/src/hooks/*.test.ts` | Matches existing folder layout; jsdom env required. |
| Client component | `client/src/__tests__/App.test.tsx` | Use `data-testid` selectors that already exist (see "Manual verification" below). |
| End-to-end | `e2e/*.spec.ts` (top-level) | Out-of-tree from `tsconfig` `include` (`tsconfig.json:2`); needs its own `tsconfig` and runner. |

---

## Mocking

There is no mocking library in place. The codebase has, however, been written with several testable seams that can be exercised without monkey-patching globals:

| Seam | Location | How to use |
| --- | --- | --- |
| `fetchJson` | `server/routes.ts:139` | The single outbound HTTP helper for DexScreener. Stub by replacing the global `fetch` (Node 20 has it built in) with a test fake; `fetchJson` returns a result object so tests assert on `{ ok, data }` / `{ ok, error }` without try/catch. |
| `fetchWithTimeout` | `server/svs.ts:63-71` | Same pattern as above for the SVS endpoints. Wraps `fetch` with `AbortController`; injectable by overriding `globalThis.fetch`. |
| Auth-cooldown state | `server/svs.ts:15-35` | `authRejectedUntil` and `lastAuthRejectStatus` are module-private but observable via `getSvsAuthCooldown()`. Tests can drive the cooldown by calling code paths that hit a 401/403 and then assert the public getter. |
| `IStorage` interface | `server/storage.ts:19-22` | The `DatabaseStorage` class implements a 2-method interface. Swap it for an in-memory test double in any route-level test by re-binding the `storage` export — or refactor the export to accept a `storage` arg if you want zero-mutation tests. |
| Time | `Date.now()` is used directly throughout (`server/routes.ts:296, 538, 764`, `server/svs.ts:19, 24`, `server/grpcStream.ts:440, 569-571`) | No central clock abstraction. Use a fake-timers utility (`vi.useFakeTimers()` or jest equivalent) rather than refactoring; the call sites are dense enough that an indirection wouldn't pay back. |
| gRPC worker module state | `server/grpcStream.ts:543-605` | `startGrpcWorker` / `stopGrpcWorker` / `getGrpcStatus` are the public surface. Tests should drive them through these exports rather than reading the module-private `started`, `status`, `lastError` directly. |

---

## Coverage

None. No coverage tooling is installed or configured. There is no coverage threshold in CI because there is no CI test step (see below).

---

## CI Integration

None. There is no `.github/workflows/`, no `circleci`, no `gitlab-ci`. The only enforced gate is whatever runs against `npm run check` — i.e. plain TypeScript compilation. If that breaks, types are wrong; nothing else is verified automatically.

`npm run build` (`package.json:8` -> `tsx script/build.ts`) runs at deploy time on Railway and would fail loudly on a TS error, but it is not a substitute for tests — it never executes route handlers.

---

## Manual verification (current state)

Until automated tests exist, the project relies on these manual checks:

1. **Type check.** `npm run check` (`package.json:10`). Must be clean before merge. This is the only gate that catches schema-vs-handler drift today, because `shared/schema.ts` types flow through both backend and frontend.
2. **Health endpoints.** Both must return within their declared deadlines:
   - `GET /api/svs/health` (`server/routes.ts:856-880`) — wraps `getSvsHealthReport()` in `withDeadline(_, HEALTH_DEADLINE_MS=6_000ms, fallback)` (`server/routes.ts:82, 878`). Must always respond inside ~6s, even if upstream SVS is down.
   - `GET /api/grpc/status` (`server/routes.ts:882-891`) — synchronous, must be instant. Never awaits the stream.
   - `GET /api/radar` (`server/routes.ts:893-911`) — bounded by `RADAR_BUILD_DEADLINE_MS=12_000ms` (`server/routes.ts:81, 806`); must return either a fresh snapshot, the cached one, or a degraded `sourceHealth: [{ name: "deadline", status: "degraded", ... }]` object.
   - `GET /api/radar/stream` (`server/routes.ts:913-939`) — SSE; verify `event: radar` ticks every `REFRESH_SECONDS=20` and that errors arrive as `event: error` rather than closing the connection.
3. **gRPC diagnostics counters.** Hit `/api/grpc/status` and inspect `diagnostics.eventsByProgram`, `diagnostics.eventsByFilter`, `diagnostics.parseErrorCount`, `diagnostics.lastCandidateAgeSec` (`server/grpcStream.ts:585-595`). Numbers should advance for any program enabled in the watch list (`:94-134`), and `parseErrorCount` should stay near zero on a healthy stream.
4. **`data-testid` discipline.** Spot-check that every new interactive element has a `data-testid` matching the convention in `CONVENTIONS.md > Naming`. Existing examples: `badge-svs-status`, `badge-grpc-status`, `badge-live-status`, `input-search`, `button-export-csv`, `button-toggle-theme`, `button-token-${id}`, `tab-sort-score` (`client/src/App.tsx:182, 214, 761, 782, 785, 721, 270, 798`). When tests are added, these IDs become the primary selectors — adding them now is a free investment.
5. **`docs/ROADMAP.md` acceptance criteria.** The P0 milestone "Reliable launchpad-only gRPC ingestion" defines five concrete checks (`docs/ROADMAP.md:18-29`): connected within 60s, candidates within 5min, flat memory over 24h, `eventsPerMinute` in low thousands, `tokens.length > 0` on >99% of `/api/radar` requests, and clean logs. These are the de-facto release-acceptance tests today.

---

## Recommendation

*Informational only — no decision has been made to add tests.* If they are introduced, the minimum-viable footprint is **vitest + supertest**:

- **vitest.** Reasons: native ESM (matches `package.json:5` `"type": "module"`), TypeScript out of the box (no Babel config), built-in `vi.useFakeTimers()` for the `Date.now()`-based deadline logic in `server/routes.ts` and `server/svs.ts`, jsdom environment for testing the React tree in `client/src/App.tsx`. Vite is already a dep (`package.json:101`), so vitest reuses the existing config.
- **supertest.** Reasons: `registerRoutes(httpServer, app)` (`server/routes.ts:855`) accepts an Express app, which supertest can boot in-process without binding a port. This makes the four `/api/*` routes straightforward to integration-test against the real `IStorage` (or a swapped-in fake).
- **What to test first** — the failure modes that today only surface in production logs:
  1. `withDeadline` returns the fallback when the inner promise hangs (`server/routes.ts:87-114`).
  2. `fetchJson` returns `{ ok: false, error: "hard deadline ..." }` when the AbortController fires late (`server/routes.ts:148-155`).
  3. The auth cooldown engages on a synthetic 401 from SVS and short-circuits subsequent calls (`server/svs.ts:18-26`).
  4. `/api/radar` serves the last-good snapshot when `buildSnapshot` rejects (`server/routes.ts:898-908`).
  5. `radarSnapshotSchema.safeParse(snapshot)` accepts the actual server output (`shared/schema.ts:101-117`) — guards against silent contract drift.

A test budget of ~30 minutes per round-trip on those five would catch the regressions the codebase is presently architected to prevent.

---

*Testing analysis: 2026-05-04*
