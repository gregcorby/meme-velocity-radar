# Technology Stack

**Analysis Date:** 2026-05-04

## Languages

**Primary:**
- TypeScript 5.6.3 — all source code (`server/`, `client/src/`, `shared/`, `script/`)

**Secondary:**
- JavaScript (CommonJS) — `postcss.config.js` only
- HTML — `client/index.html` (SPA shell, not in repo root listing)
- CSS — `client/src/index.css` (Tailwind entrypoint)

## Runtime

**Environment:**
- Node.js (no `.nvmrc`; `@types/node` pinned to `20.19.27` → expects Node 20.x)
- Project uses ESM at source level (`"type": "module"` in `package.json`) but the production server bundle is **CommonJS** (`dist/index.cjs`).
- `tsx` 4.20.5 runs TypeScript directly in development (`server/index.ts`).

**Package Manager:**
- npm (lockfile present: `package-lock.json`, ~330 KB)
- No `pnpm-lock.yaml` / `yarn.lock`

## Frameworks

**Core (server):**
- Express 5.0.1 — HTTP server, middleware, routing (`server/index.ts`, `server/routes.ts`)
- `@triton-one/yellowstone-grpc` 5.0.8 — Solana Geyser gRPC client (`server/grpcStream.ts`)
- Drizzle ORM 0.45.2 + `better-sqlite3` 11.7.0 — typed SQLite access (`server/storage.ts`, `shared/schema.ts`)
- `dotenv` 16.4.7 — `.env` loading (`import "dotenv/config"` in `server/index.ts:1`)

**Core (client):**
- React 18.3.1 + ReactDOM 18.3.1 (`client/src/main.tsx`)
- Vite 7.3.0 — dev server + production client build (`vite.config.ts`)
- `@vitejs/plugin-react` 4.7.0 — React fast refresh
- `wouter` 3.3.5 with `useHashLocation` — hash-based SPA router (`client/src/App.tsx:2-3`)
- `@tanstack/react-query` 5.60.5 — server-state cache (`client/src/lib/queryClient.ts`)
- `react-hook-form` 7.55.0 + `@hookform/resolvers` 3.10.0 + `zod` 3.24.2 — form handling (installed; not currently used by app code)

**UI / styling:**
- Tailwind CSS 3.4.17 + `tailwindcss-animate` 1.0.7 + `@tailwindcss/typography` 0.5.15 (`tailwind.config.ts`)
- shadcn/ui (`components.json`, style: `new-york`, baseColor: `neutral`) — pre-generated into `client/src/components/ui/` (47 components: accordion, button, card, sheet, tabs, …)
- 25+ `@radix-ui/react-*` primitives (1.x / 2.x) — backbone of shadcn components
- `lucide-react` 0.453.0 — icon set
- `framer-motion` 11.13.1 — animations (installed; minimal usage)
- `class-variance-authority` 0.7.1 + `clsx` 2.1.1 + `tailwind-merge` 2.6.0 — class composition (`client/src/lib/utils.ts` exports `cn(...)`)

**Validation / schema:**
- `zod` 3.24.2 — runtime schemas for the radar payload (`shared/schema.ts`)
- `drizzle-zod` 0.7.0 — `createInsertSchema` for DB rows
- `zod-validation-error` 3.4.0 (installed)

**Testing:**
- Not detected. No `jest`, `vitest`, `mocha`, `playwright`, `cypress`, `@testing-library/*` in dependencies. `tsconfig.json` excludes `**/*.test.ts` (placeholder), but no test files exist in the repo.

**Build / Dev:**
- `tsx` 4.20.5 — runs `server/index.ts` in dev (`npm run dev`)
- `vite` 7.3.0 — bundles the client SPA
- `esbuild` 0.25.0 — bundles the server into a single minified CJS file (`script/build.ts`)
- `drizzle-kit` 0.31.8 — `npm run db:push` → schema sync against `data.db`
- `tsc` (5.6.3) — type-check only via `npm run check` (`noEmit: true`)
- `postcss` 8.4.47 + `autoprefixer` 10.4.20 — Tailwind pipeline (`postcss.config.js`)

## Key Dependencies

**Critical:**
- `@triton-one/yellowstone-grpc` 5.0.8 — entire live-stream path (`server/grpcStream.ts`); without it, the radar runs DexScreener-only
- `bs58` 6.0.0 — base58 encoding/decoding for Solana mint/signature bytes (`server/grpcStream.ts:9`)
- `better-sqlite3` 11.7.0 — synchronous SQLite for snapshot persistence and stale-fallback (`server/storage.ts:3-7`)
- `drizzle-orm` 0.45.2 — typed query builder used through `db.insert(...).values(...).returning().get()` (`server/storage.ts:25-30`)
- `express` 5.0.1 — HTTP, middleware, error handling
- `ws` 8.18.0 — WebSocket primitives (used transitively by Yellowstone gRPC client deps)

