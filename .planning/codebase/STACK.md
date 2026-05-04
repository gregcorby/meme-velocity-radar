# Technology Stack

**Analysis Date:** 2026-05-04

## Languages

**Primary:**
- TypeScript 5.6.3 — used for both backend (`server/*.ts`), frontend (`client/src/**/*.tsx`), shared types (`shared/schema.ts`), and build script (`script/build.ts`). Strict mode is on (`tsconfig.json` line 9). Module resolution is `bundler`, JSX is `preserve` (Vite handles transform).

**Secondary:**
- TSX 4.20.5 (`tsx`) — direct TypeScript execution for `npm run dev` (`tsx server/index.ts`) and the build script. No emit step in dev.
- HTML/CSS — `client/index.html` is the SPA entry; `client/src/index.css` is the Tailwind entry imported from `client/src/main.tsx`.

## Runtime

**Environment:**
- Node.js (TypeScript types pinned at `@types/node` 20.19.27, so target is Node 20.x). Production starts via `node dist/index.cjs` (`package.json` line 9 — `npm start`).
- Single-process architecture: one Node/Express process serves both the JSON API and the Vite/React SPA (`server/index.ts`). The HTTP server is created with `node:http` and Express is mounted on it so the same listener can host SSE + future WS.

**Package Manager:**
- npm (lockfile is `package-lock.json` at repo root, ~339KB).
- Lockfile: present (`package-lock.json`).
- Node engine version is not pinned in `package.json` — runtime expectation is Node 20.x based on `@types/node`.

## Frameworks

**Core:**
- Express 5.0.1 — HTTP server framework. Routes are registered in `server/routes.ts` via `registerRoutes(httpServer, app)`. JSON body parsing with raw body capture is configured in `server/index.ts` lines 18-26.
- React 18.3.1 + ReactDOM 18.3.1 — SPA rendered via `createRoot` in `client/src/main.tsx`.
- wouter 3.3.5 — minimal client routing. Uses `useHashLocation` hook so the SPA works under hash-based routing (`client/src/App.tsx` line 3, line 916). `main.tsx` forces `window.location.hash = "#/"` on first load.
- @tanstack/react-query 5.60.5 — data fetching for `/api/radar`, `/api/svs/health`, `/api/grpc/status`. `QueryClient` defined in `client/src/lib/queryClient.ts`.

**Testing:**
- None detected. There is no test runner (no jest/vitest/mocha/playwright in dependencies), no `*.test.ts` files, and `tsconfig.json` line 3 explicitly excludes `**/*.test.ts`.

**Build/Dev:**
- Vite 7.3.0 — bundles the client (`vite.config.ts`). Dev server runs in middleware mode mounted onto Express (`server/vite.ts`). Build outputs static assets to `dist/public` (`vite.config.ts` line 17).
- @vitejs/plugin-react 4.7.0 — React Fast Refresh / JSX transform.
- esbuild 0.25.0 — bundles the server (`script/build.ts`) into a single CJS file at `dist/index.cjs`. The build allowlist (lines 7-31) inlines a small set of deps; everything else stays external. Notably, the allowlist references packages not actually in `package.json` (e.g. `openai`, `stripe`, `axios`, `@google/generative-ai`) — that is harmless because `externals` simply filters them out.
- Tailwind CSS 3.4.17 (`tailwind.config.ts`) + PostCSS 8.4.47 + autoprefixer 10.4.20 (`postcss.config.js`). Dark mode = class-based.
- @tailwindcss/typography 0.5.15 + tailwindcss-animate 1.0.7 + tw-animate-css 1.2.5 — Tailwind plugins.
- shadcn/ui — UI scaffolding configured via `components.json` (style: "new-york", baseColor: neutral, CSS variables enabled). 47 generated components in `client/src/components/ui/`.

## Key Dependencies

**Critical:**
- @triton-one/yellowstone-grpc 5.0.8 — Solana Geyser gRPC client. Loaded via dynamic import in `server/grpcStream.ts` line 433. Powers the live transaction stream over `SVS_GRPC_ENDPOINT`.
- bs58 6.0.0 — Base58 encoding for Solana account/signature byte arrays in `server/grpcStream.ts`.
- drizzle-orm 0.45.2 + drizzle-zod 0.7.0 — ORM + Zod schema generation. Schema in `shared/schema.ts`. Storage layer in `server/storage.ts` uses `drizzle-orm/better-sqlite3`.
- better-sqlite3 11.7.0 — synchronous SQLite driver. Database file is `./data.db` (`server/storage.ts` line 7), opened in WAL mode.
- zod 3.24.2 + zod-validation-error 3.4.0 — runtime validation for shared types (`shared/schema.ts`).
- ws 8.18.0 — WebSocket library (transitive use; project also lists `bufferutil` as optional dep for ws performance).
- recharts 2.15.2 — area charts in the radar detail panel (`client/src/App.tsx`).
- framer-motion 11.13.1 — animation primitives.
- lucide-react 0.453.0 + react-icons 5.4.0 — icon libraries.
- react-hook-form 7.55.0 + @hookform/resolvers 3.10.0 — form handling (used by shadcn `form.tsx` only — no live forms in current pages).

