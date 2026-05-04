# Codebase Structure

**Analysis Date:** 2026-05-04

## Directory Layout

```
meme-velocity-radar/
├── client/                  # Vite + React 18 SPA (the entire frontend)
│   ├── index.html           # HTML template loaded by Vite
│   ├── public/              # Static assets served as-is (favicon.svg)
│   └── src/
│       ├── main.tsx         # React mount point + hash-route default
│       ├── App.tsx          # ~925-line dashboard: routing, queries, all radar UI
│       ├── index.css        # Global Tailwind + theme tokens
│       ├── pages/           # Routed pages (currently only not-found)
│       ├── components/ui/   # shadcn/Radix UI primitives (~50 files)
│       ├── hooks/           # Reusable React hooks (use-toast, use-mobile)
│       └── lib/             # Browser helpers (queryClient, cn utility)
├── server/                  # Express 5 API + dev/prod glue (Node ESM via tsx)
│   ├── index.ts             # HTTP bootstrap, middleware, gRPC worker boot
│   ├── routes.ts            # /api/radar*, /api/svs/health, /api/grpc/status, scoring
│   ├── svs.ts               # Solana Vibe Station REST client + health probes
│   ├── grpcStream.ts        # Yellowstone Geyser background subscriber
│   ├── storage.ts           # better-sqlite3 + Drizzle DAO
│   ├── static.ts            # Production static SPA serving
│   └── vite.ts              # Development Vite middleware integration
├── shared/                  # Cross-layer Drizzle table + Zod contract
│   └── schema.ts
├── script/                  # Build / tooling scripts
│   └── build.ts             # vite build + esbuild server bundle → dist/index.cjs
├── docs/                    # Human-authored project docs (architecture, runbook, etc.)
├── .planning/               # GSD planning artifacts (this folder lives here)
├── .env.example             # Template for required env vars (never read directly)
├── components.json          # shadcn/ui configuration
├── drizzle.config.ts        # SQLite migration config (./data.db)
├── package.json             # Scripts: dev, build, start, check, db:push
├── postcss.config.js        # Tailwind + autoprefixer pipeline
├── tailwind.config.ts       # Theme + content globs
├── tsconfig.json            # Strict TS, path aliases (@, @shared)
├── vite.config.ts           # Vite root=client, outDir=dist/public, aliases
├── README.md                # Project overview
├── data.db (gitignored)     # Runtime SQLite (radar_snapshots)
└── dist/ (gitignored)       # Build output (dist/public + dist/index.cjs)
```

## Directory Purposes

**`client/`:**
- Purpose: Browser-only code. Vite treats this directory as `root`.
- Contains: The React entry, the SPA dashboard, UI primitives, hooks, and global styles.
- Key files: `client/index.html`, `client/src/main.tsx`, `client/src/App.tsx`, `client/src/lib/queryClient.ts`.

**`client/src/components/ui/`:**
- Purpose: shadcn/ui-flavored Radix primitives wrapped with Tailwind variants.
- Contains: ~50 atomic UI files (`button.tsx`, `card.tsx`, `sheet.tsx`, `tabs.tsx`, …) consumed by `App.tsx` via the `@/components/ui/*` alias.
- Key files: `card.tsx`, `button.tsx`, `tabs.tsx`, `sheet.tsx`, `toaster.tsx`, `tooltip.tsx`, `progress.tsx`, `badge.tsx`, `skeleton.tsx`.

**`client/src/pages/`:**
- Purpose: Routed view modules.
- Contains: Currently only `not-found.tsx`. The main `RadarHome` view lives inside `App.tsx`.
- Key files: `not-found.tsx`.

**`client/src/hooks/`:**
- Purpose: Cross-cutting React hooks.
- Contains: `use-toast.ts` (toast queue), `use-mobile.tsx` (viewport breakpoint).
- Key files: `use-toast.ts`.

**`client/src/lib/`:**
- Purpose: Framework-adjacent helpers usable from any component.
- Contains: `queryClient.ts` (TanStack Query default fetcher + `apiRequest`), `utils.ts` (`cn` Tailwind class merger).
- Key files: `queryClient.ts`.

