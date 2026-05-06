# Coding Conventions

**Analysis Date:** 2026-05-05

## Naming Patterns

**Files:**
- React components: PascalCase.tsx (e.g., `client/src/pages/not-found.tsx` uses kebab-case for pages, but components defined inside files use PascalCase)
- UI library components: kebab-case.tsx in `client/src/components/ui/` (e.g., `button.tsx`, `card.tsx`, `alert-dialog.tsx`)
- Server modules: camelCase.ts (e.g., `server/routes.ts`, `server/grpcStream.ts`, `server/storage.ts`, `server/svs.ts`)
- Hooks: use-kebab-case.ts / use-kebab-case.tsx in `client/src/hooks/` (e.g., `use-mobile.tsx`, `use-toast.ts`)
- Build/config scripts: camelCase.ts (e.g., `script/build.ts`)

**Functions:**
- Server utilities: camelCase (e.g., `fetchJson`, `buildSnapshot`, `scorePair`, `classifyMeme`, `withDeadline`)
- React components: PascalCase (e.g., `RadarHome`, `TokenCard`, `DetailPanel`, `ScorePill`, `MetaRail`)
- React hooks (custom): `use` prefix, camelCase (e.g., `useTheme`, `useIsMobile`, `useQuery`)
- Exported Express route handlers: verbs as camelCase (e.g., `registerRoutes`, `startGrpcWorker`)
- Short helper functions: single-letter names acceptable for numeric coercions (e.g., `n(value, fallback)` in `server/routes.ts`)

**Variables:**
- camelCase throughout — `memoryCache`, `lastGoodSnapshot`, `inflightSnapshot`, `sourceHealth`
- Constants: SCREAMING_SNAKE_CASE for module-level (e.g., `DEX`, `CACHE_MS`, `REFRESH_SECONDS`, `MAX_CANDIDATES`, `RADAR_BUILD_DEADLINE_MS`, `STABLE_BLOCKLIST`, `CANDIDATE_TTL_MS`)
- Boolean env parse results: camelCase prefixed with `ENABLE_` in screaming snake for the env var, then assigned to camelCase (e.g., `ENABLE_GRPC_DEX_POOLS`, `ENABLE_RAYDIUM_AMM_V4`)

**Types:**
- PascalCase for interfaces, type aliases, and exported types (e.g., `TokenSignal`, `RadarSnapshot`, `GrpcCandidate`, `SvsConfig`, `SvsHealthStatus`)
- Local-only types declared at module scope with `type` keyword, not `interface` (e.g., `type DexLink`, `type TokenProfile`, `type DexPair`, `type SortMode`, `type FilterMode`)
- Discriminated result types used for error handling: `{ ok: true; data: T } | { ok: false; error: string; label: string }` — see `fetchJson` in `server/routes.ts`

## Code Style

**Formatting:**
- No `.prettierrc` or `.eslintrc` found at repo root — formatting is unenforced by tooling
- TypeScript `strict: true` enforced via `tsconfig.json`
- Trailing commas visible in object literals and function arg lists
- Single quotes for imports in some files, double quotes in others (inconsistent — no formatter enforcing it)
- Template literals preferred for string interpolation

**Linting:**
- No ESLint config file present — project relies on TypeScript strict mode only
- `eslint-disable-next-line no-console` comments are used in `server/grpcStream.ts` lines 501 and 532 to suppress console.error in specific intentional cases
- No Biome or other linter config detected

## Import Organization

**Order (observed pattern in server files):**
1. External library imports (`import "dotenv/config"`, `import express from 'express'`)
2. Node built-ins (`import { createServer } from "node:http"`)
3. Internal server modules (`import { registerRoutes } from "./routes"`)
4. Shared schema types (`import type { MetaSignal } from "@shared/schema"`)

**Order (observed in client files, e.g., `client/src/App.tsx`):**
1. React core (`import { useEffect, useMemo, useState } from "react"`)
2. Third-party libraries (`import { Switch, Route } from "wouter"`, `import { useQuery } from "@tanstack/react-query"`)
3. Internal UI components via `@/` alias (`import { Toaster } from "@/components/ui/toaster"`)
4. Shared schema types (`import type { RadarSnapshot } from "@shared/schema"`)
5. Icon libraries (`import { Activity, AlertTriangle, ... } from "lucide-react"`)
6. Chart libraries

**Path Aliases (defined in `tsconfig.json` and `vite.config.ts`):**
- `@/*` → `./client/src/*` (client-side code)
- `@shared/*` → `./shared/*` (shared schema types)
- `@assets/*` → `./attached_assets/*` (static assets, Vite only)

**Import style:**
- Type-only imports use `import type { ... }` explicitly (e.g., `import type { Express } from "express"`, `import type { TokenSignal } from "@shared/schema"`)
- Side-effect imports at top (e.g., `import "dotenv/config"` in `server/index.ts`)

## Error Handling

