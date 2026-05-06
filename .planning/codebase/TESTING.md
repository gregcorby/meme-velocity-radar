# Testing Patterns

**Analysis Date:** 2026-05-05

## Test Framework

**Runner:**
- No test framework is installed or configured. `package.json` contains no `jest`, `vitest`, `mocha`, `playwright`, `cypress`, or any other testing dependency.
- `tsconfig.json` excludes `**/*.test.ts` from compilation (`"exclude": ["node_modules", "build", "dist", "**/*.test.ts"]`), which implies test files were anticipated but none exist.
- No `jest.config.*`, `vitest.config.*`, or `playwright.config.*` file present in the repo.

**Assertion Library:**
- None installed.

**Run Commands:**
```bash
# No test commands are defined in package.json scripts.
# Current scripts:
npm run dev       # Start dev server (tsx server/index.ts)
npm run build     # Build for production
npm run start     # Run production build
npm run check     # Type-check with tsc (not test)
npm run db:push   # Apply DB schema
```

**Type checking as the closest quality gate:**
```bash
npm run check     # Runs: tsc (strict mode, noEmit)
```

## Test File Organization

**Location:**
- No test files exist anywhere in the repository (`find` across all directories returns no `*.test.*` or `*.spec.*` files).

**Naming:**
- Not applicable — no tests written.

**Structure:**
- Not applicable.

## Test Structure

**No tests exist.** The codebase has no unit, integration, or end-to-end tests as of the analysis date.

**`data-testid` attributes ARE present throughout the client**, indicating intent to support DOM-based testing. All interactive elements and key data display nodes are annotated:

```tsx
// Examples from client/src/App.tsx — testids are systematically applied
<Logo data-testid="brand-logo" />
<Badge data-testid="badge-svs-status" />
<Badge data-testid="badge-grpc-status" />
<input data-testid="input-search" />
<button data-testid="button-toggle-live" />
<button data-testid="button-refresh" />
<button data-testid="button-export-csv" />
<button data-testid={`button-token-${token.id}`} />
<button data-testid={`button-filter-${key}`} />
<div data-testid={`detail-panel-${token.id}`} />
<div data-testid="empty-detail-panel" />
<div data-testid="token-list" />
<div data-testid="snapshot-bar" />
<div data-testid={`score-${label.toLowerCase()}`} />
<div data-testid={`avatar-fallback-${token.id}`} />
<img data-testid={`img-token-${token.id}`} />
<div data-testid={`metric-${label}`} />
<div data-testid="text-meme-decode" />
<div data-testid="text-danger-note" />
```

The `data-testid` pattern uses `noun-element[-id]` format, making it easy to write Playwright or Cypress selectors like `page.getByTestId("button-refresh")`.

## Mocking

**Framework:** None.

**No mocking infrastructure exists.** The gRPC stream and SVS API modules are designed with explicit interfaces and result types that would support mocking:

```typescript
// server/storage.ts — interface designed for injection
export interface IStorage {
  saveRadarSnapshot(snapshot: InsertRadarSnapshot): Promise<RadarSnapshotRecord>;
  getLatestRadarSnapshot(): Promise<RadarSnapshotRecord | undefined>;
}

// server/svs.ts — functions return discriminated unions, mockable
async function postBatch<T>(): Promise<{ ok: true; map: Map<string, T> } | { ok: false; error: string }>

// server/routes.ts — fetchJson returns ok/error union
async function fetchJson<T>(): Promise<{ ok: true; data: T } | { ok: false; error: string; label: string }>
```

## Fixtures and Factories

**Test Data:**
- No fixtures, factories, or seed data files exist.

**Location:**
- No `__fixtures__`, `__mocks__`, `fixtures/`, or `test/` directories exist.

## Coverage

**Requirements:** None enforced — no coverage tooling configured.

**View Coverage:**
```bash
# Not available — no test runner installed
```

## Test Types

**Unit Tests:**
- None. Pure functions in `server/routes.ts` (e.g., `clamp`, `n`, `safeString`, `logNorm`, `classifyMeme`, `firstSentence`, `scorePair`) are high-value candidates — they are deterministic, stateless, and handle edge cases (NaN, null, empty strings) that would benefit from table-driven tests.

**Integration Tests:**
- None. The `/api/radar`, `/api/grpc/status`, and `/api/svs/health` endpoints are high-value integration test targets since they orchestrate multiple external sources with fallback logic.

**E2E Tests:**
- None. The dense `data-testid` coverage in `client/src/App.tsx` suggests Playwright was intended but not yet implemented.

## What Should Be Tested (High Priority)

**Server pure functions (unit):**
- `clamp(value, min, max)` — `server/routes.ts`
- `n(value, fallback)` — `server/routes.ts`
- `safeString(value, fallback)` — `server/routes.ts`
- `classifyMeme(name, symbol, description)` — `server/routes.ts`
- `firstSentence(text)` — `server/routes.ts`
- `scorePair(pair, profile, svs)` — `server/routes.ts` (scoring logic, null returns)
- `compactUrlLabel(url)` — `server/routes.ts`
- `buildLinks(profile, pair)` — `server/routes.ts`
- `combineStatus(parts)` — `server/svs.ts`
- `parseBoolEnv(value, fallback)` — `server/grpcStream.ts`

**Server integration (with mocked fetch):**
- `fetchJson` with timeout, abort, and HTTP error responses
- `buildSnapshot` fallback behavior when all sources fail
- `withDeadline` timeout resolution
- `postBatch` auth rejection cooldown in `server/svs.ts`

**Client unit (with React Testing Library):**
- `fmtMoney(value)` — formatting edge cases ($0, $1B, null)
- `fmtPct(value)` — sign prefix, rounding
- `fmtAge(minutes)` — minutes/hours/days conversion
- `scoreTone(score)` / `riskTone(score)` — CSS class selection thresholds
- `normalizeChart(token)` — array shape for recharts

**E2E (Playwright against running server):**
- Initial radar load: snapshot bar shows scanned token count
- Token selection: clicking a card opens detail panel
- Search: filtering by ticker symbol narrows the list
- Sort tabs: switching sort mode reorders tokens
- Filter sidebar: "Velocity" filter removes low-velocity tokens
- Export CSV: download triggered, file has correct headers
- Live stream toggle: SSE connection opened/closed via `EventSource`
- Theme toggle: dark/light class added to `document.documentElement`

## Recommended Setup

To add testing to this project:

```bash
# Vitest (matches existing Vite/ESM setup)
npm install -D vitest @vitest/ui @testing-library/react @testing-library/dom @testing-library/jest-dom jsdom

# Add to package.json scripts:
"test": "vitest",
"test:ui": "vitest --ui",
"test:coverage": "vitest --coverage"

# Playwright for E2E
npm install -D @playwright/test
npx playwright install
```

Config entry point would be `vitest.config.ts` at repo root, extending `vite.config.ts` with `environment: "jsdom"` for client tests and `environment: "node"` for server tests.

---

*Testing analysis: 2026-05-05*
