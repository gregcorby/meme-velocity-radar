# Conventions

Prescriptive guide for new code. Every rule below is observed in the existing source — file:line citations are load-bearing, not decorative. Follow these rules unless you have a stronger reason than "I prefer the other style".

---

## Code Style

- **Language:** TypeScript everywhere. `tsconfig.json:9` sets `"strict": true`. There is no `// @ts-ignore` in the tree; do not add one. Use real types or narrow with `unknown` and a type guard.
- **Module system:** ESM only. `package.json:5` declares `"type": "module"`. `tsconfig.json:8` sets `"module": "ESNext"`, and `:15` sets `"moduleResolution": "bundler"`. Use `import` / `export`; never `require()`.
- **Path aliases:** Two and only two. `@/*` -> `client/src/*`, `@shared/*` -> `shared/*` (`tsconfig.json:18-21`, mirrored in `vite.config.ts:8-11`). Server code uses `@shared/...` (`server/routes.ts:4`); client uses both (`client/src/App.tsx:6-16`). Do not add new aliases without updating both files.
- **Formatting / linting:** **None configured.** No `.eslintrc*`, no `.prettierrc*`, no `eslint.config.*`, no `biome.json`, no `.editorconfig`. The only enforced check is `npm run check` -> `tsc` (`package.json:10`). Match the surrounding file's style; do not reformat unrelated lines.
- **Indentation:** 2 spaces. No tabs. Confirmed across `server/routes.ts`, `server/svs.ts`, `client/src/App.tsx`.
- **Quotes:** Double quotes for strings (`server/routes.ts:1`, `client/src/App.tsx:1-3`). Single quotes appear only in `client/src/lib/utils.ts:1-2` from the shadcn generator — do not propagate that style.
- **Semicolons:** Required. Every statement in `server/index.ts` and `server/routes.ts` ends in `;`.
- **Trailing commas:** Yes, in multi-line object/array/parameter lists (`server/index.ts:122-127`, `shared/schema.ts:108-113`).
- **Import order (observed):** (1) Node built-ins with the `node:` prefix (`server/index.ts:6` `from "node:http"`), (2) third-party packages (`express`, `react`, `wouter`, `lucide-react`), (3) `@shared/*` aliases, (4) `@/*` client aliases, (5) relative imports (`./routes`, `./static`). Type-only imports use `import type` (`server/index.ts:2-3`, `server/routes.ts:1-4`) — keep them on their own lines or grouped with the matching value import.
- **No top-level side effects** outside the boot IIFE in `server/index.ts:91-147` and the `createRoot(...).render(<App />)` line in `client/src/main.tsx:9`. Module load must not perform I/O.

---

## Naming

| Kind | Rule | Example |
| --- | --- | --- |
| Source filenames (server / shared) | `camelCase.ts` | `server/grpcStream.ts`, `server/svs.ts`, `shared/schema.ts` |
| Source filenames (React components) | `PascalCase.tsx` for pages, `kebab-case.tsx` for shadcn primitives | `client/src/pages/not-found.tsx:4` (`export default function NotFound`); shadcn lives in `client/src/components/ui/` |
| Hook filenames | `use-thing.ts` / `use-thing.tsx` | `client/src/hooks/use-toast.ts`, `client/src/hooks/use-mobile.tsx` |
| Hook identifiers | `useThing` (camelCase, `use` prefix) | `useTheme` (`client/src/App.tsx:80`), `useHashLocation` (`client/src/App.tsx:3`) |
| Type aliases | `PascalCase` via `type X = ...` | `type DexPair` (`server/routes.ts:37`), `type GrpcCandidate` (`server/grpcStream.ts:47`) |
| Discriminated-union members | quoted lowercase string literals | `GrpcStatusKind` members (`server/grpcStream.ts:11-17`): `"disabled" \| "configured" \| "connecting" \| ...` |
| Zod schemas | `camelCaseSchema`, suffix `Schema` always | `tokenSignalSchema` (`shared/schema.ts:33`), `metaSignalSchema` (`shared/schema.ts:76`), `radarSnapshotSchema` (`shared/schema.ts:101`) |
| Inferred types from Zod | `PascalCase`, no suffix, via `z.infer` | `export type TokenSignal = z.infer<typeof tokenSignalSchema>` (`shared/schema.ts:119`) |
| Functions (regular and async) | `camelCase`; verbs for actions, nouns for getters | `buildSnapshot` (`server/routes.ts:538`), `fetchJson` (`server/routes.ts:139`), `getSvsConfig` (`server/svs.ts:47`) |
| Internal helpers | `camelCase`, often single-letter when load-bearing in many call sites | `n` for numeric coercion (`server/routes.ts:121`), `cn` for class merge (`client/src/lib/utils.ts:5`) |
| React components | `PascalCase`, default-export only for routed pages | `function Logo()` (`client/src/App.tsx:141`), `function SvsBadge` (`client/src/App.tsx:158`), default export `NotFound` (`client/src/pages/not-found.tsx:4`) |
| Module-private constants | `SCREAMING_SNAKE_CASE` | `RADAR_BUILD_DEADLINE_MS` (`server/routes.ts:81`), `AUTH_REJECTED_COOLDOWN_MS` (`server/svs.ts:14`), `KEEPALIVE_MS` (`server/grpcStream.ts:72`) |
| Numeric literals | use `_` separators for thousands/ms | `12_000`, `5 * 60_000`, `45 * 60_000` (`server/routes.ts:81`, `server/svs.ts:14`, `server/grpcStream.ts:75`) |
| Env vars | `SCREAMING_SNAKE_CASE`; backend secrets unprefixed | `SVS_API_KEY`, `SVS_GRPC_ENDPOINT`, `WATCH_PUMPSWAP_PROGRAM` (`server/svs.ts:50-53`, `server/grpcStream.ts:104`). Booleans use `parseBoolEnv` (`server/grpcStream.ts:80-87`) |
| Express route paths | lowercase, hyphenless, namespaced under `/api/...` | `app.get("/api/svs/health", ...)` (`server/routes.ts:856`), `/api/grpc/status` (`:882`), `/api/radar` (`:893`), `/api/radar/stream` (`:913`) |
| Client routes | hash-based via wouter | `useHashLocation` (`client/src/App.tsx:3`); `main.tsx:5-7` seeds `window.location.hash = "#/"` |
| `data-testid` values | kebab-case, `category-purpose[-id]` template strings | `data-testid="badge-svs-status"` (`client/src/App.tsx:182`), `` data-testid={`button-token-${token.id}`} `` (`:270`), `data-testid="input-search"` (`:782`), `data-testid="button-export-csv"` (`:785`) |

