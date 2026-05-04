# Coding Conventions

**Analysis Date:** 2026-05-04

## Naming Patterns

**Files:**
- React components and pages: kebab-case `.tsx` (e.g. `client/src/pages/not-found.tsx`, `client/src/components/ui/alert-dialog.tsx`, `client/src/hooks/use-mobile.tsx`).
- Top-level React app entry: `App.tsx`, `main.tsx` (PascalCase / lowercase entrypoints).
- Server modules: camelCase `.ts` (e.g. `server/grpcStream.ts`, `server/routes.ts`, `server/storage.ts`, `server/svs.ts`).
- Shared schemas: camelCase `.ts` (e.g. `shared/schema.ts`).
- Build / config scripts: camelCase or kebab `.ts` at root (`script/build.ts`, `vite.config.ts`, `drizzle.config.ts`, `tailwind.config.ts`).
- Use kebab-case for any new shadcn-style UI primitive in `client/src/components/ui/`. Use camelCase for any new server-side module under `server/`.

**Functions:**
- Use `camelCase` for all functions (e.g. `summarizeResponseBody`, `parseBoolEnv`, `loadWatchPrograms`, `apiRequest`, `scorePair`, `fetchJson`, `mapPool`).
- React components use `PascalCase` and are typically declared with `function Name(...)` or `const Name = React.forwardRef(...)` (e.g. `Button`, `Card`, `NotFound`).
- React hooks start with `use` (`useToast`, `useIsMobile`, `useTheme`).
- Internal helpers may be a single letter only when intent is local and obvious (e.g. `n(value, fallback)` in `server/routes.ts`); prefer descriptive names for anything exported.

**Variables:**
- Use `const` by default; only use `let` for values that genuinely mutate (see counters and caches in `server/routes.ts`, `server/svs.ts`).
- Use `camelCase` for locals and module-level state.
- Use `SCREAMING_SNAKE_CASE` for module-level constants (e.g. `CACHE_MS`, `REFRESH_SECONDS`, `MAX_CANDIDATES`, `RADAR_BUILD_DEADLINE_MS`, `KEEPALIVE_MS`, `STABLE_BLOCKLIST`, `MOBILE_BREAKPOINT`, `TOAST_LIMIT`).
- Use numeric separators for large literals (`25_000`, `45 * 60_000`, `1_000_000`).

**Types:**
- Use `PascalCase` for `type` aliases and `interface`s (e.g. `TokenSignal`, `RadarSnapshot`, `DexPair`, `GrpcCandidate`, `IStorage`, `DatabaseStorage`).
- Prefer `type` aliases for object shapes that describe data; use `interface` only when extending (e.g. `IStorage` interface in `server/storage.ts`).
- Always derive runtime + type pairs from Zod when payload validation matters: define a `*Schema` then export `type X = z.infer<typeof xSchema>` (see `shared/schema.ts`).
- Use string-literal unions for closed enums (e.g. `GrpcStatusKind`, `SvsHealthStatus`, `SortMode`, `FilterMode`).

## Code Style

**Formatting:**
- Not configured. There is no `.prettierrc`, `eslint.config.*`, `biome.json`, or `.editorconfig` in the repo.
- Match the existing style of neighbouring files: 2-space indent, double-quoted strings, trailing commas on multi-line literals, semicolons at end of statements.
- Mixed quote styles exist (e.g. single quotes in `client/src/lib/utils.ts` for `clsx`/`class-variance-authority` imports). When editing an existing file, follow that file's local convention; for new files prefer double quotes.

**Linting:**
- Not configured. No ESLint/Biome rules are enforced.
- The only static check is `npm run check` which runs `tsc` (`"check": "tsc"` in `package.json`). TypeScript runs in `"strict": true` mode with `noEmit` (see `tsconfig.json`).
- Run `npm run check` before committing any change that touches `.ts`/`.tsx` files.

## Import Organization

**Order:**
1. Node built-ins, prefixed with `node:` (e.g. `import path from "node:path"`, `import fs from "node:fs"`, `import { createServer } from "node:http"`).
2. External packages (e.g. `react`, `express`, `@tanstack/react-query`, `drizzle-orm`, `lucide-react`).
3. Aliased project imports (`@/...`, `@shared/...`, `@assets/...`).
4. Relative imports (`./routes`, `../vite.config`).

**Path Aliases (from `tsconfig.json` and `vite.config.ts`):**
- `@/*` -> `client/src/*` (use from any client code).
- `@shared/*` -> `shared/*` (cross-cutting types/schemas, importable from both client and server).
- `@assets/*` -> `attached_assets/*` (Vite-only, for static assets).

**Type-only imports:**
- Use `import type { ... }` for type-only references to keep emit clean (e.g. `import type { Express } from 'express'`, `import type { ClassValue } from 'clsx'`, `import type { InsertRadarSnapshot, RadarSnapshotRecord } from "@shared/schema"`).

