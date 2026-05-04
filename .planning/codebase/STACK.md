# Tech Stack

## Languages

- **Primary:** TypeScript 5.6.3 (`package.json:100`) — strict mode enabled (`tsconfig.json:9`).
- **Secondary:** JavaScript (ESM) for `postcss.config.js` only.
- **Markup/Styling:** HTML (`client/index.html`), CSS via Tailwind (`client/src/index.css`).

## Runtime

- **Node version expectation:** Node 20.x. Pinned via `@types/node@20.19.27` (`package.json:87`). No `engines` field in `package.json`.
- **Module system:** ESM (`"type": "module"` in `package.json:5`).
- **Package manager:** npm. `package-lock.json` is present (9710 lines). No `yarn.lock` or `pnpm-lock.yaml`.
- **Dev runner:** `tsx` 4.20.5 (`package.json:99`) executes `server/index.ts` directly — see `npm run dev` (`package.json:7`).

## Frameworks

### Core server
- **Express 5.0.1** (`package.json:56`, used in `server/index.ts:2`, `server/static.ts:1`, `server/routes.ts:1`).
- **Node built-in `http.createServer`** for the HTTP listener (`server/index.ts:6,10`).

### Core client
- **React 18.3.1** + **React DOM 18.3.1** (`package.json:65-67`).
- **Wouter 3.3.5** for routing, with `wouter/use-hash-location` (`client/src/App.tsx:2-3`).
- **TanStack React Query 5.60.5** for data fetching (`client/src/App.tsx:4`, `client/src/lib/queryClient.ts:1`).

### UI & styling
- **Tailwind CSS 3.4.17** (`package.json:98`, `tailwind.config.ts`) — dark mode `class`-based (`tailwind.config.ts:4`).
- **shadcn/ui — `new-york` style** (`components.json:3`), with `cssVariables: true` and base color `neutral` (`components.json:9-11`).
- **Radix UI primitives** — 28 packages under `@radix-ui/react-*` (`package.json:17-42`).
- **lucide-react 0.453.0** icons (`client/src/App.tsx:23-44`).
- **recharts 2.15.2** charts (`client/src/App.tsx:47`, `client/src/components/ui/chart.tsx:4`).
- **tailwindcss-animate 1.0.7** + **@tailwindcss/typography 0.5.15** plugins (`tailwind.config.ts:106`).
- **class-variance-authority 0.7.1**, **clsx 2.1.1**, **tailwind-merge 2.6.0** for class composition.

### Validation
- **Zod 3.24.2** (`shared/schema.ts:3`).
- **drizzle-zod 0.7.0** for schema → Zod (`shared/schema.ts:2`).
- **zod-validation-error 3.4.0** — listed in build allowlist only, no source imports detected.

### Testing
- Not detected. No test runner configured; no `*.test.*` files (excluded explicitly in `tsconfig.json:3`).

### Build / dev
- **Vite 7.3.0** (`package.json:101`, `vite.config.ts`) with **@vitejs/plugin-react 4.7.0** (`vite.config.ts:2`).
- **esbuild 0.25.0** bundles the server entry to `dist/index.cjs` via `script/build.ts:47-59`.
- **tsx 4.20.5** executes the build script and the dev server (`package.json:7-8`).
- **drizzle-kit 0.31.8** for SQLite schema push (`package.json:11`).

## Key Dependencies

### Critical (verified by source imports)
- `express` — HTTP server (`server/index.ts:2`).
- `better-sqlite3` 11.7.0 — SQLite driver (`server/storage.ts:4`).
- `drizzle-orm` 0.45.2 — ORM, `drizzle-orm/better-sqlite3` adapter and `drizzle-orm/sqlite-core` (`server/storage.ts:3,5`, `shared/schema.ts:1`).
- `@triton-one/yellowstone-grpc` 5.0.8 — Solana Geyser gRPC client, lazy-imported (`server/grpcStream.ts:433`).
- `bs58` 6.0.0 — Solana base58 mint encoding (`server/grpcStream.ts:9`).
- `dotenv` 16.4.7 — `.env` loader (`server/index.ts:1`).
- `react`, `react-dom`, `wouter`, `@tanstack/react-query` — frontend core.
- `nanoid` — used by `server/vite.ts:7` for HMR cache-busting. NOTE: `nanoid` is not declared in `package.json` and is resolved transitively.

### Infrastructure / UI (verified by source imports)
- All `@radix-ui/react-*` primitives are wired through `client/src/components/ui/*` shadcn wrappers.
- `recharts` (`client/src/components/ui/chart.tsx`, `client/src/App.tsx`).
- `cmdk` (`client/src/components/ui/command.tsx:3`).
- `vaul` (`client/src/components/ui/drawer.tsx:4`).
- `react-day-picker` (`client/src/components/ui/calendar.tsx:3`).
- `react-resizable-panels` (`client/src/components/ui/resizable.tsx:4`).
- `input-otp` (`client/src/components/ui/input-otp.tsx:2`).
- `react-hook-form` (`client/src/components/ui/form.tsx:6-7`).
- `embla-carousel-react`, `class-variance-authority`, `clsx`, `tailwind-merge`, `tailwindcss-animate`, `tw-animate-css` — used by shadcn UI files.