**Infrastructure:**
- `@supabase/supabase-js` 2.49.4 — installed, **not imported** anywhere in `server/` or `client/`. Likely scaffold residue.
- `passport` 0.7.0 + `passport-local` 1.0.0 + `express-session` 1.18.1 + `memorystore` 1.6.7 — auth scaffolding **installed but unused** (no routes import them)
- `bufferutil` 4.0.8 — optional native dep for `ws` performance

**Optional / installed-but-unused (verify before pruning):**
- `recharts` 2.15.2, `embla-carousel-react` 8.6.0, `react-day-picker` 8.10.1, `vaul` 1.1.2, `cmdk` 1.1.1, `input-otp` 1.4.2, `react-resizable-panels` 2.1.7, `react-icons` 5.4.0, `next-themes` 0.4.6, `tw-animate-css` 1.2.5, `@tailwindcss/vite` 4.1.18 — pulled in by shadcn/ui scaffolds; not all are referenced from `App.tsx`.

## Configuration

**TypeScript (`tsconfig.json`):**
- `strict: true`, `module: "ESNext"`, `moduleResolution: "bundler"`, `jsx: "preserve"`, `noEmit: true`, `allowImportingTsExtensions: true`
- Path aliases: `@/* → client/src/*`, `@shared/* → shared/*`
- Includes: `client/src/**/*`, `shared/**/*`, `server/**/*`
- Excludes: `node_modules`, `build`, `dist`, `**/*.test.ts`

**Vite (`vite.config.ts`):**
- `root: "client"`, `base: "./"`, output `dist/public`
- Aliases: `@ → client/src`, `@shared → shared`, `@assets → attached_assets` (no such directory exists yet)
- Server middleware mode is configured at runtime in `server/vite.ts` (HMR over `/vite-hmr`)

**Tailwind (`tailwind.config.ts`):**
- `darkMode: ["class"]`, content scan: `client/index.html` + `client/src/**/*.{js,jsx,ts,tsx}`
- HSL CSS-variable color tokens (background/foreground/card/popover/primary/…) plus a `status` palette and 5-slot `chart` palette
- Plugins: `tailwindcss-animate`, `@tailwindcss/typography`

**Drizzle (`drizzle.config.ts`):**
- `dialect: "sqlite"`, schema `./shared/schema.ts`, output `./migrations`, db `./data.db`

**shadcn/ui (`components.json`):**
- style `new-york`, `tsx: true`, `rsc: false`, `tailwind.cssVariables: true`, prefix empty
- aliases mirror the Vite/TS path aliases

**PostCSS (`postcss.config.js`):**
- Plugins: `tailwindcss`, `autoprefixer`

**Environment (`.env.example`):**
- Loaded by `dotenv/config` at server startup (`server/index.ts:1`)
- All keys are server-only — **no `VITE_`-prefixed vars** (intentional: prevents leaking secrets to the browser)
- Key vars: `SVS_API_BASE_URL`, `SVS_API_KEY`, `SVS_RPC_HTTP_URL`, `SVS_RPC_WS_URL`, `SVS_GRPC_ENDPOINT`, `SVS_GRPC_X_TOKEN`, `ENABLE_GRPC_DEX_POOLS`, `ENABLE_RAYDIUM_AMM_V4`, `WATCH_*_PROGRAM`, `PORT`, `NODE_ENV`
- `.env` files are gitignored (`.gitignore`)

**Build (`script/build.ts`):**
- Cleans `dist/`, runs `vite build`, then `esbuild` of `server/index.ts` → `dist/index.cjs` (CJS, minified, `process.env.NODE_ENV` defined to `"production"`)
- Has a hard-coded `allowlist` of deps to bundle into the CJS output (express, ws, drizzle-orm, drizzle-zod, zod, zod-validation-error, memorystore, passport, …). **The list contains entries not present in `package.json`** (`axios`, `cors`, `openai`, `stripe`, `multer`, `nodemailer`, `xlsx`, `jsonwebtoken`, `uuid`, `@google/generative-ai`, `nanoid`, `express-rate-limit`) — see `CONCERNS.md`.
- Everything else is marked external and resolved at runtime from `node_modules/`.

## Platform Requirements

**Development:**
- Node.js 20.x
- npm (project assumes the bundled npm; no engines field)
- Free local port `5000` (default; overridable via `PORT`)
- Optional: SVS API key, SVS Geyser gRPC endpoint + token. Without any SVS keys the radar runs entirely on the DexScreener public feed.

**Production:**
- Railway (documented target in `README.md` and `docs/RUNBOOK.md`); any Node host that can run `npm run build && npm start` and persist a single SQLite file in the cwd will work.
- The host **must** set `PORT` (Express binds to `0.0.0.0:$PORT`, default `5000` — see `server/index.ts:121-127`).
- `dist/` is gitignored; CI/host must build from source.
- Persistent local filesystem for `data.db` (and its `-wal`/`-shm` siblings) — the radar's stale-snapshot fallback relies on it.

---

*Stack analysis: 2026-05-04*
