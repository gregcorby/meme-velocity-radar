# Directory Structure

**Analysis Date:** 2026-05-04

## Layout

```
meme-velocity-radar/
├── README.md                    # Operator-oriented quick-start + Railway notes
├── package.json                 # ESM, scripts: dev / build / start / check / db:push
├── package-lock.json            # npm lockfile (~330 KB)
├── tsconfig.json                # strict TS, paths @/* and @shared/*, includes client+server+shared
├── vite.config.ts               # root=client, output dist/public, aliases
├── tailwind.config.ts           # darkMode class, HSL CSS vars, status + chart palettes
├── postcss.config.js            # tailwindcss + autoprefixer
├── drizzle.config.ts            # sqlite dialect, schema → ./shared/schema.ts, db ./data.db
├── components.json              # shadcn/ui config (style: new-york, baseColor: neutral)
├── .env.example                 # All optional SVS vars + program watchers
├── .gitignore                   # node_modules, dist, .vite, .env*, data.db*
│
├── client/                      # Vite SPA
│   ├── public/                  # Static assets (currently empty/minimal)
│   └── src/
│       ├── main.tsx             # React mount + initial hash-location seed
│       ├── App.tsx              # 924-line single-file SPA — every component + RadarHome
│       ├── index.css            # Tailwind entrypoint + shadcn CSS variables (referenced from main.tsx)
│       ├── components/
│       │   └── ui/              # 47 shadcn/ui components (button, card, sheet, tabs, …)
│       ├── hooks/
│       │   ├── use-mobile.tsx   # matchMedia breakpoint hook
│       │   └── use-toast.ts     # shadcn toast store + reducer (191 lines)
│       ├── lib/
│       │   ├── queryClient.ts   # TanStack Query client + apiRequest helper
│       │   └── utils.ts         # cn() = twMerge(clsx(...))
│       └── pages/
│           └── not-found.tsx    # Wouter fallback route
│
├── server/                      # Express + gRPC backend (single process)
│   ├── index.ts                 # Boot: dotenv, Express, body parsers, request logger,
│   │                            #       error middleware, dev-Vite vs static, gRPC worker start
│   ├── routes.ts                # 942-line: DexScreener fetcher, scoring, meme decode,
│   │                            #          snapshot builder, deadline guards, SSE
│   ├── svs.ts                   # 378-line: SVS REST/RPC client + auth-cooldown state machine
│   ├── grpcStream.ts            # 605-line: Yellowstone gRPC worker, candidate cache, diagnostics
│   ├── storage.ts               # Drizzle + better-sqlite3, single-table snapshot persistence
│   ├── static.ts                # NODE_ENV=production: serve dist/public + SPA fallback
│   └── vite.ts                  # NODE_ENV=development: Vite middleware + HTML transform
│
├── shared/                      # Code imported by BOTH client and server
│   └── schema.ts                # Drizzle table + Zod schemas for RadarSnapshot/TokenSignal/MetaSignal
│
├── script/                      # Build / ops scripts
│   └── build.ts                 # vite build (client) + esbuild (server → dist/index.cjs)
│
├── docs/                        # Operator-facing product documentation
│   ├── PRODUCT.md               # What the product is, who it's for, working features, non-goals
│   ├── ARCHITECTURE.md          # System diagram, data pipeline, components, safety, limitations
│   ├── ROADMAP.md               # P0 stabilise, P1 decoders/risk/social, P2 later
│   └── RUNBOOK.md               # Local + Railway deploy, env vars, health endpoints, troubleshooting
│
└── .planning/                   # GSD planning workspace (this directory)
    └── codebase/                # Output of /gsd-map-codebase
```

## Key Locations