### Installed but unused (no source imports detected)
- `@supabase/supabase-js` 2.49.4 — no `from "@supabase` imports anywhere.
- `passport` 0.7.0, `passport-local` 1.0.0 — only referenced in `script/build.ts:23-24` allowlist.
- `express-session` 1.18.1, `memorystore` 1.6.7 — only in `script/build.ts:16,18` allowlist.
- `framer-motion` 11.13.1 — no imports.
- `next-themes` 0.4.6 — no imports.
- `@hookform/resolvers` 3.10.0 — no imports (only `react-hook-form` itself is used).
- `date-fns` 3.6.0 — no imports in app source (allowlisted in `script/build.ts:11`).
- `react-icons` 5.4.0 — no imports.
- `ws` 8.18.0 + `@types/ws` — no direct imports (Vite HMR uses its own ws internally).
- `zod-validation-error` 3.4.0 — no imports.
- `@jridgewell/trace-mapping` 0.3.25 — no direct imports.
- `bufferutil` (optional) — runtime perf dep for `ws`.

## Configuration

### TypeScript paths (`tsconfig.json:18-21`)
- `@/*` → `./client/src/*`
- `@shared/*` → `./shared/*`
- Module resolution: `bundler`; `allowImportingTsExtensions: true`; `noEmit: true`.
- Includes: `client/src/**/*`, `shared/**/*`, `server/**/*`.

### Vite aliases (`vite.config.ts:7-13`)
- `@` → `client/src`
- `@shared` → `shared`
- `@assets` → `attached_assets`
- `root` is `client/`; build outputs to `dist/public` (`vite.config.ts:14-19`); `base: "./"`.
- Dev server `fs.strict: true`, denies dotfiles (`vite.config.ts:20-25`).

### Tailwind highlights (`tailwind.config.ts`)
- `darkMode: ["class"]` (line 4).
- Content globs: `./client/index.html`, `./client/src/**/*.{js,jsx,ts,tsx}` (line 5).
- HSL CSS-variable color tokens with `<alpha-value>` syntax for `background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`, `chart.1-5`, `sidebar*`.
- Custom `borderRadius` overrides: `lg`, `md`, `sm` (lines 8-12).
- Status colors `online/away/busy/offline` (lines 78-83).
- Plugins: `tailwindcss-animate`, `@tailwindcss/typography` (line 106).

### Drizzle (`drizzle.config.ts`)
- Dialect: `sqlite`.
- Schema: `./shared/schema.ts`.
- Migrations dir: `./migrations`.
- DB URL: `./data.db` (single file).
- Single table: `radar_snapshots(id, captured_at, payload)` (`shared/schema.ts:5-9`).

### shadcn (`components.json`)
- Style: `new-york`; RSC: false; TSX: true.
- Tailwind config: `tailwind.config.ts`; CSS: `client/src/index.css`; base color: `neutral`.
- Aliases: `components → @/components`, `utils → @/lib/utils`, `ui → @/components/ui`, `lib → @/lib`, `hooks → @/hooks`.

### PostCSS (`postcss.config.js`)
- Plugins: `tailwindcss`, `autoprefixer`.

### Environment variables (read by source)
- `NODE_ENV`, `PORT` (`server/index.ts:110,121`).
- `SVS_API_BASE_URL`, `SVS_API_KEY`, `SVS_RPC_HTTP_URL`, `SVS_RPC_WS_URL`, `SVS_GRPC_ENDPOINT` (`server/svs.ts:49-53`, `server/svs.ts:260`).
- `SVS_GRPC_X_TOKEN` (`server/grpcStream.ts:546`).
- `ENABLE_GRPC_DEX_POOLS`, `ENABLE_RAYDIUM_AMM_V4` (`server/grpcStream.ts:91-92`).
- `WATCH_PUMPSWAP_PROGRAM`, `WATCH_RAYDIUM_LAUNCHLAB_PROGRAM`, `WATCH_PUMPFUN_PROGRAM`, `WATCH_RAYDIUM_CPMM_PROGRAM`, `WATCH_RAYDIUM_CLMM_PROGRAM`, `WATCH_RAYDIUM_AMM_V4_PROGRAM` (`server/grpcStream.ts:100,127`).

### Build pipeline (`script/build.ts`)
1. `rm -rf dist` (line 34).
2. `vite build` produces SPA into `dist/public` (line 37, per `vite.config.ts:17`).
3. `esbuild` bundles `server/index.ts` → `dist/index.cjs` as CJS, minified, with a curated `allowlist` of deps to inline; everything else stays external (lines 7-31, 47-59).
4. Production start: `node dist/index.cjs` (`package.json:9`).

## Platform Requirements

### Development
- Node 20.x (per `@types/node` pin).
- npm (uses `package-lock.json`).
- Local SQLite file `data.db` is auto-created on boot (`server/storage.ts:7-15`); ignored by git (`.gitignore:6-9`).
- Default dev port: 5000 (`server/index.ts:121`, `README.md:33`).
- Run: `npm install && cp .env.example .env && npm run dev`.

### Production
- Node 20.x runtime that can execute a CJS bundle.
- Target host: Railway (per `README.md:44-51`). Build command `npm install && npm run build`; start command `npm start`.
- Honors `PORT` env var; defaults to 5000; binds `0.0.0.0` with `reusePort: true` (`server/index.ts:121-127`).
- SQLite WAL files (`data.db-shm`, `data.db-wal`, `data.db-journal`) write next to the process; ephemeral on Railway containers (`.gitignore:7-9`).
- Native dependency: `better-sqlite3` requires a build toolchain at install time on the deploy target.
- Optional perf dependency: `bufferutil` (`package.json:103-105`).

*Stack analysis: 2026-05-04*
