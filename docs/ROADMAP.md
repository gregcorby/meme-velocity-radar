# Roadmap — Meme Velocity Radar

Priorities are intentionally short. P0 is "the product runs reliably". P1 is "the product gets meaningfully better signal". P2 is later.

## P0 — Stabilise the running product

The current deployment must be boring and predictable before anything else gets built on top.

- Hold the safe-default config: launchpads + Raydium CPMM on, AMM v4 off.
- Confirm a small Railway container (default plan) stays under memory budget over 24h with launchpad-only ingestion.
- `/api/svs/health` and `/api/grpc/status` always return within their deadlines.
- Stale-snapshot fallback proven on a forced upstream outage.
- Header badges accurately reflect underlying state (no false `connected`).
- Document the operating envelope (this docs set).

### Acceptance criteria for next milestone

**"Reliable launchpad-only gRPC ingestion"** is met when, on a stock Railway deploy with the safe defaults from `RUNBOOK.md`:

1. After a fresh deploy, `/api/grpc/status.status === "connected"` within 60 seconds.
2. Within 5 minutes of boot, `/api/grpc/status.candidateCount > 0`.
3. Over a 24h window:
   - Container memory stays flat (no OOM, no Railway restart from memory).
   - `eventsPerMinute` stays within a reasonable launchpad band (low thousands, not 50k+).
   - At least one new candidate is added per hour during normal market activity.
4. `/api/radar` returns a snapshot with `tokens.length > 0` for >99% of requests, including periods where DexScreener is briefly slow (stale-fallback path engaged).
5. Logs over a 24h window contain no `OOM`, no unbounded stack-trace floods, and at most transient `gRPC reconnecting` lines that resolve within a minute.

When all five are true on a default Railway plan, P0 is closed.

---

## P1 — Better signal

Each item below is the next thing that meaningfully improves the radar's decision quality. They are roughly parallel; pick whichever the operator finds most painful first.

### P1.1 — Protocol-specific decoders

Today the gRPC parser is generic: it reads token-balance deltas and emits a candidate mint. It does not decode the actual pool-create instruction per protocol.

Build per-protocol decoders for:

- **Pump.fun** — bonding-curve token creation, graduation events.
- **PumpSwap** — pool creation and migration from Pump.fun.
- **Raydium LaunchLab** — launch event detection.
- **Raydium CPMM** — pool create instruction.

Each decoder should:

- Emit a typed event (`launch.created`, `pool.created`, `launch.graduated`).
- Tag the candidate with the source protocol and the original signature.
- Surface the create-time fields (initial liquidity, creator wallet, decimals).

Acceptance: a Pump.fun launch shows up in the radar within 5 seconds of its create transaction, tagged as `pumpfun:create`, with creator wallet visible in the candidate metadata.

### P1.2 — On-chain risk scoring

Right now the risk score is heuristic over DexScreener metrics. Add real on-chain risk factors:

- **Mint authority.** Renounced or not. Open mint = score penalty.
- **Freeze authority.** Renounced or not. Live freeze = hard risk flag.
- **Top-holder concentration.** Top-1 / top-10 holder % from token largest accounts.
- **Creator-wallet behaviour.** Has the creator deployed-and-rugged tokens before? Look at recent token creates from the same wallet.

Surface these as discrete flags on `TokenSignal.riskFlags` (`mint authority live`, `freeze authority live`, `top-1 holder >25%`, `creator linked to N prior tokens`) and feed them into the numeric risk score.

Acceptance: a token whose mint authority is unrenounced shows the `mint authority live` flag and a risk score noticeably higher than an otherwise-identical token whose authority is renounced.

### P1.3 — Social virality sources

Today "virality" is derived from on-chain activity. Pull in real social signal:

- **X / Twitter.** Search-API or scraping for recent mentions of the symbol or contract address; weight by author reach. Likely needs a paid API tier.
- **Telegram.** Track mentions in a curated list of public channels.
- **DexScreener boosts.** Already partially used; expand into a real "paid promotion" signal separate from organic mentions.

Acceptance: a token with a known viral X mention appears in the top of the radar within 60 seconds with a non-zero `virality` contribution clearly attributable to the social source.

---

## P2 — Later

These are deliberately deferred. They expand product surface area and should not be touched until P0 and at least one P1 item are done.

### P2.1 — Backtesting / historical DB

Persist time-series snapshots (not just the latest) into a real datastore, so the operator can:

- Replay how a given token's score evolved.
- Backtest scoring changes against historical candidates.
- Compute hit-rate metrics (e.g., "how many `velocity > 0.8` tokens reached >2x within 1h").

Likely shape: append-only Postgres or SQLite WAL of `(snapshot_at, token_signal)`, plus a small replay UI.

### P2.2 — Execution / Lightspeed

Explicitly **later**. This is where the product goes from observation to action:

- Add a Solana wallet integration (signing only, no custody).
- Optional Lightspeed / Jito-bundle landing for fast execution.
- Manual one-click "buy with N SOL" tied to a candidate.

Until P0 is solid and P1 risk-scoring is in place, this would be irresponsible to ship. Treated as a separate product phase.

---

## Out of scope (current and foreseeable)

- Auto-trading bots or any trade-by-default behaviour.
- In-app wallet custody.
- Financial advice. The product describes signals; it does not recommend trades.
- Raw-shred / sniper paths where the product front-runs by tx ordering.
- Mass user accounts / multi-tenant SaaS. Single operator deploys are the assumption.
