# Testing Patterns

**Analysis Date:** 2026-05-04

## Test Framework

**Runner:**
- Not detected — no test framework configured.
- No `jest.config.*`, `vitest.config.*`, or `playwright.config.*` exists in the repo.
- `package.json` has no `test` script. Only `dev`, `build`, `start`, `check` (`tsc`), and `db:push` are defined.
- Config: `N/A`

**Assertion Library:**
- N/A — none installed. No `vitest`, `jest`, `@testing-library/*`, `chai`, `playwright`, `supertest`, or similar package is listed in `package.json` `dependencies` or `devDependencies`.

**Run Commands:**
```bash
npm run check          # Closest available check — runs `tsc` for type errors (no runtime tests)
# npm test             # Not configured
# npm run test:watch   # Not configured
# npm run coverage     # Not configured
```

**Recommended setup (not yet present):**
- Add `vitest` (already aligned with the existing Vite tooling in `vite.config.ts`).
- Add `@testing-library/react` + `@testing-library/jest-dom` for client component tests.
- Add `supertest` for Express route tests against `server/routes.ts`.
- Wire up `"test": "vitest run"` and `"test:watch": "vitest"` in `package.json`.

## Test File Organization

**Location:**
- No tests found. `find . -name "*.test.*" -o -name "*.spec.*"` (excluding `node_modules`) returns zero results.
- `tsconfig.json` already excludes `**/*.test.ts`, so co-located tests would be ignored by `tsc` but still executable by a test runner — this is the intended layout when tests are added.

**Naming (recommended when tests are added):**
- Co-locate tests beside the file under test using the `*.test.ts` / `*.test.tsx` suffix (matches the existing `tsconfig.json` exclusion).
- Examples: `server/routes.test.ts` next to `server/routes.ts`; `client/src/lib/queryClient.test.ts` next to `client/src/lib/queryClient.ts`.

**Structure (recommended):**
```
server/
  routes.ts
  routes.test.ts            # unit tests for scoring/parsing helpers
  svs.ts
  svs.test.ts
shared/
  schema.ts
  schema.test.ts            # zod schema parse/validation tests
client/src/
  lib/
    queryClient.ts
    queryClient.test.ts
  hooks/
    use-mobile.test.tsx
```

## Test Structure

**Suite Organization:**
```typescript
// No tests in repo. Recommended pattern (vitest), targeting the pure helpers
// already present in server/routes.ts:
import { describe, it, expect } from "vitest";

describe("scorePair", () => {
  it("returns null when tokenAddress is missing", () => {
    // exercise the early-return guard:
    //   if (!tokenAddress || !pairAddress) return null;
  });

  it("clamps virality scores into [0, 100]", () => {
    // assert clamp() invariants from server/routes.ts
  });
});
```

**Patterns (recommended):**
- Setup pattern: prefer `beforeEach` for resetting any module-level state (e.g. `memoryCache`, `lastGoodSnapshot` in `server/routes.ts`, `authRejectedUntil` in `server/svs.ts`). Several singletons exist; tests must reset them between cases.
- Teardown pattern: use `afterEach` to clear timers and abort any in-flight `AbortController`s — every external fetch in this codebase is wrapped with one (see `fetchWithTimeout`).
- Assertion pattern: prefer `expect(x).toEqual(...)` for shape comparisons of zod-derived types; use `expect(x).toBe(null)` when asserting the null-sentinel idiom used by `scorePair` and `compactUrlLabel`.

## Mocking

**Framework:** N/A — none installed. Recommend `vitest`'s built-in `vi.mock` / `vi.fn`.

**Patterns:**
```typescript
// Recommended: stub global fetch for server fetchers.
import { vi } from "vitest";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ pairs: [] }), { status: 200 })
  ));
});

afterEach(() => {
  vi.unstubAllGlobals();
});
```

**What to Mock:**
- External HTTP calls to DexScreener (`https://api.dexscreener.com`, see `DEX` in `server/routes.ts`).
- External HTTP calls to SVS (`fetchSvsMetadata`, `fetchSvsPrices`, `fetchSvsMintInfo` in `server/svs.ts`).
- The Yellowstone gRPC client (`@triton-one/yellowstone-grpc`) when testing `server/grpcStream.ts`.
- `process.env` reads — set values directly in the test file before importing the module under test.
- `Date.now()` / timers — use `vi.useFakeTimers()` for cooldown tests (`AUTH_REJECTED_COOLDOWN_MS`, `CACHE_MS`, `RADAR_BUILD_DEADLINE_MS`).

