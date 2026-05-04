# Coding Conventions

**Analysis Date:** 2026-05-04

## Code Style

**Language:** TypeScript everywhere (`strict: true`). No JS in source — only `postcss.config.js`.

**Module system:** Source is ESM (`"type": "module"` in `package.json`). Imports use:
- Path aliases first: `@/components/ui/...`, `@shared/schema`.
- Then bare deps: `import express from "express"`.
- Then `node:` builtins explicitly: `import { createServer } from "node:http"`, `import path from "node:path"`, `import fs from "node:fs"`.

Never use CJS `require()` in source. The CJS form only exists in the production bundle output (`dist/index.cjs`) emitted by `script/build.ts`.

**Formatting:** No `.prettierrc`, no Biome. Style is enforced informally:
- Two-space indent.
- Double quotes for strings.
- Semicolons present.
- Trailing commas in multi-line literals.
- 1-line function signatures unless they wrap; arrow functions for callbacks; named `function` for top-level declarations.

If you add a formatter, match the existing style — do **not** rewrap the whole repo.

**Linting:** No ESLint config. Type safety relies on `tsc --noEmit` (`npm run check`) and `strict: true`.

## Naming

| Kind | Convention | Example | Where |
|------|------------|---------|-------|
| Server source files | `camelCase.ts` | `grpcStream.ts`, `routes.ts` | `server/` |
| React component file | `PascalCase.tsx` | `App.tsx`, `not-found.tsx` (NB: shadcn primitives use `kebab-case`) | `client/src/` |
| shadcn primitive file | `kebab-case.tsx` | `dropdown-menu.tsx`, `alert-dialog.tsx` | `client/src/components/ui/` |
| Hook file | `use-<name>.ts(x)` | `use-toast.ts`, `use-mobile.tsx` | `client/src/hooks/` |
| Config file | `<tool>.config.ts` | `vite.config.ts`, `tailwind.config.ts` | repo root |
| TypeScript type / interface | `PascalCase` | `RadarSnapshot`, `IStorage`, `SvsConfig` | `shared/schema.ts:119-122`, `server/storage.ts:19` |
| Zod schema variable | `camelCase` ending `Schema` | `tokenSignalSchema`, `radarSnapshotSchema` | `shared/schema.ts:33` |
| Function / method / local | `camelCase` | `buildSnapshot`, `withDeadline`, `fetchJson` | `server/routes.ts` |
| React component | `PascalCase` | `TokenCard`, `SvsBadge`, `RadarHome` | `client/src/App.tsx:158, 254, 628` |
| Module-scope constant | `SCREAMING_SNAKE_CASE` | `CACHE_MS`, `RADAR_BUILD_DEADLINE_MS`, `WATCH_PROGRAMS`, `STABLE_BLOCKLIST` | `server/routes.ts:75-83`, `server/grpcStream.ts:60-76` |
| Env var | `SCREAMING_SNAKE_CASE` | `SVS_API_KEY`, `WATCH_PUMPSWAP_PROGRAM`, `ENABLE_RAYDIUM_AMM_V4` | `.env.example` |
| Local "magic number" assigned to a const | Underscore-grouped digits | `45 * 60_000`, `75_000`, `RADAR_BUILD_DEADLINE_MS = 12_000` | `server/routes.ts:81`, `server/grpcStream.ts:75` |
| API route path | `kebab-case` under `/api/...` | `/api/svs/health`, `/api/grpc/status`, `/api/radar/stream` | `server/routes.ts:856-913` |
| `data-testid` attribute | `kebab-case`, includes id | `data-testid={`button-token-${token.id}`}` | `client/src/App.tsx:270` |

## Patterns

### Result objects instead of throwing for I/O

Outbound HTTP and SVS calls return discriminated unions rather than throw:

```ts
// server/routes.ts:139
async function fetchJson<T>(...): Promise<{ ok: true; data: T } | { ok: false; error: string; label: string }>
```

Pattern: prefer `ok: true | false` result objects for any I/O that the snapshot builder consumes. The builder never has to wrap calls in try/catch — it just branches on `.ok`. Only Express middleware sits behind the global error handler; everything inside the orchestration loop is total.

### Deadline-bound async with `withDeadline`

Every external dependency that can stall is wrapped in `withDeadline()`:

```ts
// server/routes.ts:87
function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T>
```

Used for `getSvsHealthReport()` (6 s, `server/routes.ts:878`) and the radar build (12 s, `server/routes.ts`). On timeout, the helper produces a fallback value instead of rejecting. **Pattern: never let a request handler `await` an unbounded external call.**

