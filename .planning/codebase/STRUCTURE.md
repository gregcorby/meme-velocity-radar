# Codebase Structure

**Analysis Date:** 2026-05-05

## Directory Layout

```
meme-velocity-radar/
├── client/                  # Vite/React SPA (browser only)
│   ├── public/              # Static assets (favicon, etc.)
│   └── src/
│       ├── App.tsx          # Entire application UI (monolithic)
│       ├── index.css        # Tailwind base + custom CSS variables
│       ├── main.tsx         # React DOM entry point
│       ├── components/
│       │   └── ui/          # Radix UI shadcn/ui component wrappers (40+ files)
│       ├── hooks/
│       │   ├── use-mobile.tsx
│       │   └── use-toast.ts
│       ├── lib/
│       │   ├── queryClient.ts  # TanStack Query client config + apiRequest helper
│       │   └── utils.ts        # Tailwind className merge utility (cn)
│       └── pages/
│           └── not-found.tsx   # 404 page
├── server/                  # Node.js Express backend (server only)
│   ├── index.ts             # Server entrypoint: boot, middleware, gRPC start
│   ├── routes.ts            # Radar snapshot builder, scoring, all HTTP routes
│   ├── svs.ts               # Solana Vibe Station API/RPC integration
│   ├── grpcStream.ts        # Yellowstone gRPC live stream worker
│   ├── storage.ts           # SQLite persistence (Drizzle ORM)
│   ├── static.ts            # Production static file serving
│   └── vite.ts              # Vite dev-mode middleware setup
├── shared/                  # Code shared between server and client
│   └── schema.ts            # Zod schemas + TypeScript types (RadarSnapshot, TokenSignal, etc.)
├── script/
│   └── build.ts             # Build script: Vite client + esbuild server bundle
├── docs/                    # Human-authored documentation
│   ├── ARCHITECTURE.md      # System design reference
│   ├── PRODUCT.md           # Product spec
│   ├── ROADMAP.md           # Development roadmap
│   └── RUNBOOK.md           # Operational runbook
├── .planning/               # GSD planning artifacts (AI tooling)
│   └── codebase/            # Codebase map documents
├── vite.config.ts           # Vite build config (path aliases, root, outDir)
├── tsconfig.json            # TypeScript config (includes client + server + shared)
├── drizzle.config.ts        # Drizzle Kit config (SQLite, shared/schema.ts)
├── package.json             # Monorepo package (single package.json for all code)
├── tailwind.config.ts       # Tailwind CSS config
├── postcss.config.js        # PostCSS config
├── components.json          # shadcn/ui component registry config
├── .env.example             # Environment variable template (note existence only)
└── .gitignore
```

## Directory Purposes

**`server/`:**
- Purpose: All backend Node.js code — HTTP server, data ingestion, scoring, persistence
- Contains: Express app setup, API route handlers, external API clients, SQLite adapter
- Key files: `server/index.ts` (boot), `server/routes.ts` (all business logic + routes), `server/grpcStream.ts` (gRPC worker), `server/svs.ts` (SVS integration), `server/storage.ts` (DB)
- Boundary: Never import from `client/src/`. May import from `shared/`.

**`client/src/`:**
- Purpose: Browser-only React SPA — radar dashboard UI
- Contains: React components, hooks, utility functions, Tailwind CSS
- Key files: `client/src/App.tsx` (all UI), `client/src/main.tsx` (React entry), `client/src/lib/queryClient.ts` (API client)
- Boundary: Never import from `server/`. May import from `shared/` via `@shared` alias.

**`client/src/components/ui/`:**
- Purpose: Shadcn/ui component library wrappers — Radix UI primitives styled with Tailwind
- Contains: 40+ component files (button, card, badge, sheet, tabs, toast, tooltip, etc.)
- Generated: Components were installed via shadcn/ui CLI but are committed and editable
- Do not add application-level components here; use this only for base UI primitives

**`client/src/hooks/`:**
- Purpose: Reusable React hooks
- Contains: `use-mobile.tsx` (responsive breakpoint hook), `use-toast.ts` (toast notification hook)

**`client/src/lib/`:**
- Purpose: Utility modules and client configuration
- Contains: `queryClient.ts` (TanStack Query setup), `utils.ts` (`cn` Tailwind class merge helper)

**`client/src/pages/`:**
- Purpose: Top-level routed page components
- Contains: `not-found.tsx` (404 page)
- Note: The main radar page lives in `client/src/App.tsx` as `RadarHome`, not in `pages/`

**`shared/`:**
- Purpose: TypeScript types and Zod schemas that are used by both server and client
- Contains: `schema.ts` — Drizzle table definition + all Zod schemas + exported TypeScript types
- Critical constraint: No server-only imports (no `express`, `fs`, env vars), no client-only imports (no React). Must be pure TypeScript data definitions.

**`script/`:**
- Purpose: Build tooling scripts run via `npm run build`
- Contains: `build.ts` — orchestrates Vite (client) then esbuild (server) compilation

**`docs/`:**
- Purpose: Human-authored project documentation for product/ops reference
- Contains: Architecture overview, product spec, roadmap, operational runbook
- Generated: No — maintained by humans. Not consumed by build tooling.

## Key File Locations

**Entry Points:**
- `server/index.ts`: Node.js server startup — first file executed in production
- `client/src/main.tsx`: React SPA entry — mounts to `#root` in `client/index.html`
- `script/build.ts`: Build entry — run via `npm run build`

