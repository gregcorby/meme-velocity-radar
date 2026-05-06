# Technology Stack

**Analysis Date:** 2026-05-05

## Languages

**Primary:**
- TypeScript 5.6.3 - Full stack (client, server, shared schema, build scripts)

**Secondary:**
- CSS (Tailwind utility classes) - Styling via `client/src/index.css`

## Runtime

**Environment:**
- Node.js v25.4.0 (active on dev machine; no `.nvmrc` pinning)
- ESM-first: `"type": "module"` in `package.json`

**Package Manager:**
- npm
- Lockfile: `package-lock.json` present

## Frameworks

**Backend:**
- Express 5.0.1 - HTTP server, REST API, SSE stream (`server/index.ts`, `server/routes.ts`)

**Frontend:**
- React 18.3.1 - SPA UI (`client/src/App.tsx`)
- Vite 7.3.0 - Dev server and client bundler (`vite.config.ts`)
- wouter 3.3.5 - Hash-based client-side router (`client/src/App.tsx` — uses `useHashLocation`)
- TanStack React Query 5.60.5 - Server state and polling (`client/src/lib/queryClient.ts`)
- Tailwind CSS 3.4.17 - Utility-first styling (`tailwind.config.ts`)
- shadcn/ui (new-york style) - Radix UI primitives + CVA (`components.json`, `client/src/components/ui/`)
- Recharts 2.15.2 - AreaChart for volume pace visualization (`client/src/App.tsx`)
- Framer Motion 11.13.1 - Animation utilities
- lucide-react 0.453.0 - Icon set

**ORM / Database:**
- Drizzle ORM 0.45.2 + drizzle-zod 0.7.0 - Type-safe query builder (`server/storage.ts`)
- Drizzle Kit 0.31.8 - Schema migrations (`drizzle.config.ts`)

**Validation:**
- Zod 3.24.2 - Runtime schema validation for API types (`shared/schema.ts`)
- zod-validation-error 3.4.0 - Human-readable error messages

**Testing:**
- Not detected — no test runner config, no `*.test.*` or `*.spec.*` files found

**Build/Dev:**
- tsx 4.20.5 - Dev-time TypeScript execution (`npm run dev`)
- esbuild 0.25.0 - Server bundle build (`script/build.ts` → `dist/index.cjs`)
- Vite (client bundle) - Outputs to `dist/public/`
- PostCSS + Autoprefixer - CSS processing (`postcss.config.js`)

## Key Dependencies

**Critical:**
- `@triton-one/yellowstone-grpc` 5.0.8 - Solana Geyser gRPC live transaction stream (`server/grpcStream.ts`)
- `better-sqlite3` 11.7.0 - Local SQLite DB for snapshot persistence (`server/storage.ts`)
- `bs58` 6.0.0 - Base58 encoding/decoding for Solana public keys (`server/grpcStream.ts`)
- `drizzle-orm` + `better-sqlite3` - Storage layer for radar snapshots

**Infrastructure:**
- `dotenv` 16.4.7 - Loads `.env` at server startup (`import "dotenv/config"` in `server/index.ts`)
- `ws` 8.18.0 - WebSocket support (used transitively by gRPC)
- `express-session` 1.18.1 + `memorystore` 1.6.7 - Session/store (included but not actively used in routes)
- `passport` 0.7.0 + `passport-local` 1.0.0 - Auth framework (included but routes do not yet expose auth endpoints)
- `react-hook-form` 7.55.0 + `@hookform/resolvers` 3.10.0 - Form handling
- `@supabase/supabase-js` 2.49.4 - Supabase client (imported as dependency but not used in current server code)
- `date-fns` 3.6.0 - Date utilities

**UI Primitives:**
- Full Radix UI suite (`@radix-ui/react-*` at various ^1.x–^2.x versions) — accordion, dialog, dropdown, tabs, toast, tooltip, etc.

## Configuration

**Environment:**
- Configured via `.env` (gitignored); `.env.example` documents all required vars
- Key env vars (names only, not values):
  - `SVS_API_KEY` — Solana Vibe Station REST API auth token
  - `SVS_API_BASE_URL` — Defaults to `https://free.api.solanavibestation.com`
  - `SVS_RPC_HTTP_URL` — Solana RPC HTTP endpoint
  - `SVS_RPC_WS_URL` — Solana RPC WebSocket endpoint
  - `SVS_GRPC_ENDPOINT` — Yellowstone Geyser gRPC endpoint URL
  - `SVS_GRPC_X_TOKEN` — Geyser gRPC auth token
  - `PORT` — HTTP listen port, defaults to 5000
  - `ENABLE_GRPC_DEX_POOLS` — Toggle DEX pool gRPC filters (default `true`)
  - `ENABLE_RAYDIUM_AMM_V4` — Opt-in for high-volume Raydium AMM v4 filter (default `false`)
  - `WATCH_PUMPSWAP_PROGRAM`, `WATCH_RAYDIUM_LAUNCHLAB_PROGRAM`, etc. — Program ID overrides

**TypeScript:**
- Strict mode enabled, `moduleResolution: bundler`, path aliases `@/*` → `client/src/*`, `@shared/*` → `shared/*`
- Config: `tsconfig.json`

**Build:**
- `vite.config.ts` - Client build (outputs `dist/public/`)
- `script/build.ts` - Two-stage: Vite client build + esbuild server bundle to `dist/index.cjs`
- `drizzle.config.ts` - ORM migration config targeting `./data.db` (SQLite)
- `tailwind.config.ts` - Dark mode via class, CSS variables for design tokens
- `postcss.config.js` - PostCSS with Autoprefixer
- `components.json` - shadcn/ui config (new-york style, neutral base color)

## Platform Requirements

**Development:**
- Node.js (v25.4.0 on dev machine; no version file to enforce)
- `.env` with at minimum `SVS_GRPC_ENDPOINT` for live gRPC ingestion; app degrades gracefully without it
- SQLite DB created at `./data.db` on first run (auto-migrated in `server/storage.ts`)

**Production:**
- Railway (referenced throughout comments and build scripts)
- Served as a single combined server: Express serves both the REST API and static client files
- Single port, bind `0.0.0.0`, default port 5000
- Entrypoint: `dist/index.cjs` (CJS bundle produced by esbuild)

---

*Stack analysis: 2026-05-05*