### Where business logic lives
- **Snapshot orchestration:** `server/routes.ts` — `buildSnapshot()`, `buildSnapshotWithDeadline()`. Owns the merge of DexScreener + gRPC + SVS into a single `RadarSnapshot`.
- **Per-token scoring:** `server/routes.ts` (helpers like `clamp()`, txn/volume getters, plus the velocity / virality / upside / risk computation inside the snapshot builder loop).
- **gRPC ingestion + parsing:** `server/grpcStream.ts` — `loadWatchPrograms()`, `buildFilters()`, the `startGrpcWorker()` reconnect loop, the token-balance parser, and the candidate cache.
- **External API plumbing:** `server/svs.ts` — `fetchSvsMetadata`, `fetchSvsPrices`, `fetchSvsMintInfo`, `getSvsHealthReport`, `getSvsAuthCooldown`. Inline DexScreener fetches live in `server/routes.ts:139-178` (`fetchJson`).

### Where UI lives
- **Entire SPA:** `client/src/App.tsx`. Every screen, badge, card, and helper is exported from this one file.
- **Reusable primitives:** `client/src/components/ui/` (shadcn/ui — do not edit by hand without re-running the shadcn add command unless you intentionally diverge).
- **Hooks:** `client/src/hooks/`.
- **Tiny client utilities:** `client/src/lib/`.

### Where the data contract lives
- `shared/schema.ts` — `radarSnapshotSchema`, `tokenSignalSchema`, `metaSignalSchema`, `grpcSummarySchema` (Zod) plus inferred TS types. **Both** server and client import from this file via the `@shared/*` alias. Do not duplicate these types in either tree.

### Where DB code lives
- Schema: `shared/schema.ts:5-9` (Drizzle `sqliteTable` for `radar_snapshots`).
- Connection + storage class: `server/storage.ts` (single instance: `storage` exported at the bottom).
- Migrations: configured to land in `./migrations` (`drizzle.config.ts`); not currently checked in. `npm run db:push` writes schema directly.

### Where build / deploy config lives
- Local dev: `npm run dev` → `tsx server/index.ts`; Vite is mounted as middleware at runtime by `server/vite.ts`.
- Production build: `npm run build` → `script/build.ts`. Outputs `dist/public/` (SPA) and `dist/index.cjs` (server bundle). `dist/` is gitignored.
- Production start: `npm start` → `node dist/index.cjs`.
- Railway: see `docs/RUNBOOK.md` (build = `npm install && npm run build`, start = `npm start`).

## Naming Conventions

**Filenames:**
- Server TypeScript: `camelCase.ts` (`grpcStream.ts`, `routes.ts`, `storage.ts`, `svs.ts`, `static.ts`, `vite.ts`, `index.ts`).
- React component files: `PascalCase.tsx` for top-level pages (`App.tsx`), but shadcn/ui primitives use `kebab-case.tsx` (`alert-dialog.tsx`, `dropdown-menu.tsx`, `not-found.tsx`).
- Hooks: `kebab-case.ts(x)` prefixed with `use-` (`use-toast.ts`, `use-mobile.tsx`).
- Library helpers: `camelCase.ts` (`queryClient.ts`, `utils.ts`).
- Config: `kebab.config.ts` (`vite.config.ts`, `tailwind.config.ts`, `drizzle.config.ts`).

**Identifiers:**
- TypeScript types / interfaces / Zod schemas: `PascalCase` (`RadarSnapshot`, `TokenSignal`, `MetaSignal`, `GrpcSummary`, `IStorage`, `DatabaseStorage`).
- Zod schema variables: `camelCase` ending in `Schema` (`tokenSignalSchema`, `radarSnapshotSchema`).
- Functions / methods / variables: `camelCase` (`buildSnapshot`, `withDeadline`, `fetchJson`, `mapPool`, `recordsByMint`).
- React components: `PascalCase` (`RadarHome`, `TokenCard`, `DetailPanel`, `SvsBadge`, `GrpcBadge`).
- Constants (module-scoped): `SCREAMING_SNAKE_CASE` (`CACHE_MS`, `REFRESH_SECONDS`, `MAX_CANDIDATES`, `RADAR_BUILD_DEADLINE_MS`, `KEEPALIVE_MS`, `WATCH_PROGRAMS`).
- Env vars: `SCREAMING_SNAKE_CASE` with `SVS_` / `WATCH_` / `ENABLE_` prefixes.

