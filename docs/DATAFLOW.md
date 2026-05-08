# Data Flow & Signal Formulation

> How raw data becomes the radar score. Reading order: §1 sources → §2
> pipeline → §3 transformations → §4 scoring math → §5 failure paths.

---

## 1. Data sources

Three live inputs feed the radar.

### 1.1 SVS Geyser gRPC (Yellowstone) — live transactions
- **What:** every Solana transaction touching a watched program, in real time.
- **Watched programs:** pump.fun, pumpswap, raydium-launchlab (always);
  raydium-cpmm/clmm (default on); raydium-amm-v4 (opt-in only).
- **Per event:** account keys, pre/post token balances, signature, slot,
  vote/error flags, instruction-level data.
- **Volume:** thousands of events/min. Decoded into typed launch events
  (`launch.created`, `pool.created`, `launch.graduated`, generic `grpc-transaction`).
- **Touched in:** `server/grpcStream.ts`, `server/decoders.ts`.

### 1.2 DexScreener REST API — pair stats + discovery
- **No auth.** Polled every snapshot cycle.
- **4 seed feeds (parallel, 4s timeout each):**
  - `/token-boosts/latest/v1` — paid boost activity
  - `/token-profiles/latest/v1` — newly profiled tokens
  - `/token-profiles/recent-updates/v1` — profile changes
  - `/metas/trending/v1` — trending categories ("hot metas")
- **Per-mint fetch (14× parallel, 3.5s timeout):**
  - `/token-pairs/v1/solana/{mint}` — all pools for that mint
- **Provides:** name, symbol, image, description, links, liquidity, market
  cap, volume windows (m5/h1/h6/h24), price change %, tx counts (buys/sells).
- **Touched in:** `server/routes.ts`.

### 1.3 SVS REST API — token enrichment
- **Auth:** `?api_key=…` query param. Free tier: 5 req/sec.
- **3 endpoints:**
  - `POST /metadata` — name, symbol, description, image, decimals, creator
  - `POST /price` — latest_price, avg_price_{1m,15m,1h}, volume_{1m,15m,1h,24h,72h}
  - `POST /mint_info` — description, creator, authority, early trades
    (only for pump.fun/bonk.fun mints <72h old; 404 otherwise)
- **Caches:** metadata 5min, price 30s, mint_info 5min. Per-mint TTL.
- **Touched in:** `server/svs.ts`.

---

## 2. Pipeline (where the data flows)

```
                      ┌─────────────────────────────┐
                      │  gRPC Yellowstone stream    │  (always-on, background)
                      │  watches launchpad programs │
                      └──────────────┬──────────────┘
                                     │ every transaction
                      ┌──────────────▼──────────────┐
                      │  CandidateStore (in-memory) │
                      │  Map<mint, GrpcCandidate>   │
                      │  TTL: 45 min, cap: 1,000    │
                      └──────────────┬──────────────┘
                                     │
   ───── SSE tick every 20s, OR /api/radar request ─────
                                     │
                        ┌────────────▼────────────┐
                        │  buildSnapshot()        │
                        │  hard deadline: 12s     │
                        └────────────┬────────────┘
                                     │
            ┌────────────────────────┼─────────────────────────┐
            │                        │                          │
   ┌────────▼─────────┐    ┌─────────▼────────┐      ┌─────────▼────────┐
   │ DexScreener seed │    │ getRecentGrpc-   │      │ DexScreener      │
   │ 4 parallel calls │    │ Candidates(40)   │      │ pair fetch       │
   │ ≤4s each         │    │                  │      │ 14× parallel     │
   └────────┬─────────┘    └─────────┬────────┘      └─────────┬────────┘
            │                        │                          │
            └────────────┬───────────┘                          │
                         │                                       │
              merge to candidate list (priority:                 │
              gRPC > boosts > updates > profiles)                │
              dedupe → cap at 14                                 │
                         │                                       │
                         └───────────────────┬───────────────────┘
                                             │
                                ┌────────────▼────────────┐
                                │ SVS enrichment          │
                                │ (top 8 only, sequential)│
                                │ /metadata then /price   │
                                │ ≤2.5s each              │
                                └────────────┬────────────┘
                                             │
                                ┌────────────▼────────────┐
                                │ scorePair()             │
                                │ velocity / virality /   │
                                │ upside / risk / final   │
                                │ + memeType + flags      │
                                └────────────┬────────────┘
                                             │
                                ┌────────────▼────────────┐
                                │ gRPC-only fallback for  │
                                │ candidates with no DEX  │
                                │ pair → conservative     │
                                │ scores (capped low)     │
                                └────────────┬────────────┘
                                             │
                                sort by scores.final desc
                                truncate to 24
                                             │
                                ┌────────────▼────────────┐
                                │ /mint_info top 3 only   │
                                │ (≤1.25s, description    │
                                │  text only, no rescore) │
                                └────────────┬────────────┘
                                             │
                                ┌────────────▼────────────┐
                                │ RadarSnapshot           │
                                │ memoryCache 25s         │
                                │ persist to SQLite       │
                                └────────────┬────────────┘
                                             │
                              JSON → /api/radar
                              SSE  → /api/radar/stream
```