---

## Patterns

Every pattern below is already in the codebase. Use them when adding new code that hits the same shape; do not invent parallel mechanisms.

### Result objects instead of throwing (I/O boundary)

Outbound HTTP returns a discriminated union; callers branch on `ok`. No `try/catch` at the call site.

```ts
// server/routes.ts:139
async function fetchJson<T>(path: string, label: string, timeoutMs = 6_000): Promise<{ ok: true; data: T } | { ok: false; error: string; label: string }>
```

The same shape is used by `postBatch` in `server/svs.ts:144-147`. Use `Promise<{ ok: true; ... } | { ok: false; error: string; ... }>` for any new outbound network call.

### Deadline-bound async via `withDeadline`

Wrap any work that has an external dependency. The fallback is *value-producing*, not throwing.

```ts
// server/routes.ts:87-114
function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T>
```

Used at `server/routes.ts:806` (radar build) and `:878` (health probe). New endpoints that touch upstream services must wrap with `withDeadline` and provide a sensible degraded fallback.

### Belt-and-braces hard deadline + AbortController

`fetch` gets both an `AbortController` *and* a `Promise.race` against a hard deadline 2s longer than the abort timeout — defends against event-loop starvation where the abort timer itself may fire late.

```ts
// server/routes.ts:140-174
const controller = new AbortController();
const timer = setTimeout(() => { try { controller.abort(); } catch { /* ignore */ } }, timeoutMs);
const hardDeadline = new Promise<{ ok: false; error: string; label: string }>((resolve) => {
  setTimeout(() => resolve({ ok: false, error: `hard deadline ${timeoutMs + 2_000}ms`, label }), timeoutMs + 2_000);
});
const result = await Promise.race([ /* fetch IIFE */, hardDeadline ]);
```

Apply the same shape to any new long-tail-prone fetch.

### Defensive parsing — `n()` and `safeString()`

Every untrusted numeric or string field flows through these two helpers, never raw `Number(x)` or `String(x)`.

```ts
// server/routes.ts:121-128
function n(value: unknown, fallback = 0) {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : fallback;
  return Number.isFinite(parsed) ? parsed : fallback;
}
function safeString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}
```

Call sites: `server/routes.ts:195-204, 264-302, 519-535`. Use these even when TypeScript thinks the field is `number` — upstream payloads lie.

### Bounded fan-out — `mapPool`

Never use bare `Promise.all` over an external API. Cap concurrency.

```ts
// server/routes.ts:180-191
async function mapPool<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]>
```

Choose `limit` based on the upstream's documented rate, not the size of `items`.

### Single-flight (request coalescing)

Concurrent calls share one in-flight build. Critical on a small Railway box.

