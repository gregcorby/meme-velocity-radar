# Product — Meme Velocity Radar

## What it is

Meme Velocity Radar is a Solana memecoin intelligence dashboard that surfaces and ranks newly active tokens by velocity, virality, upside, and risk so a human operator can decide what to watch.

## Problem

Solana memecoin launches are noisy, fast, and adversarial. By the time a token shows up on a typical chart site, the early move is over. Manually monitoring DEX feeds, launchpads, and on-chain pool creates is impossible at scale, and most "scanner" tools either lag, hide their data sources, or push users toward auto-trading they did not opt into.

Meme Velocity Radar is a read-only observation layer. It pulls from public DEX data plus a live Solana gRPC firehose, reduces the noise into a small ranked list, and shows the operator the signal a human would actually use to decide whether to look closer.

## Target users

- **Active memecoin trader.** Wants an early-warning watchlist of tokens that are heating up but not yet obvious.
- **On-chain researcher / analyst.** Wants to see which programs are producing live activity and what the early candidates look like, with raw scoring transparent.
- **Builder evaluating Solana data infrastructure.** Wants a working reference for combining DexScreener + SVS API + SVS Geyser gRPC into one product surface.

## Core value proposition

- Live candidates from launchpads (PumpSwap, Raydium LaunchLab, optionally Pump.fun) and Raydium pools, merged with a DexScreener fallback so the radar keeps working even without paid keys.
- Per-token score across velocity, virality, upside, and risk, with the underlying signals visible.
- One screen, mobile-friendly, no wallet, no auto-trade.
- Self-hostable on Railway from a phone.

## Working features

- React/Express full-stack dashboard served from one Node process.
- DexScreener public-feed scanner (works with no keys).
- SVS API enrichment for token metadata, mint info, and price windows when `SVS_API_KEY` is set.
- SVS RPC HTTP/WS health probing (`getLatestBlockhash`).
- SVS Geyser gRPC live transaction ingestion (Yellowstone) when `SVS_GRPC_ENDPOINT` is set.
  - Auto-reconnect with exponential backoff (1s → 30s).
  - 30s keepalive ping.
  - Bounded in-memory candidate cache (45 min TTL, 1k cap).
  - Stable-token blocklist (SOL/wSOL, USDC/USDT, BONK, WIF, etc.).
  - Safe defaults: launchpads + Raydium CPMM on, AMM v4 firehose opt-in.
- Candidate merging: gRPC candidates are prioritised over DexScreener; gRPC-only mints surface as conservative `grpc-only` watchlist seeds.
- `/api/radar` JSON snapshot, `/api/radar/stream` Server-Sent Events, `/api/svs/health`, `/api/grpc/status` (with `diagnostics`).
- Header badge UI showing SVS health and gRPC worker state.
- CSV export of visible signals.
- SQLite snapshot persistence with stale-snapshot fallback when upstream fails.
- Hard deadlines on `/api/radar` and `/api/svs/health` so a slow upstream never hangs the page.
- Compact log lines and bounded diagnostics counters to keep small Railway containers within memory budget.
- Railway deploy from GitHub.

## Non-goals (current version)

- **No auto-trading.** The product does not place orders, route transactions, or sign anything.
- **No wallet custody.** No private keys, no in-app wallet, no signing flow.
- **No financial advice.** Scores are heuristic. Risk flags are not guarantees. Memecoin risk remains extreme.
- **No raw-shred / sniper mode.** No Lightspeed / Jito relay path, no MEV, no bundled transaction landing.
- **No private/closed data.** All data sources are either public DEX feeds or endpoints the operator has paid access to.

## User flows that work today

1. **Open the dashboard.** `GET /` serves the SPA. The radar populates within ~20s and refreshes every 20s.
2. **Watch live candidates.** Top of the screen lists ranked tokens with velocity/virality/upside/risk and a meme narrative.
3. **Inspect health.** Header SVS badge shows `connected` / `degraded` / `error` / `not configured`. gRPC badge shows worker state and recent event volume.
4. **Stream updates.** `/api/radar/stream` (SSE) pushes a fresh snapshot every 20s.
5. **Pull a snapshot directly.** `/api/radar` returns a JSON snapshot, `/api/radar?force=1` bypasses the in-process cache.
6. **Diagnose ingestion.** `/api/grpc/status` (instant) returns connection state, filters, watched programs, and parse-counter diagnostics.
7. **Run with no keys.** With every SVS variable blank the app still serves a DexScreener-only radar.
8. **Deploy from phone.** Railway → Deploy from GitHub → set vars → public domain.

## Feature maturity

| Feature | State |
| --- | --- |
| DexScreener fallback radar | Working |
| Score (velocity, virality, upside, risk) | Working |
| Meme narrative decoder | Working |
| SVS API metadata / mint info / price | Working |
| SVS RPC health probe | Working |
| SVS gRPC live worker (launchpads + CPMM) | Working with safe defaults |
| Raydium AMM v4 stream | Partial — opt-in only, can OOM small hosts |
| Pump.fun program watcher | Working — canonical program ID baked in as default |
| Protocol decoders (Pump.fun create/graduate, PumpSwap pool, Raydium LaunchLab/CPMM) | Working — emits typed `launch.created` / `pool.created` / `launch.graduated` events with creator wallet |
| `grpc-only` early-signal candidates | Working, conservative score |
| CSV export | Working |
| SSE live stream | Working |
| Stale-snapshot fallback (SQLite) | Working |
| Auth cooldown after SVS 401/403 | Working |
| Header badges | Working |
| Mobile layout | Working |
| Risk scoring from on-chain authority/holder data | Not yet built |
| Social virality sources (X, Telegram) | Not yet built |
| Backtesting / historical DB | Not yet built |
| Execution / order placement | Not in scope |

## Success metrics

- **Uptime.** `/api/radar` returns a fresh or stale snapshot in under the deadline; never a 5xx for >1% of requests.
- **Ingestion health.** With launchpad-only gRPC enabled, `candidateCount > 0` within 5 minutes of boot, and `eventsPerMinute` stays in the low thousands rather than the hundreds of thousands.
- **Memory.** Railway container memory stays flat over a 24h window with `ENABLE_RAYDIUM_AMM_V4=false`.
- **Dashboard relevance.** A human glancing at the top of the radar sees tokens that are objectively moving (volume, transactions, price action) within the last few minutes.
- **No silent breakage.** When SVS is misconfigured, the badge and `/api/svs/health` clearly say so; the radar continues to work on DexScreener.