**Refresh cadence:**
- SSE tick → fresh `buildSnapshot()` every 20s.
- `/api/radar` → 25s memory cache, coalesces concurrent requests.
- DexScreener fetched fresh every cycle.
- SVS metadata: ~98% cache hit after warm-up (5min TTL).
- SVS price: ~50% cache hit (30s TTL, every 2nd cycle).
- gRPC continuous and independent — drains into CandidateStore regardless of build cycles.

---

## 3. Source-to-signal table

How each output field on a `TokenSignal` is populated.

| Field | Primary source | Fallback | Code |
|---|---|---|---|
| `tokenAddress` | DexScreener `pair.baseToken.address` | profile `tokenAddress` | routes.ts:315 |
| `name` | DexScreener `pair.baseToken.name` | SVS `metadata.name` → "Unknown" | routes.ts:321 |
| `symbol` | DexScreener `pair.baseToken.symbol` | SVS `metadata.symbol` | routes.ts:322 |
| `marketCap` | DexScreener `pair.marketCap` | `pair.fdv` | routes.ts:343 |
| `liquidityUsd` | DexScreener `pair.liquidity.usd` | 0 | routes.ts:342 |
| `volume.m5` | SVS `volume_15min/3` if >0, else SVS `volume_1min*5` | DexScreener `pair.volume.m5` | routes.ts:338 |
| `volume.h1` | SVS `volume_1h` if >0 | DexScreener `pair.volume.h1` | routes.ts:339 |
| `volume.h6` | SVS `volume_24h/4` if >0 | DexScreener `pair.volume.h6` | routes.ts:340 |
| `volume.h24` | SVS `volume_24h` if >0 | DexScreener `pair.volume.h24` | routes.ts:341 |
| `priceChange.{m5,h1,h6,h24}` | DexScreener only | — | routes.ts:253 |
| `buyPressureH1` | DexScreener `pair.txns.h1.buys / total` | 0.5 (neutral) | routes.ts:351 |
| `volumeAcceleration` | derived: `(m5*12) / h1` | — | routes.ts:348 |
| `scores.{velocity,virality,upside,risk,final}` | computed (§4) | — | routes.ts:360-415 |
| `memeType` + `memeDecode` | regex over name+symbol+description | — | routes.ts:268-292 |
| `imageUrl` | DexScreener `pair.info.imageUrl` | profile `icon` | routes.ts:439 |
| `links[]` | DexScreener profile + pair info socials | pair.url | routes.ts:294-306 |
| `creatorWallet` | gRPC decoder | null | routes.ts:773-775 |
| `launchEvent` | gRPC decoder | null | routes.ts:776-786 |
| `opportunityFlags` | thresholds over volume/cap/buy-pressure + gRPC tags | — | routes.ts:399-405, 770-785 |
| `riskFlags` | thresholds over liquidity/sell-pressure/age/sparseness | — | routes.ts:391-397 |

Key takeaway: **DexScreener is the spine**. SVS overlays better volume
windows when available. gRPC adds early-discovery signal and creator/launch
metadata that DexScreener doesn't expose.

---

## 4. Scoring math

All scores clamped to `[0, 100]`. Helper: `logNorm(value, max) = clamp(log10(value+1) / log10(max+1) * 100)`.

### 4.1 Velocity — "is this moving NOW?"
```
velocity =
    logNorm(volume_m5, 75_000)               × 0.20   // 5m volume level
  + clamp(volumeAcceleration / 3 × 100)      × 0.22   // 5m vs h1 pace ratio
  + clamp(txnAcceleration / 3 × 100)         × 0.18   // tx count acceleration
  + clamp((buyPressureM5 - 0.45) × 220)      × 0.12   // buyer dominance in 5m
  + clamp(priceChange.h1 / 140 × 100)        × 0.16   // h1 price change
  + clamp(priceChange.m5 / 25 × 100)         × 0.07   // m5 price change
  + clamp(liquidityUsd / 45_000 × 100)       × 0.05   // depth bonus
```
**Weight:** acceleration 40%, price change 23%, volume level 20%, buyer ratio 12%, liquidity 5%.

### 4.2 Virality — "is the market noticing?"
```
virality =
    clamp(boostAmount / 30 × 100)            × 0.22   // DexScreener boost
  + clamp(socialCount / 3 × 100)             × 0.24   // unique socials (X/TG/Disc)
  + clamp(description.length / 260 × 100)    × 0.16   // description signal
  + (hasProfile ? 16 : 0)                              // has icon/image/desc
  + (memeType === "Fresh ticker meme" ? 8 : 18)       // archetype bonus
  + clamp(h1Tx / 900 × 100)                  × 0.12   // trade activity
```