```ts
// server/routes.ts:85, 787-804
let inflightSnapshot: Promise<RadarSnapshot> | null = null;
// ...
if (!inflightSnapshot) {
  const work = (async () => {
    try { return await buildSnapshot(force); }
    finally { setImmediate(() => { inflightSnapshot = null; }); }
  })();
  inflightSnapshot = work;
}
```

Note the `setImmediate` clear — same-tick callers still receive the in-flight promise.

### Zod schema as wire contract

`shared/schema.ts` is the single source of truth for every `/api` payload shape. Backend builds objects that match `radarSnapshotSchema` (`shared/schema.ts:101-117`); client imports the inferred types directly (`client/src/App.tsx:16`). Both sides reference one definition — never duplicate the shape in TS interfaces.

### Status enums via Zod `enum`

Use `z.enum([...])` for status-like fields so values stay in lockstep across server, client, and storage.

```ts
// shared/schema.ts:89
status: z.enum(["disabled", "configured", "connecting", "connected", "reconnecting", "error"])
// shared/schema.ts:110
status: z.enum(["ok", "degraded", "error", "missing"])
```

### shadcn `cn()` composition

```ts
// client/src/lib/utils.ts:5-7
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

Use `cn(...)` for any conditional className. Never string-concatenate Tailwind classes; `twMerge` resolves conflicting utilities.

### Hash-based routing (wouter)

Client routing uses the hash strategy so the app can be served from any base path on Railway/Vercel without server route config.

```tsx
// client/src/App.tsx:2-3
import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
// client/src/main.tsx:5-7
if (!window.location.hash) { window.location.hash = "#/"; }
```

Add new pages by registering a `<Route>` inside the `<Router hook={useHashLocation}>` tree.

### Backend secrets via `process.env.X?.trim()` -> booleans

Never expose raw secrets to clients. The pattern: read with `?.trim()`, surface presence as `Boolean(...)`, send only that boolean.

```ts
// server/svs.ts:47-55
export function getSvsConfig(): SvsConfig {
  return {
    apiBaseUrl: process.env.SVS_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL,
    hasApiKey: Boolean(process.env.SVS_API_KEY?.trim()),
    hasRpcHttp: Boolean(process.env.SVS_RPC_HTTP_URL?.trim()),
    hasRpcWs: Boolean(process.env.SVS_RPC_WS_URL?.trim()),
    hasGrpc: Boolean(process.env.SVS_GRPC_ENDPOINT?.trim()),
  };
}
```

Mirrored in `server/grpcStream.ts:545-547, 565-575`.

### No `VITE_`-prefixed secrets

`.env.example:7` is explicit: *"Sent as `Authorization: Bearer ...` from the backend only. Never prefix with VITE_."* Any variable starting with `VITE_` is bundled into the client. Do not put secrets there. There are zero `VITE_` env vars in this repo — keep it that way.

### Compact structured logging — `summarizeResponseBody`

Log lines must be compact summaries, not raw payloads. The radar response is 50-200KB; dumping it spammed Railway's log pipeline.

```ts
// server/index.ts:42-65
function summarizeResponseBody(path: string, body: unknown): string {
  // returns "tokens=12 sources=3 grpc=connected/8c/420epm" instead of JSON.stringify(body)
}
// server/index.ts:80-85
let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
const summary = summarizeResponseBody(path, capturedJsonResponse);
if (summary) logLine += ` :: ${summary}`;
log(logLine);
```

When you add a new `/api` route, add a branch to `summarizeResponseBody` that emits `key=value` pairs for the 3-5 most diagnostic fields.

### Defensive `any` isolated to one module

`any` is permitted only in `server/grpcStream.ts`, where the yellowstone proto types are wide and many fields are optional. The header makes this explicit:

```ts
// server/grpcStream.ts:5-7
// Defensive parsing: yellowstone proto types are wide and many fields are
// optional. We isolate `any` access to this file and produce a small,
// well-typed candidate object for the rest of the app.
```

Do not introduce `any` elsewhere. If you need it, justify in a header comment and isolate it behind a typed export (compare `GrpcCandidate` at `:47-58`).

### `data-testid` discipline on every interactive element

Every button, badge, input, and dynamic display has a `data-testid`. Use the kebab-case template `category-purpose[-id]`:

- Static elements: literal kebab string — `data-testid="brand-logo"` (`client/src/App.tsx:143`), `data-testid="input-search"` (`:782`), `data-testid="button-export-csv"` (`:785`).
- Per-record elements: backtick template with the record id last — `` data-testid={`button-token-${token.id}`} `` (`:270`), `` data-testid={`badge-risk-${token.id}-${flag}`} `` (`:293`).

Add a `data-testid` to every new interactive or stateful element.

---

## Error Handling

- **Server (Express middleware).** A single tail middleware in `server/index.ts:94-105` catches anything that escapes a route handler, logs it, and responds with `{ message }`. Route handlers should `try/catch` themselves and return a structured fallback (`server/routes.ts:893-911`) before letting an error reach the middleware.
- **Outbound HTTP.** Result objects, never thrown errors (`fetchJson` at `server/routes.ts:139`). Auth-rejection responses (401/403) trigger a 5-minute cooldown so the radar stops hammering an invalid key (`server/svs.ts:14-26`); probes for `/api/svs/health` skip the cooldown so the badge can recover.
- **Streaming (SSE).** Errors are emitted as a typed event, not by closing the connection.

  ```ts
  // server/routes.ts:927-930
  res.write(`event: error\n`);
  res.write(`data: ${JSON.stringify({ message: error instanceof Error ? error.message : "scanner failed" })}\n\n`);
  ```

  The interval keeps running; the next tick attempts another snapshot.
- **Client (TanStack Query).** Retries are off globally so failures show fast. `client/src/lib/queryClient.ts:43-55` sets `retry: false` for both queries and mutations. Surface failures in UI, do not auto-retry.
- **`apiRequest` throws.** `client/src/lib/queryClient.ts:5-10` builds a rich error message (`${status}: ${text}`) so the global error boundary / toast layer has something useful to display.

---

## Comments

Sparse. Explain *why*, not *what*. Comments cluster around tradeoffs that future readers will second-guess.

- `server/index.ts:39-41` — why `summarizeResponseBody` exists ("50-200KB and were spamming the Railway log pipeline").
- `server/routes.ts:78-80` — why `RADAR_BUILD_DEADLINE_MS` exists ("return whatever we have... instead of hanging the request for minutes").
- `server/routes.ts:148-149` — why we double-wrap `fetch` ("defend against event-loop starvation where the AbortController's setTimeout might be delayed past the timeout").
- `server/routes.ts:788-790` — why single-flight ("protect a small Railway container from running multiple builds in parallel under load").
- `server/svs.ts:1-3` — module-level "do not import from client" boundary marker.
- `server/svs.ts:9-13` — why `AUTH_REJECTED_COOLDOWN_MS` exists ("stops hammering the API with an invalid key... probes skip the cooldown so users can see when the key becomes valid again").
- `server/grpcStream.ts:88-92` — why AMM v4 is opt-in ("firehose that can OOM small Railway containers").

When you add a non-obvious tradeoff (deadline, retry, fallback, isolation), add a 1-3 line comment in the same shape.

---

## Imports / Module Boundaries

These boundaries are enforced by convention, not tooling. Honor them.

- **`server/*` -> may import:** `node:*`, third-party deps, `@shared/*`. **Must not import:** `client/*` or `@/*`. Example: `server/routes.ts:4` imports `@shared/schema`, never `@/...`.
- **`client/*` -> may import:** third-party deps, `@/*`, `@shared/*`. **Must not import:** `server/*`. Example: `client/src/App.tsx:16` imports `@shared/schema` for types only.
- **`shared/*` -> must be runtime-safe in both Node and browser.** No `node:*` imports, no `process.env`, no DOM access. `shared/schema.ts` only imports `drizzle-orm/sqlite-core`, `drizzle-zod`, and `zod` — all isomorphic when used as type/value in the schema-only sense.
- **`server/svs.ts` and `server/grpcStream.ts` are explicitly backend-only.** Both files state this in their header comment (`server/svs.ts:1-3`, `server/grpcStream.ts:1-3`). They read secret env vars; importing them from the client would either fail at bundle-time or, worse, leak secrets.

---

## Async / Await

- **`async function` everywhere** at the boundary. All route handlers (`server/routes.ts:856, 882, 893, 913`), all I/O helpers (`fetchJson`, `mapPool`, `buildSnapshot`), all storage methods (`server/storage.ts:25-31`).
- **Raw `Promise` reserved for two cases only:**
  1. `Promise.race` against a hard deadline (`server/routes.ts:150-155, 157-173`).
  2. Single-flight deduplication state (`server/routes.ts:85` — `let inflightSnapshot: Promise<RadarSnapshot> | null`).
- **Top-level `await` only inside the boot IIFE** in `server/index.ts:91-147`. Module evaluation must not await — it would block import graph resolution and break tooling.
- **Fire-and-forget writes** use `.catch(() => undefined)` to silence unhandled rejections without losing the side effect (`server/routes.ts:766-771`, `:899`).
- **`void` prefix** for intentionally-unawaited background work (`server/grpcStream.ts:557-560`).

---

*Conventions analysis: 2026-05-04*