**`server/`:**
- Purpose: Backend application. Single Node process; nothing here imports from `client/`.
- Contains: HTTP bootstrap, route handlers + scoring, SVS REST integration, Yellowstone gRPC worker, SQLite DAO, prod/dev SPA hosting.
- Key files: `index.ts`, `routes.ts`, `svs.ts`, `grpcStream.ts`, `storage.ts`.

**`shared/`:**
- Purpose: One file: the Drizzle table + Zod schemas + inferred TS types reused on both sides.
- Contains: `schema.ts` (radar_snapshots table, `tokenSignalSchema`, `metaSignalSchema`, `radarSnapshotSchema`, `grpcSummarySchema`).
- Key files: `schema.ts`.

**`script/`:**
- Purpose: Standalone Node scripts used by package.json scripts.
- Contains: `build.ts` (production build orchestrator).
- Key files: `build.ts`.

**`docs/`:**
- Purpose: Hand-written project documentation distinct from `.planning/`.
- Contains: `ARCHITECTURE.md`, `PRODUCT.md`, `ROADMAP.md`, `RUNBOOK.md`.

**`.planning/codebase/`:**
- Purpose: Generated GSD codebase analysis (this directory).
- Contains: `ARCHITECTURE.md`, `STRUCTURE.md`.

## Key File Locations

**Entry Points:**
- `server/index.ts`: Node entry; `npm run dev` → `tsx server/index.ts`, `npm start` → `node dist/index.cjs`.
- `client/src/main.tsx`: Browser entry mounted by `client/index.html`.
- `script/build.ts`: Build entry; `npm run build`.
- `client/index.html`: HTML shell with `<script type="module" src="/src/main.tsx">`.

**Configuration:**
- `vite.config.ts`: Vite root=`client`, build outDir=`dist/public`, aliases `@`, `@shared`, `@assets`.
- `tsconfig.json`: Strict TS, `paths: { "@/*": ["./client/src/*"], "@shared/*": ["./shared/*"] }`, includes `client/src`, `shared`, `server`.
- `drizzle.config.ts`: dialect=sqlite, schema=`./shared/schema.ts`, db=`./data.db`, migrations to `./migrations`.
- `tailwind.config.ts`: Tailwind theme tokens.
- `postcss.config.js`: PostCSS pipeline.
- `components.json`: shadcn/ui CLI config.
- `package.json`: Scripts (`dev`, `build`, `start`, `check`, `db:push`) and full dependency list.
- `.env.example`: Template (never read directly — runtime uses `dotenv/config` to load `.env`).
- `.gitignore`: Excludes `node_modules/`, `dist/`, `.vite/`, all `.env*` (except `.env.example`), and the `data.db*` family.

**Core Logic:**
- `server/routes.ts`: Snapshot orchestration + scoring (`scorePair`, `buildGrpcOnlyToken`, `buildSnapshot`, `buildSnapshotWithDeadline`).
- `server/svs.ts`: SVS REST client and health probes.
- `server/grpcStream.ts`: Background Yellowstone Geyser worker + candidate cache.
- `server/storage.ts`: SQLite open + `radar_snapshots` DAO.
- `client/src/App.tsx`: All radar dashboard logic and components.
- `shared/schema.ts`: Cross-layer types.

**Testing:**
- Not detected. No test runner (Vitest/Jest/Playwright) is in `package.json`, no `*.test.*` files exist, and `tsconfig.json` explicitly excludes `**/*.test.ts`. Type-checking via `npm run check` (tsc) is the only automated check.

## Naming Conventions

**Files:**
- Server modules: lowerCamelCase TS files (`grpcStream.ts`, `routes.ts`, `storage.ts`).
- Client components: PascalCase for top-level component files (`App.tsx`), but the shadcn UI primitives use kebab-case (`alert-dialog.tsx`, `dropdown-menu.tsx`, `scroll-area.tsx`).
- Pages: kebab-case (`pages/not-found.tsx`).
- Hooks: kebab-case prefixed `use-` (`use-toast.ts`, `use-mobile.tsx`).
- Lib helpers: camelCase (`queryClient.ts`, `utils.ts`).
- Config: kebab-case at root (`drizzle.config.ts`, `tailwind.config.ts`, `postcss.config.js`).

**Directories:**
- Lowercase, single-word where possible: `client`, `server`, `shared`, `script`, `docs`.
- Plural for collections: `pages`, `hooks`, `components`.