### 4.3 Upside — "how much room to run?"
Three derived intermediates, then weighted:
```
capHeadroom =
    cap < 50K   → 72       // micro-cap
    cap < 250K  → 88       // sweet spot
    cap < 1.5M  → 78
    cap < 8M    → 58
    else        → 30       // diminishing returns

liquidityHealth = piecewise → 88 max above $80K liq

ageScore =
    < 8 min     → 35       // too new, uncertain
    < 90 min    → 90       // prime launch window
    < 720 min   → 70
    else        → 45

upside =
    velocity              × 0.34
  + virality              × 0.20
  + capHeadroom           × 0.16
  + liquidityHealth       × 0.12
  + clamp((buyPressureH1 - 0.44) × 210) × 0.10
  + ageScore              × 0.08
```

### 4.4 Risk — additive penalty
Not a weighted score — straight sum of penalties:
```
risk =
    liquidity < $10K → +24    (else <$25K → +12, else +3)
  + buyPressureH1 < 0.48 → +18 (else +4)
  + priceChange.m5 < -6%  → +18
  + description.length < 20 → +12
  + pair age < 10 min      → +14
  + boost > 0 but no socials → +12
```

### 4.5 Final
```
final = clamp( upside × 0.54  +  velocity × 0.30  +  virality × 0.22  -  risk × 0.18 )
```
Weights for positive terms sum to 1.06 — small intentional "overshoot" so
the risk penalty lands meaningfully without crushing the headroom.

### 4.6 gRPC-only tokens (no DEX pair yet)
Conservative ceilings so pre-DEX candidates surface but don't dominate:
```
velocity = 20 + min(txCount, 8) × 4    // range: 20-52
virality = description ? 25 : 12
upside   = 20 + (price ? 8 : 0) + (meta ? 6 : 0)  // 20-34
risk     = 45 + (meta ? 0 : 6) + (price ? 0 : 6)  // 45-57
final    = clamp(upside × 0.4 + velocity × 0.3 + virality × 0.2 - risk × 0.2)
```

---

## 5. Failure & decision points

What happens when something goes wrong:

| Condition | Outcome |
|---|---|
| gRPC not configured | Pipeline runs on DexScreener only. Candidates list is just boosts/profiles. |
| gRPC stream error | Exponential backoff (1s→30s). Existing CandidateStore survives reconnect. |
| DexScreener seed feed fails (any of 4) | `sourceHealth` entry → `error`, populates `brokenSources`, snapshot `status: "broken"`. Client renders hard-error screen. |
| DexScreener pair fetch fails for a mint | That mint produces no DEX-backed signal. If it was a gRPC candidate, falls through to `buildGrpcOnlyToken()`. |
| SVS_API_KEY missing | All SVS calls return `{ ok: false }`. Volume/price fall back to DexScreener. Source health → `missing` (not broken — SVS is optional enrichment). |
| SVS 401/403 | 5-min auth cooldown. All non-probe SVS calls short-circuit. |
| SVS 429 | Up to 2 retries respecting `Retry-After`. After that, batch abandoned. |
| SVS build budget exhausted (>2.5s) | Resolves immediately with degraded source. Snapshot uses DexScreener-only data. |
| `/mint_info` 404 | Silently cached as `{ mint }` for 5min. Not an error — most mints aren't eligible. |
| Build deadline (12s) hit | Returns synthetic broken snapshot with empty tokens, in-flight build continues in background. |

**Fail-loud principle:** the radar will show the BrokenScreen rather than a
stale or partial snapshot when any required upstream is down. The four
"required" sources are the DexScreener seed feeds. SVS is optional
enrichment, gRPC is optional discovery — degraded states there don't
break the radar, they just narrow the candidate set or fall back to
DexScreener-only volume.

---

## 6. Where to make changes

| If you want to… | Edit |
|---|---|
| Change scoring weights | `server/routes.ts` `scorePair()` lines 360-415 |
| Add a new opportunity/risk flag | `server/routes.ts` lines 391-405 |
| Adjust meme classification | `server/routes.ts` `classifyMeme()` 268-292 |
| Watch a new program on gRPC | `server/grpcStream.ts` `WATCHED_PROGRAMS` + filter groups |
| Decode a new launch event type | `server/decoders.ts` |
| Change refresh rate | `REFRESH_SECONDS` and `CACHE_MS` in `server/routes.ts` |
| Tune SVS rate budget | `BATCH_SIZE`, `INTER_BATCH_DELAY_MS` in `server/svs.ts` |
| Cap candidates differently | `MAX_CANDIDATES` in `server/routes.ts` |
| Adjust gRPC-only score ceilings | `buildGrpcOnlyToken()` in `server/routes.ts` |