**What NOT to Mock:**
- Pure helpers (`clamp`, `n`, `safeString`, `logNorm`, `firstSentence`, `classifyMeme`, `compactUrlLabel`, `parseBoolEnv`). Test them directly with real inputs.
- Zod schemas in `shared/schema.ts`. Run them against real fixtures.
- The shadcn UI primitives in `client/src/components/ui/`. They are thin wrappers over Radix; test the consuming component instead.

## Fixtures and Factories

**Test Data:**
```typescript
// Recommended: build small typed fixtures off the zod-inferred types.
import type { TokenSignal, RadarSnapshot } from "@shared/schema";

export function makeTokenSignal(overrides: Partial<TokenSignal> = {}): TokenSignal {
  return {
    id: "test-id",
    chainId: "solana",
    tokenAddress: "So11111111111111111111111111111111111111112",
    pairAddress: "pair-1",
    dexId: "raydium",
    url: "https://example.com",
    name: "Test",
    symbol: "TEST",
    // ... fill remaining required fields from tokenSignalSchema
    ...overrides,
  };
}
```

**Location (recommended):**
- Place factories in `shared/__fixtures__/` (importable from both client and server tests via `@shared/__fixtures__/...`).
- Place server-only fixtures (raw DexScreener / SVS responses) under `server/__fixtures__/`.
- Keep fixtures small and inline whenever a single test needs them; only extract when reused across files.

## Coverage

**Requirements:** None enforced. No coverage tool configured; `package.json` has no coverage script.

**View Coverage:**
```bash
# Not configured. Recommended once vitest is added:
# npm run test -- --coverage
```

## Test Types

**Unit Tests:**
- Scope: pure helpers in `server/routes.ts` (`clamp`, `n`, `safeString`, `firstSentence`, `classifyMeme`, `compactUrlLabel`, `logNorm`, `getTxns`, `getVolume`, `getChange`, `scorePair`), `server/svs.ts` (`recordsByMint`, `chunk`, `getSvsAuthCooldown`), `server/grpcStream.ts` (`parseBoolEnv`, `loadWatchPrograms`, `CandidateStore`).
- Approach: import directly, feed inputs, assert outputs. No mocks needed for these.

**Integration Tests:**
- Scope: Express routes registered in `server/routes.ts` via `registerRoutes(httpServer, app)`, the storage layer (`server/storage.ts`) against an in-memory SQLite, and the radar pipeline end-to-end with mocked DexScreener + SVS responses.
- Approach: spin up the Express app in-process and drive it with `supertest`. Use a temp SQLite path (override the hard-coded `new Database("data.db")` in `server/storage.ts` — likely needs a small refactor to accept a path).

**E2E Tests:**
- Not used. No Playwright / Cypress configuration. If added, target the radar UI in `client/src/App.tsx` against a server with SVS and gRPC disabled (no `SVS_API_KEY`, no `SVS_GRPC_ENDPOINT`) so the test runs deterministically.

## Common Patterns

**Async Testing:**
```typescript
// Recommended: exercise the discriminated-union return shape used throughout
// server/routes.ts and server/svs.ts.
import { describe, it, expect, vi } from "vitest";

it("fetchJson returns ok:false on non-2xx", async () => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response("nope", { status: 503, statusText: "Unavailable" })
  ));

  // const result = await fetchJson<unknown>("/latest/dex/search/?q=meme", "search");
  // expect(result.ok).toBe(false);
  // if (!result.ok) expect(result.error).toContain("503");
});
```

**Error Testing:**
```typescript
// Recommended: assert on the error branch of the {ok, error} union, not on
// thrown exceptions. The codebase intentionally avoids throwing across IO.
it("returns ok:false with error string when fetch rejects", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
  // const result = await fetchJson<unknown>("/x", "x");
  // expect(result.ok).toBe(false);
  // if (!result.ok) expect(result.error).toBe("ECONNRESET");
});

// For routes that propagate to the central error middleware in server/index.ts,
// assert on the response status + JSON body via supertest:
//   await request(app).get("/api/radar").expect(500);
```

---

*Testing analysis: 2026-05-04*