**Boundaries:**
- Server-only modules (`server/svs.ts`, `server/grpcStream.ts`) read secrets from `process.env` and must NEVER be imported from `client/*`. Both files document this at the top:

  ```ts
  // SVS Geyser gRPC live stream manager.
  // Backend-only — never import this from client/* code. It reads secret env
  // vars (SVS_GRPC_X_TOKEN) and forwards them to the SVS endpoint.
  ```

  Maintain this boundary; do not import server modules from `client/src/`.

## Error Handling

**Patterns:**
- Throw `Error` instances for genuinely exceptional cases (e.g. `serveStatic` throws if `dist/public` is missing).
- For network/IO that can fail repeatedly, return a discriminated `{ ok: true; data } | { ok: false; error }` result instead of throwing. See `fetchJson<T>` and `postBatch<T>` in `server/routes.ts` and `server/svs.ts`.
- Use `AbortController` + `setTimeout` to bound every external fetch (see `fetchWithTimeout` in `server/svs.ts`, `fetchJson` in `server/routes.ts`).
- Add a `withDeadline(promise, ms, onTimeout)` wrapper for promises that must never block the event loop indefinitely; build per-request budgets like `RADAR_BUILD_DEADLINE_MS = 12_000`.
- In Express handlers, let errors propagate to the central error middleware in `server/index.ts`:

  ```ts
  app.use((err, _req, res, next) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    console.error("Internal Server Error:", err);
    if (res.headersSent) return next(err);
    return res.status(status).json({ message });
  });
  ```
- For non-fatal errors inside loops/streams, log with a `[source]` prefix and continue (e.g. `console.error("[grpc] update parse error:", error)`). Never let a single bad event tear down a long-lived stream.
- When narrowing `unknown` errors, use `error instanceof Error ? error.message : String(error)`.

## Logging

**Framework:** `console` plus a small `log()` helper in `server/index.ts`.

**Patterns:**
- Server requests: pipe through the `log()` helper, which prepends a localized timestamp and an `[express]` (or custom) source tag.
- Long-running workers / streams: pass an explicit source tag, e.g. `log("gRPC worker started", "grpc")`.
- Direct `console.error("[grpc] ...")` is acceptable for hot-path stream errors where the structured `log()` would be noisy.
- Sanitize large response bodies before logging — see `summarizeResponseBody()` in `server/index.ts`. Do not dump 50–200KB radar payloads into logs.
- Never log API keys, bearer tokens, or anything from `process.env.SVS_*`. The auth helpers in `server/svs.ts` keep secrets confined to `Authorization` headers.
- Client-side logging is rare; prefer the toast system (`useToast` in `client/src/hooks/use-toast.ts`) for user-facing feedback.

## Comments

**When to Comment:**
- Explain *why*, not *what*. The codebase favours short paragraph comments above tricky blocks (see deadline rationale in `server/routes.ts:78-82`, AMM v4 gating in `server/grpcStream.ts:89-92`, auth cooldown in `server/svs.ts:9-14`).
- Annotate cross-cutting invariants and security boundaries at the top of the file (e.g. "Backend-only — never import this from client/* code").
- Use `// ignore` inside empty `catch` arms when the swallow is intentional.

**JSDoc/TSDoc:**
- Not used. Types carry the contract; prefer plain `//` comments for prose. Do not add JSDoc unless documenting a public published API.

## Function Design

**Size:**
- Keep functions focused; the project tolerates large orchestrator functions (e.g. `scorePair` in `server/routes.ts`) only when they are pure data assembly. Extract helpers (`getTxns`, `getVolume`, `logNorm`, `clamp`, `n`, `safeString`) when computing the same shape in multiple places.

**Parameters:**
- Prefer positional params for 1–3 arguments. Use a single options object for >3 or for boolean configuration (see `getQueryFn({ on401: "throw" })` in `client/src/lib/queryClient.ts`).
- Default values inline (`function clamp(value, min = 0, max = 100)`).
- Generic helpers should take a callback last (`mapPool<T, R>(items, limit, mapper)`).

**Return Values:**
- Return discriminated unions for fallible operations (`{ ok: true, data } | { ok: false, error }`).
- Return `null` (not `undefined`) for "not found" / "no value" sentinels in domain code (see `compactUrlLabel`, `scorePair`).
- Async functions explicitly annotate `Promise<T>` for any non-trivial return type.

## Module Design

**Exports:**
- Prefer named exports throughout (`export function`, `export const`, `export type`, `export class`). The codebase uses `export default` only for React page components and config files (`vite.config.ts`, `drizzle.config.ts`, `not-found.tsx`).
- Co-locate the runtime value and its type next to the schema that produced it (see `shared/schema.ts`: schema -> `z.infer` -> exported type).

**Barrel Files:**
- Not used. Import each module directly (`import { storage } from "./storage"`, `import { Button } from "@/components/ui/button"`). Do not introduce `index.ts` re-exports.

**Singletons:**
- Long-lived singletons (`storage`, `queryClient`, `db`, `memoryCache`, `WATCH_PROGRAMS`) are created at module load. Keep their construction side-effect-free aside from logging; gate any optional side effects (like `startGrpcWorker`) behind explicit calls from `server/index.ts`.

---

*Convention analysis: 2026-05-04*