**Infrastructure:**
- @radix-ui/react-* (28 packages, all v1.x/v2.x) — accessibility primitives that back the shadcn/ui components in `client/src/components/ui/`.
- class-variance-authority 0.7.1 + clsx 2.1.1 + tailwind-merge 2.6.0 — class composition utilities used by shadcn components and `client/src/lib/utils.ts`.
- cmdk 1.1.1, vaul 1.1.2, embla-carousel-react 8.6.0, react-day-picker 8.10.1, input-otp 1.4.2, react-resizable-panels 2.1.7, next-themes 0.4.6 — additional UI building blocks behind shadcn wrappers.
- date-fns 3.6.0 — time formatting helpers.
- dotenv 16.4.7 — loads `.env` in `server/index.ts` line 1 (`import "dotenv/config"`).
- nanoid — used by `server/vite.ts` line 7 for cache-busting `main.tsx` query param in HMR.

**Listed but unused in source (as of 2026-05-04):**
- @supabase/supabase-js 2.49.4 — declared but no `import` of it anywhere in `server/`, `client/src/`, or `shared/`. Likely vestigial.
- express-session 1.18.1, passport 0.7.0, passport-local 1.0.0, memorystore 1.6.7 — declared but no auth/session code is mounted. The app currently has no login flow.

## Configuration

**Environment:**
- Configured via process env, loaded by `dotenv/config` at server boot (`server/index.ts` line 1). `.env` is gitignored (`.gitignore` lines 11-13); `.env.example` ships in the repo as the template.
- Frontend reads NO env vars directly. Anything secret stays on the backend (`README.md` line 158: "Do not prefix secrets with `VITE_`"). The client only consumes `/api/svs/health` and `/api/grpc/status` for status badges.
- Key configs required (names only, see `.env.example`): `NODE_ENV`, `SVS_API_BASE_URL`, `SVS_API_KEY`, `SVS_RPC_HTTP_URL`, `SVS_RPC_WS_URL`, `SVS_GRPC_ENDPOINT`, `SVS_GRPC_X_TOKEN`, `ENABLE_GRPC_DEX_POOLS`, `ENABLE_RAYDIUM_AMM_V4`, `WATCH_PUMPSWAP_PROGRAM`, `WATCH_RAYDIUM_LAUNCHLAB_PROGRAM`, `WATCH_RAYDIUM_CPMM_PROGRAM`, `WATCH_RAYDIUM_AMM_V4_PROGRAM`, `WATCH_RAYDIUM_CLMM_PROGRAM`, `WATCH_PUMPFUN_PROGRAM`, `SVS_STAKED_RPC_URL` (phase 2), `SVS_LIGHTSPEED_URL` (phase 2), and `PORT` (defaulted to 5000 in `server/index.ts` line 121).

**Build:**
- `package.json` scripts: `dev`, `build`, `start`, `check`, `db:push`.
- `vite.config.ts` — client root is `client/`, output is `dist/public/`, base is `./` (relative paths so the SPA works under any mount). Aliases: `@` → `client/src`, `@shared` → `shared`, `@assets` → `attached_assets`.
- `tsconfig.json` — same path aliases for editor/IDE; `noEmit: true` (TS used for type-check only).
- `script/build.ts` — orchestrates `vite build` then `esbuild` server bundle to `dist/index.cjs`.
- `drizzle.config.ts` — dialect `sqlite`, schema `./shared/schema.ts`, migrations out to `./migrations`, db URL `./data.db`. Driven via `npm run db:push`.
- `tailwind.config.ts` — content globs: `client/index.html`, `client/src/**/*.{js,jsx,ts,tsx}`. CSS variable color system; chart palette via `--chart-1..5`.
- `components.json` — shadcn config (style "new-york", neutral base color, no RSC).

## Platform Requirements

**Development:**
- Node.js 20.x and npm.
- `npm install && npm run dev` starts the dev server on port 5000 with Vite HMR mounted as Express middleware (path `/vite-hmr`).
- `data.db` (SQLite) is created on first boot in CWD; WAL files (`data.db-shm`, `data.db-wal`, `data.db-journal`) are gitignored.
- The app runs without any SVS keys — it falls back to the public DexScreener feed (`README.md` line 33).

**Production:**
- Designed for Railway (`README.md` lines 44-86). Build = `npm install && npm run build`, start = `npm start`, port from `PORT` env (defaults to 5000), host = `0.0.0.0`, `reusePort: true` for Railway's load balancer (`server/index.ts` lines 121-127).
- Production process is the bundled `dist/index.cjs` running under `node` (CJS, minified, externals not bundled — see `script/build.ts` allowlist).
- Static client assets are served from `dist/public` (resolved relative to `__dirname` in `server/static.ts`) when `NODE_ENV=production`. SPA fall-through serves `index.html` for any unknown route.
- Memory profile is intentionally small: gRPC stream toggles (`ENABLE_GRPC_DEX_POOLS`, `ENABLE_RAYDIUM_AMM_V4`) keep AMM v4 firehose off by default to avoid OOM on small Railway containers.

---

*Stack analysis: 2026-05-04*
