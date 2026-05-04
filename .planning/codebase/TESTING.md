# Testing

**Analysis Date:** 2026-05-04

## Framework

**Not detected.** No test runner is installed.

Searched for and did not find:
- `jest` / `@jest/*` / `babel-jest` — not in `package.json`.
- `vitest` / `@vitest/*` — not in `package.json` (despite Vite being the build tool).
- `mocha`, `chai`, `ava`, `tap` — not present.
- `playwright`, `@playwright/test`, `cypress`, `puppeteer` — not present.
- `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event` — not present.
- `supertest` — not present (no integration tests against Express).
- `msw` (Mock Service Worker) — not present.

The only hint of intent is in `tsconfig.json:4`:

```json
"exclude": ["node_modules", "build", "dist", "**/*.test.ts"]
```

This excludes `*.test.ts` files from compilation, but no such files exist in the repo. There is no `tests/` or `__tests__/` directory.

## Structure

**No test files in the repository.** Confirmed via:

- `find . -name "*.test.*" -o -name "*.spec.*" -not -path '*/node_modules/*'` → no results.
- No `jest.config.*`, `vitest.config.*`, `playwright.config.*`, `cypress.config.*`.

If/when tests are introduced, the conventions to follow (based on the existing codebase shape):

| Test type | Recommended location | Rationale |
|-----------|----------------------|-----------|
| Pure unit (helpers in `server/routes.ts`, `server/svs.ts`) | Co-locate as `server/<file>.test.ts`. The `tsconfig.json` exclude already accommodates this. | Functions like `clamp`, `n`, `safeString`, `firstSentence`, `classifyMeme`, `logNorm`, `withDeadline`, `recordsByMint`, `chunk` are pure and trivially testable. |
| HTTP route integration | New `tests/integration/` with `supertest` against the real Express app from `registerRoutes()`. | Reuses the actual deadline / fallback / error paths. |
| gRPC parser unit | `server/grpcStream.test.ts` driving the message parser with captured proto fixtures. | The `any`-isolation boundary makes a fixture-driven test the natural fit. |
| Client component | `client/src/components/<name>.test.tsx` with Vitest + `@testing-library/react`. | Vitest is the natural pick because the project already uses Vite. |
| End-to-end | New `e2e/` with Playwright running against `npm run dev`. | The SPA is small (one screen) — a few smoke specs would cover the critical paths. |

## Mocking

**No mocking infrastructure detected.** When tests are added, the testable seams already exist:

- **External HTTP** — `fetchJson()` and `fetchWithTimeout()` (`server/routes.ts:139`, `server/svs.ts:63`) are the boundary functions; replace with stubs in tests, or use `msw` to intercept at the `fetch` layer (works in Node 20+).
- **SVS auth-cooldown** — `noteAuthRejected()` and `getSvsAuthCooldown()` (`server/svs.ts:18-35`) are observable; the cooldown timestamp is module-level, so tests need module-reset (`vi.resetModules()`) or a `__resetCooldown()` helper.
- **gRPC worker** — `getGrpcStatus()` and `getRecentGrpcCandidates()` (`server/grpcStream.ts`) are read-only; the worker itself can be left disabled in tests by leaving `SVS_GRPC_ENDPOINT` unset (`startGrpcWorker()` then returns `{ started: false, reason: ... }`).
- **Storage** — `IStorage` (`server/storage.ts:19-22`) is the contract; an in-memory `IStorage` impl can be swapped in. Tests should not touch the production `data.db`.
- **Time** — Several modules read `Date.now()` directly (`server/svs.ts:19`, `server/grpcStream.ts`, `server/routes.ts`). Use `vi.useFakeTimers()` or inject a clock.

## Coverage

**No coverage data.** No `coverage/`, no `.nyc_output/`, no `vitest.config.ts` with `coverage` block, no badge in README. Add `@vitest/coverage-v8` if you wire Vitest in; or `c8` if you wire `node --test`.

## CI Integration

**No CI test integration.** No `.github/workflows/`, no `.gitlab-ci.yml`, no Makefile target. Tests would currently only run locally.

When CI is added: the minimum gate that fits this codebase is `npm run check` (which is `tsc --noEmit`). It runs in seconds and would catch every type-level regression. A test job is a follow-up.

## Manual verification (current state)

In place of an automated suite, the project relies on:

1. **Type check** — `npm run check` → `tsc --noEmit`. The only currently-enforced gate.
2. **Health endpoints** — `GET /api/svs/health`, `GET /api/grpc/status`, `GET /api/radar` are designed as the operator's verification surface (see `docs/RUNBOOK.md`'s troubleshooting matrix).
3. **gRPC diagnostics counters** — `/api/grpc/status.diagnostics` (`server/grpcStream.ts:19-29`) intentionally exposes `eventsWithTokenBalances`, `eventsByProgram`, `ignoredReasonCounts`, `parseErrorCount`, etc., specifically so the operator can verify the stream is working without a debugger.
4. **`data-testid` discipline on the SPA** (`client/src/App.tsx`) — every interactive element has a testid (`button-token-...`, `text-final-score-...`, `badge-opportunity-...`). Adding Playwright/Testing-Library would land on a UI that's already E2E-ready.
5. **Acceptance criteria in `docs/ROADMAP.md`** — the P0 milestone defines five concrete checks (e.g. "/api/grpc/status.status === connected within 60s of deploy", "container memory flat over 24h"); these are the de-facto integration tests today.

## Recommendation (informational, not normative)

If a single test investment had to be made, **`vitest` + a thin set of unit tests for the scoring helpers in `server/routes.ts` plus a `supertest` smoke for `/api/radar`**. Rationale:

1. The scoring functions are the only place where business-logic regressions would silently corrupt the product surface — and they are pure, so they cost little to cover.
2. `/api/radar` exercises the deadline guard, the stale-fallback path, and the `RadarSnapshot` schema validation in one HTTP call.
3. Vitest reuses Vite config and TS path aliases (`@/`, `@shared/`) without extra setup.

Document any decision in this file and update `package.json` scripts (`"test": "vitest run"`, `"test:watch": "vitest"`).

---

*Testing analysis: 2026-05-04*