**Configuration:**
- `vite.config.ts`: Client build config, path aliases (`@` → `client/src/`, `@shared` → `shared/`)
- `tsconfig.json`: TypeScript config covering all three zones (client, server, shared)
- `drizzle.config.ts`: Drizzle Kit pointing to `./shared/schema.ts` and `./data.db`
- `components.json`: Shadcn/ui component registry metadata
- `tailwind.config.ts`: Tailwind theme customization
- `.env.example`: All supported environment variables with documentation (read this for env setup)

**Core Logic:**
- `server/routes.ts`: Snapshot builder, scoring algorithms, all API routes (~940 lines)
- `server/grpcStream.ts`: gRPC worker, CandidateStore, transaction parsing (~600 lines)
- `server/svs.ts`: SVS API/RPC integration, health reporting (~380 lines)
- `shared/schema.ts`: All shared types — start here to understand data shapes

**Data Persistence:**
- `server/storage.ts`: `DatabaseStorage` class, Drizzle ORM, SQLite init
- `data.db`: SQLite database file (runtime, not committed) — created automatically on first run

**Client UI:**
- `client/src/App.tsx`: All UI components and state (~800 lines, monolithic)
- `client/src/lib/queryClient.ts`: `apiRequest` helper and TanStack Query config
- `client/src/index.css`: CSS custom properties (HSL tokens for theming), Tailwind directives

## Naming Conventions

**Files:**
- Server modules: `camelCase.ts` (e.g., `grpcStream.ts`, `queryClient.ts`)
- Shared schema: `schema.ts` (single file)
- UI components: `kebab-case.tsx` in `components/ui/` (e.g., `hover-card.tsx`, `scroll-area.tsx`)
- Hooks: `use-kebab-case.tsx` / `use-kebab-case.ts` (e.g., `use-mobile.tsx`, `use-toast.ts`)

**TypeScript Exports:**
- Types: PascalCase (e.g., `TokenSignal`, `RadarSnapshot`, `GrpcCandidate`)
- Zod schemas: camelCase with `Schema` suffix (e.g., `tokenSignalSchema`, `radarSnapshotSchema`)
- Functions: camelCase (e.g., `buildSnapshot`, `scorePair`, `fetchSvsMetadata`)
- Classes: PascalCase (e.g., `DatabaseStorage`, `CandidateStore`)
- Interfaces: PascalCase with `I` prefix for abstractions (e.g., `IStorage`)

**React Components:**
- PascalCase functions in `client/src/App.tsx` (e.g., `TokenCard`, `DetailPanel`, `RadarHome`)
- Props types defined inline as anonymous objects or named PascalCase types in the same file

**Environment Variables:**
- `SVS_*` prefix: Solana Vibe Station credentials and endpoints
- `WATCH_*_PROGRAM`: gRPC program ID overrides
- `ENABLE_*`: Feature flag toggles (e.g., `ENABLE_GRPC_DEX_POOLS`, `ENABLE_RAYDIUM_AMM_V4`)
- `PORT`: HTTP listen port (default 5000)

## Where to Add New Code

**New API endpoint:**
- Add route handler in `server/routes.ts` inside `registerRoutes()`
- Define request/response types in `shared/schema.ts` if the client needs to consume them
- Keep handler thin — extract business logic into a helper function or new module

**New external API integration:**
- Create `server/<service>.ts` following the pattern in `server/svs.ts`:
  - Export config getter, typed result types, and `fetch*` functions returning `{ ok: true; data } | { ok: false; error }`
  - Import and call from `server/routes.ts`
  - Add health check function if the service needs monitoring

**New UI component (application-level):**
- Currently: Add component function to `client/src/App.tsx` (existing pattern)
- Better: Create `client/src/components/<ComponentName>.tsx` and import into `App.tsx`

**New base UI primitive:**
- Add to `client/src/components/ui/<component-name>.tsx`
- Follow shadcn/ui patterns: export named component, use Radix UI primitive, style with `cn()`

**New shared type:**
- Add Zod schema and type export to `shared/schema.ts`
- Use `z.infer<typeof yourSchema>` for the TypeScript type export

**New React hook:**
- Create `client/src/hooks/use-<name>.tsx` or `.ts`
- Export the hook function as the default export or named export

**New utility function:**
- Server-only: add to the relevant `server/*.ts` module or create `server/utils.ts`
- Client-only: add to `client/src/lib/utils.ts` or a new `client/src/lib/<name>.ts`
- Both: add to `shared/schema.ts` only if it's a pure data/type utility with no platform dependencies

**New environment variable:**
- Document in `.env.example` with a comment explaining the variable
- Read in the server module that needs it (`process.env.YOUR_VAR`)
- Never prefix with `VITE_` — no env vars should be exposed to the browser

## Special Directories

**`dist/`:**
- Purpose: Build output — `dist/index.cjs` (server bundle), `dist/public/` (client assets)
- Generated: Yes — created by `npm run build`
- Committed: No

**`migrations/`:**
- Purpose: Drizzle Kit SQL migration files
- Generated: Yes — created by `npx drizzle-kit generate`
- Committed: Yes (if generated)

**`.planning/`:**
- Purpose: GSD AI tooling artifacts — codebase maps, phase plans
- Generated: Yes — created by `/gsd-map-codebase` and `/gsd-plan-phase`
- Committed: Yes (planning artifacts travel with the repo)

**`node_modules/`:**
- Generated: Yes — `npm install`
- Committed: No

**`data.db`:**
- Purpose: SQLite database file (runtime state — radar snapshots for stale fallback)
- Generated: Yes — created automatically at server startup by `server/storage.ts`
- Committed: No (in `.gitignore`)

---

*Structure analysis: 2026-05-05*