**Imports:**
- `@/…` → `client/src/…` (browser only).
- `@shared/…` → `shared/…` (both layers).
- `@assets/…` → `attached_assets/…` (alias defined in `vite.config.ts`; directory not currently present).
- Server uses relative `./` imports plus `@shared/schema`.

## Where to Add New Code

**New page/route:**
- Primary code: `client/src/pages/<Name>.tsx`
- Wire it up: add a `<Route path="/x" component={X} />` inside `AppRouter` in `client/src/App.tsx:902` (Wouter + `useHashLocation`, so the URL becomes `#/x`).
- Tests: Not detected — no test directory exists. If introducing tests, colocate as `client/src/pages/<Name>.test.tsx` and add a runner.

**New API endpoint:**
- Implementation: extend `registerRoutes` in `server/routes.ts:855` with `app.get("/api/<name>", …)`.
- For long-running work, follow the existing pattern: build async helper, wrap in `withDeadline` (`server/routes.ts:87`), and return cached/empty fallback on timeout.
- Surface its DTO in `shared/schema.ts` so the client gets types via `@shared/schema`.

**New shared type/schema:**
- Location: `shared/schema.ts` — define a Zod schema and `export type X = z.infer<typeof xSchema>;` to keep wire/storage types unified.
- DB tables: add a `sqliteTable(...)` next to `radarSnapshots` and run `npm run db:push` against `./data.db`.

**New third-party integration:**
- Location: new module under `server/` (mirror `server/svs.ts` shape). Mark with the "backend-only — never import from client/*" comment if it touches secrets.
- Surface health into `getSvsHealthReport` (`server/svs.ts:362`) or add a sibling probe and merge in `/api/svs/health`.

**New UI primitive:**
- Location: `client/src/components/ui/<name>.tsx` following shadcn conventions (use `cn` from `@/lib/utils` and `class-variance-authority`).

**New radar score component:**
- Location: prefer extracting from `client/src/App.tsx` into `client/src/components/radar/<Name>.tsx` (directory does not exist yet — create it).

**Utilities:**
- Browser-only helpers: `client/src/lib/<name>.ts`.
- Server-only helpers: colocate with the calling module under `server/`. There is no `server/lib/` — keep functions adjacent to their consumer until reuse appears.
- Cross-layer pure helpers: place under `shared/` only if both client and server need them.

**New build/CLI script:**
- Location: `script/<name>.ts`, then add a `package.json` script that calls it via `tsx`.

## Special Directories

**`dist/`:**
- Purpose: Build output. `dist/public/` holds the Vite bundle, `dist/index.cjs` the esbuild-bundled server.
- Generated: Yes, by `npm run build` (`script/build.ts`).
- Committed: No (`.gitignore` line 2).

**`node_modules/`:**
- Purpose: npm-installed dependencies.
- Generated: Yes, by `npm install`.
- Committed: No (`.gitignore` line 1).

**`migrations/`:**
- Purpose: Configured as drizzle-kit output (`drizzle.config.ts`).
- Generated: Yes, by `drizzle-kit` when migrations are produced.
- Committed: Currently absent — runtime schema is bootstrapped inline in `server/storage.ts:9` rather than via migrations.

**`data.db` (and `.db-shm`, `.db-wal`, `.db-journal`):**
- Purpose: SQLite database holding `radar_snapshots`.
- Generated: Yes, on first server start (`server/storage.ts:7`).
- Committed: No — explicitly gitignored to avoid leaking demo data.

**`attached_assets/`:**
- Purpose: Aliased as `@assets` in `vite.config.ts`.
- Generated: No.
- Committed: Not present in the repo today; alias is reserved for future image/font drops.

**`.env`, `.env.local`, etc.:**
- Purpose: Runtime secrets (`SVS_API_KEY`, `SVS_GRPC_ENDPOINT`, `SVS_GRPC_X_TOKEN`, `SVS_RPC_HTTP_URL`, `SVS_RPC_WS_URL`, `SVS_API_BASE_URL`, `PORT`, `NODE_ENV`).
- Generated: Operator-supplied (template in `.env.example`).
- Committed: No — gitignored except `.env.example`.

**`.planning/`:**
- Purpose: GSD planning artifacts (specs, plans, codebase analysis).
- Generated: Yes (by GSD workflows like this one).
- Committed: Yes (the `.planning/` tree is tracked).

---

*Structure analysis: 2026-05-04*