### Hard-deadline + AbortController belt-and-braces

`fetchJson` uses an `AbortController` with a `setTimeout`-driven `controller.abort()` AND races the fetch against a separate "hard deadline" promise that resolves an error result two seconds past the abort:

```ts
// server/routes.ts:148-156
const hardDeadline = new Promise<{ ok: false; ... }>((resolve) => {
  setTimeout(() => resolve({ ok: false, error: `hard deadline ${timeoutMs + 2_000}ms`, label }), timeoutMs + 2_000);
});
```

The reason is event-loop starvation — the `AbortController.setTimeout` can be delayed past its deadline if the loop is busy. **Pattern: when a deadline must hold, race the abort against a second `Promise<reject-shape>` so the call can never wedge.**

### `n()` / `safeString()` defensive parsing

External JSON shapes are wide and may have `string`, `number`, `null`, or `undefined` for the same field:

```ts
// server/routes.ts:121
function n(value: unknown, fallback = 0) { ... }
function safeString(value: unknown, fallback = "") { ... }
```

**Pattern: never trust an external numeric or string field. Coerce through `n()` or `safeString()` at the boundary.**

### Bounded fan-out with `mapPool`

Concurrency is capped by `mapPool(items, limit, mapper)` rather than naked `Promise.all`:

```ts
// server/routes.ts:180
async function mapPool<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]>
```

**Pattern: never `await Promise.all` over an array of N upstream fetches without a concurrency cap.**

### Single-flight builds

`inflightSnapshot` (`server/routes.ts:85`) deduplicates concurrent radar builds — when the cache is cold, only one build runs at a time and all callers await the same promise. **Pattern: when a derived value is expensive and idempotent, single-flight it.**

### Zod schema as the wire contract

`shared/schema.ts` defines `radarSnapshotSchema` etc. once. Both server and client import from it via `@shared/schema`. **Pattern: never re-declare a wire-format type on the client. Extend the Zod schema and let TypeScript propagate.**

### `as const` discriminators on unions

Status enums are declared with `as const`:

```ts
// server/grpcStream.ts:11
type GrpcStatusKind = "disabled" | "configured" | "connecting" | ...;
```

Or via Zod enum:

```ts
// shared/schema.ts:89
status: z.enum(["disabled", "configured", "connecting", "connected", "reconnecting", "error"])
```

**Pattern: prefer Zod `enum` over TS-only `type X = "a" | "b"` when the value crosses the wire — you get runtime validation for free.**

### shadcn `cn()` composition

Every component composes Tailwind classes through `cn()`:

```ts
// client/src/lib/utils.ts:5
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
```

Followed throughout `client/src/App.tsx` and `client/src/components/ui/*`. **Pattern: never concatenate Tailwind classes by string interpolation when conditional classes are involved — use `cn()`.**

### Hash-based routing on the client

`wouter`'s hash-location adapter is used so the SPA works under `base: "./"` (any subpath) without server-side rewrites:

```ts
// client/src/main.tsx:5-7
if (!window.location.hash) {
  window.location.hash = "#/";
}
// client/src/App.tsx:902-909 — Router uses useHashLocation
```

**Pattern: when adding a route, register it inside `AppRouter()` and link with `wouter`'s `<Link href="...">`, not `<a>`.**

### Backend secrets via `process.env.X?.trim()`, exposed as booleans

The backend never returns a secret value. Health endpoints return only presence (`hasApiKey: boolean`) and connection status:

```ts
// server/svs.ts:47-55
export function getSvsConfig(): SvsConfig {
  return {
    apiBaseUrl: process.env.SVS_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL,
    hasApiKey: Boolean(process.env.SVS_API_KEY?.trim()),
    ...
  };
}
```

**Pattern: a health endpoint returns booleans, statuses, counts. Never the raw secret. The frontend only needs to know "is this configured?" — never the value.**

### No `VITE_`-prefixed secrets, ever

The convention is enforced by absence: `.env.example` contains no `VITE_*` variables, and the SPA only ever calls `/api/...` endpoints. **Pattern: if you ever feel tempted to prefix a secret with `VITE_`, stop. Add a backend endpoint instead.**

### Compact, structured logging

Per-request logs go through `log()` (`server/index.ts:28`) and append a one-line summary instead of the raw JSON body:

```ts
// server/index.ts:81-84
let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
const summary = summarizeResponseBody(path, capturedJsonResponse);
if (summary) logLine += ` :: ${summary}`;
```