**Server-side patterns:**
- Result objects used for all async fetch operations: `{ ok: true; data: T } | { ok: false; error: string }` — see `fetchJson` in `server/routes.ts` and `postBatch` in `server/svs.ts`
- `error instanceof Error ? error.message : String(error)` pattern used uniformly for unknown error coercion
- Deadline/timeout wrapping via `withDeadline<T>(promise, ms, onTimeout)` in `server/routes.ts`
- `try/catch` with empty catch blocks used for cleanup where errors are expected and ignorable (e.g., `clearTimeout` after AbortController, `stream.end()` cleanup)
- Express global error handler in `server/index.ts` catches unhandled route errors and returns `{ message }` JSON
- Auth rejection cooldown tracked in module-level state in `server/svs.ts` to avoid hammering rejected API key

**Client-side patterns:**
- React Query `error` state displayed in the UI as `Card` with `AlertTriangle` icon — see `RadarHome` in `client/src/App.tsx`
- `throwIfResNotOk` helper in `client/src/lib/queryClient.ts` throws on non-2xx responses with `${status}: ${text}` format
- Image load errors handled locally with `useState(false)` + `onError` callback in `TokenAvatar` component

**Fallback/degraded patterns:**
- Multi-level snapshot fallback: in-memory cache → `lastGoodSnapshot` module var → database record — see `buildSnapshot` and `latestUsableSnapshot` in `server/routes.ts`
- Source health array (`sourceHealth: RadarSnapshot["sourceHealth"]`) uses `"ok" | "degraded" | "error" | "missing"` status enum to surface partial failures without crashing

## Logging

**Framework:** Custom `log(message, source)` function in `server/index.ts` using `console.log`

**Pattern:**
```typescript
export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", { ... });
  console.log(`${formattedTime} [${source}] ${message}`);
}
```

**Usage rules observed:**
- `log(msg)` for Express request logs (default source = "express")
- `log(msg, "grpc")` for gRPC worker events
- `console.error(...)` used directly for internal errors where stack trace is needed (with `eslint-disable-next-line no-console` on the preceding line)
- Response body logging is **compact and sanitized**: `summarizeResponseBody` in `server/index.ts` extracts summary fields instead of dumping full JSON (originally full JSON was spamming Railway logs)

## Comments

**When to Comment:**
- Explain non-obvious decisions and trade-offs (e.g., "Hard cap on total time /api/radar will spend..." above `RADAR_BUILD_DEADLINE_MS`)
- Document env var names and their expected behavior in proximity to where they are read
- Call out intentional `// ignore` patterns in empty catch blocks
- Mark backend-only modules at the top of the file (e.g., `// Backend-only — never import this module from any client/* code` in `server/svs.ts`, `server/grpcStream.ts`)
- Inline numeric magic constants get explanatory comments (e.g., `// 45 minutes`, `// wSOL`, `// USDC`)

**No JSDoc/TSDoc:** No `@param`, `@returns`, or `/** */` doc comments are used anywhere — function signatures with TypeScript types serve as the documentation.

## Function Design

**Size:** Functions are generally kept to a single responsibility. Long functions like `scorePair` in `server/routes.ts` (~160 lines) are intentionally monolithic to keep financial scoring logic in one place and auditable.

**Parameters:**
- Primitive params preferred over large config objects for small helpers
- Optional params use TypeScript optional syntax and default values (`fallback = 0`, `source = "express"`, `force = false`)
- Complex shapes use named type aliases defined at module scope

**Return Values:**
- Server async functions return discriminated union `{ ok: true; ... } | { ok: false; error: string }` for fallible operations
- Sync helpers return primitives directly (numbers, strings, booleans)
- `null` used as explicit "not available" sentinel (e.g., `priceUsd: number | null`, `pairAgeMinutes: number | null`)

**Arrow vs. function declarations:**
- Top-level async functions use `async function` declarations (e.g., `async function buildSnapshot`, `async function fetchJson`)
- Short pure helpers use `function` declarations at module scope (e.g., `function clamp`, `function n`, `function safeString`)
- React components use `function` declarations (not arrow functions) for top-level components
- Callbacks and inline workers use arrow functions

## Module Design

**Exports:**
- Named exports are the default pattern; no default exports except React components (`export default App`, `export default NotFound`)
- Server modules export specific functions and types (e.g., `server/routes.ts` exports `registerRoutes`; `server/svs.ts` exports `getSvsConfig`, `fetchSvsMetadata`, etc.)
- Shared schema (`shared/schema.ts`) exports both Zod schemas and inferred TypeScript types

**Barrel Files:**
- No barrel (`index.ts`) files used in `client/src/components/`, `client/src/hooks/`, or `client/src/lib/`
- Imports reference specific files directly (e.g., `import { Button } from "@/components/ui/button"`)

**UI Components (`client/src/components/ui/`):**
- All UI components are shadcn/ui components using the "new-york" style variant
- Use `cva` (class-variance-authority) for variant-based styling
- Use `cn()` utility from `@/lib/utils` for conditional class merging
- Expose `displayName` for React DevTools (e.g., `Button.displayName = "Button"`)
- Use `React.forwardRef` for DOM element wrapping

## Data Attributes

**`data-testid` convention used throughout client:**
- Pattern: `data-testid="noun-element-{id}"` (e.g., `data-testid="button-token-${token.id}"`, `data-testid="text-final-score-${token.id}"`, `data-testid="badge-svs-status"`)
- Used on all interactive elements, display values, and key UI sections
- Enables DOM-based integration testing without relying on class names

---

*Convention analysis: 2026-05-05*