**Path aliases (use these, do NOT use deep relative paths):**
- `@/*` → `client/src/*` (client-side imports)
- `@shared/*` → `shared/*` (cross-cutting types/schema)
- `@assets/*` → `attached_assets/*` (configured in `vite.config.ts`; directory does not currently exist)

## Where to Add New Code

| Adding a... | Put it in... | Pattern to follow |
|-------------|--------------|-------------------|
| New backend HTTP route | `server/routes.ts` inside `registerRoutes()` (`server/routes.ts:855`). | Mirror existing handlers: deadline-bound async (`withDeadline`), return JSON, never throw past the Express error middleware. If the file grows further, see the split-out plan in `CONCERNS.md`. |
| New scoring signal / risk flag | `server/routes.ts` inside `buildSnapshot()`'s scoring section. | Add the signal to the scoring loop, surface it in `riskFlags` / `opportunityFlags` / `sourceTags`, extend `shared/schema.ts` if the wire shape changes (then both sides see the new field). |
| New external data source (REST) | New file `server/<provider>.ts` modelled on `server/svs.ts`. | Export typed helpers, never log secrets, wrap every fetch with `fetchWithTimeout`-style abort controllers, expose a config getter, expose a health probe. |
| New env var | Add to `.env.example` (with comment), read via `process.env.X?.trim()` inside the relevant module. | Document defaults in the same comment block; never prefix with `VITE_`; surface presence (boolean) — never the value — through any health endpoint. |
| New gRPC watched program | Add `WATCH_<NAME>_PROGRAM` to `.env.example`, extend `loadWatchPrograms()` (`server/grpcStream.ts:94-134`), add the program name to `LAUNCHPAD_NAMES` or `DEX_POOL_NAMES`, update `buildFilters()` if it should land in a new filter group. |
| New table / DB column | Edit `shared/schema.ts` (Drizzle table + Zod insert schema), update `server/storage.ts` if you need a new method on `IStorage`, run `npm run db:push`. Do **not** add a duplicate `CREATE TABLE` to `server/storage.ts:9-15` — extend the inline statement instead. |
| New shared type used by both server and client | `shared/schema.ts` (extend an existing Zod schema). Import via `@shared/schema` from both sides. |
| New page / route in the SPA | Add a `client/src/pages/<name>.tsx` file, register it in `AppRouter()` (`client/src/App.tsx:902`). All routes go through `wouter` with `useHashLocation`. |
| New presentational component used in multiple places | New file `client/src/components/<name>.tsx` (the `components/` folder currently only has the `ui/` subfolder — create a sibling). Use `cn()` from `@/lib/utils`. Match the shadcn primitive style. |
| New shadcn primitive | Run `npx shadcn add <name>` so it lands in `client/src/components/ui/`; do not hand-author. Update `components.json` only if you intentionally diverge. |
| New custom hook | `client/src/hooks/use-<name>.ts(x)`. Mirror the file shape of `use-mobile.tsx` (default-export not used; named-export the hook). |
| New utility function | `client/src/lib/<name>.ts` (client) or top-of-file in the relevant `server/*.ts` (server). Avoid creating a `server/lib/` until there are 3+ candidates. |
| New build-time/CLI script | `script/<name>.ts`, ran via `tsx`. Add a corresponding npm script in `package.json`. |
| New documentation | `docs/<NAME>.md` (operator-facing) or `.planning/codebase/<NAME>.md` (internal Claude-facing context). |

## Files NOT Currently Present (worth knowing)

- No `tests/` or `__tests__/` — no test framework is installed (see `TESTING.md`).
- No `.eslintrc*` / `.prettierrc*` / `eslint.config.*` / `biome.json` — formatting/linting are not enforced (see `CONVENTIONS.md`).
- No `.github/workflows/` — no CI; deploys are Railway-on-push.
- No `attached_assets/` directory despite the `@assets` Vite alias.
- No `migrations/` directory (Drizzle uses `db:push` rather than checked-in migration files).
- No `apps/` or `packages/` — this is a single-package repo, not a monorepo.

---

*Structure analysis: 2026-05-04*