The gRPC worker exposes counters via `/api/grpc/status.diagnostics` rather than logging per event. **Pattern: high-volume code paths surface diagnostics via counters, not per-event logs. Logs are for events humans should read.**

### Defensive `any`, isolated to one module

`server/grpcStream.ts` uses `any` at the proto-decoding boundary because Yellowstone proto types are wide and many fields are optional. The header comment makes this explicit:

> Defensive parsing: yellowstone proto types are wide and many fields are optional. We isolate `any` access to this file …

**Pattern: when interfacing with a wide external schema, isolate the `any` access to one module and emit a small, well-typed object for the rest of the app. Never let `any` leak into shared code.**

### Use `data-testid` on every interactive element

Even without a test framework installed, the SPA already tags every meaningful element:

```tsx
// client/src/App.tsx:270, 282, 288, 293
<button ... data-testid={`button-token-${token.id}`}>
<span ... data-testid={`text-final-score-${token.id}`}>
<Badge ... data-testid={`badge-opportunity-${token.id}-${flag}`}>
```

**Pattern: keep the `data-testid` discipline when adding components, even though there is no test framework yet — it makes the UI ready the moment one is added.**

## Error Handling

**Server (Express):**
- All synchronous handler errors propagate to the global error middleware (`server/index.ts:94-105`), which logs and returns `{ message }` with the appropriate status.
- `res.headersSent` is checked before sending a response — important for streaming routes.
- Async handlers that can fail wrap the failure path explicitly and emit a fallback shape (e.g. `/api/radar` returns the latest cached snapshot on error, `server/routes.ts:898-910`).

**Outbound calls:**
- Never throw across the snapshot builder — return `{ ok: false, error }` instead.
- Always wrap in `AbortController + Promise.race(hardDeadline)`.
- SVS auth failures (401/403) trip a 5-minute cooldown so we don't hammer with bad keys (`server/svs.ts:14-35`).

**Streaming (SSE):**
- The handler emits `event: error` data frames on failure rather than terminating the stream (`server/routes.ts:927-930`). The client stays subscribed.

**Client:**
- TanStack Query is configured with `retry: false` and `refetchOnWindowFocus: false` (`client/src/lib/queryClient.ts:43-55`); failures surface as query errors that the UI displays as toasts or status badges. There is no global error boundary — failures should be caught at the query layer.
- `apiRequest()` throws on non-2xx so callers can `.catch()` the rejection (`client/src/lib/queryClient.ts:5-25`).
- Image load failures use a local `useState` flag plus `onError={() => setFailed(true)}` to fall back to initials (`client/src/App.tsx:233-251`). **Pattern: always provide a graphical fallback for `<img>` from external URLs.**

## Comments

Code comments are sparse and explain WHY, not WHAT. Examples:

- `server/index.ts:39-41` — explains why `summarizeResponseBody` exists (Railway log-pipeline budget).
- `server/index.ts:107-109` — explains why dev-Vite is set up after the other routes (catch-all interaction).
- `server/index.ts:117-120` — explains the PORT firewall expectation.
- `server/grpcStream.ts:1-7` — file header explains why `any` access is isolated to this file.
- `server/routes.ts:78-82` — explains the deadline constant (radar build can take >2min in the worst case).
- `server/routes.ts:148-150` — explains the hard-deadline race (event-loop starvation).
- `server/svs.ts:1-3` — header explains the file is server-only and why it must not be imported by client code.

**Pattern: a comment should answer "why is this here?" not "what does this line do?". The variable name + types should answer "what".**

## Imports / Module Boundaries

- `server/*` may import `@shared/*` and other `server/*`. Never imports `client/*` or `@/*`.
- `client/src/*` may import `@/*`, `@shared/*`, third-party. Never imports `server/*`. (The header comments in `server/svs.ts:1-3` and `server/grpcStream.ts:1-3` make this explicit because those modules read secrets.)
- `shared/*` may only import third-party (`drizzle-orm`, `drizzle-zod`, `zod`). Must remain runtime-safe in both Node and the browser.
- `script/*` may import third-party + node builtins. Should stay self-contained; not imported by anything else.

## Async / Await

- `async function` is used for every awaitable boundary; raw `Promise` is reserved for `withDeadline`, `Promise.race`, and explicit deduplication (`inflightSnapshot`).
- Never use `.then()` chaining for control flow — use `await` and discriminated unions.
- Top-level await is used only inside the boot IIFE (`server/index.ts:91-147`).

---

*Conventions analysis: 2026-05-04*
