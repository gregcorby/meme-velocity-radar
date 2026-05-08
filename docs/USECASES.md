# Use Cases & User Flows — Meme Velocity Radar

> Companion to `PRODUCT.md`. Where PRODUCT.md describes what the system **is**,
> this doc describes what the user **does** with it. It is the source of truth
> for design and product decisions.

---

## 1. Persona — the Aggressive Memecoin Trader

**Who:** Solana-native trader. Lives in trader Discords / X threads / Telegram.
Familiar with Phantom, Jupiter, DexScreener, pump.fun, BullX-class tools.

**Goal:** Find tokens that are about to pump and ape in early. Exits are
their problem; the radar's job is **discovery**.

**Mental model:** "If I'm in before the herd, I make money. If I'm last, I'm
exit liquidity."

**Operating context:**
- **Time pressure: extreme.** Decisions in 5-30 seconds, not minutes.
- **Attention: divided.** Radar is one of 3-6 tabs / apps open at once.
- **Risk tolerance: high — but not naïve.** Will skip an obvious rug, not a
  sketchy one. Wants risk *visible*, not *prescribed*.
- **Device: desktop primary, mobile common.** Phone use happens in motion.
- **Action lives elsewhere.** Buy happens on Jupiter / Phantom / DexScreener.
  Radar is read-only and one click away from the actual trade surface.

**What "winning" looks like for this persona:**
1. They open the radar, glance for ≤10 seconds, find a candidate, copy mint.
2. They paste mint into Phantom/Jupiter/DexScreener and trade.
3. The candidate moves. They were 30-300 seconds ahead of broader feeds.

**What "losing" looks like:**
- Radar shows a "great signal" that turns out to be a dev-bundle rug.
- Radar is laggy or stale and the trader misses the move.
- Radar is too noisy and the trader can't triage in time.
- Top candidate has hidden risk that should have been surfaced.

---

## 2. Core job-to-be-done

> **"Tell me which Solana tokens are about to pump, ranked, with enough
> context that I can decide to ape or skip in under 30 seconds."**

Everything else — meme decoding, risk notes, raw feed, source health —
serves this one job.

### Anti-jobs (out of scope on purpose)

The radar is **not** for:
- Long-form research / due diligence.
- Portfolio tracking.
- Multi-chain coverage. Solana only.
- Holding for weeks/months.
- Beginner education / explaining what a memecoin is.
- Auto-trading, wallet custody, or transaction signing.
- Social-feed alerting / community features.

Saying "no" to these keeps the surface fast.

---

## 3. UX principles for this persona

These principles override comfort defaults from generic dashboard design.

1. **Speed > depth.** Every screen must surface its answer in ≤3 seconds.
   If a value takes a click to see, it isn't first-screen information.
2. **Loud, not subtle.** Big numbers, high contrast, kinetic feel. The
   radar is a trading instrument, not a report.
3. **Bias-aware.** Confidence and concern shown side by side. Never hide
   a risk to make a candidate look better.
4. **Trust signals are first-class.** Data freshness, source health, and
   "are we live?" must be glanceable at all times.
5. **One-click to action.** Copy mint and Open DexScreener must be ≤1 tap
   from anywhere a candidate is shown.
6. **No hand-holding.** Assume the user knows what a candle, a meta, a
   buy-pressure ratio is. No tooltips that explain basic concepts.
7. **Fail loudly.** If a feed is broken, show the broken state — never
   serve a degraded number that looks fine.

---

## 4. Top scenarios (ranked by frequency × value)

### S1 — "What's hot RIGHT NOW?" (every-session, high value)
The trader opens the radar at the start of a session or returns after a few
minutes away. They want the top 5-10 tokens with rising velocity, ranked,
with enough info to triage which to dig into.

- **Trigger:** App open / tab refocus / SSE update.
- **Inputs:** Live snapshot of ranked tokens, sort by score (default).
- **Success:** ≤10s glance → identifies 1-3 candidates worth a closer look.
- **Failure:** List is stale, list is empty, top scores look implausible.

### S2 — "Should I ape this?" (every-session, highest value per instance)
Trader has a candidate from S1 (or pasted from outside). They need decode +
risk read in ≤30s.

- **Trigger:** Click a row in the token list.
- **Inputs:** Detail panel — score breakdown, meme decode, virality/upside
  thesis, risk note, live tape numbers.
- **Success:** Decision ("ape" or "skip") in ≤30s. Mint copied or
  DexScreener opened.
- **Failure:** Decode is generic, risk note doesn't match obvious red flags,
  or the data feels suspect.

### S3 — "Is the radar trustworthy right now?" (every-session, gating)
Before trusting a signal, the trader checks the data is fresh and live.

- **Trigger:** Glance at header / status bar at session start, after a
  pause, or when something feels off.
- **Inputs:** SVS health, gRPC live status, scanned count, last update
  timestamp, source-feed pass/fail.
- **Success:** All-green = trust. Any red = suspect; trader knows not to
  rely on a signal until restored.
- **Failure:** Status is green but data is actually stale (silent failure —
  the worst outcome, must be designed against).

### S4 — "Show me the X profile" (occasional, high value when used)
Trader narrows by archetype: "early caps under $350K," "lower risk only,"
"velocity-pumping," "social-proofed."

- **Trigger:** Click a sidebar filter.
- **Inputs:** Filter criteria applied client-side over the live snapshot.
- **Success:** Re-ranked list matching the profile. Trader picks from a
  pre-narrowed list.
- **Failure:** Empty list with no fallback ("try broader filter"), or
  filter logic the trader can't verify.

### S5 — "What metas are heating up?" (situational, contextual value)
Used to understand sector rotation. "Are we in cat season? Political
season? AI agent season?" Helps frame whether a candidate fits the moment.

- **Trigger:** Glance at Hot Metas rail.
- **Inputs:** Top metas with 1h % change.
- **Success:** Trader knows the current dominant theme.
- **Failure:** Rail is static / stale / shows the same metas hour after
  hour with no movement.

### S6 — "Why did the radar miss / hit X?" (post-session, low frequency)
Trader replays a missed pump or wants to understand the radar's read.
Today this is partially served by `/raw` (raw feed page).

- **Trigger:** Open `/raw` or check logs after a missed move.
- **Inputs:** Raw event stream, candidate upserts, dex/svs fetch results.
- **Success:** Trader can see whether the radar saw the token early and
  scored it low, or never saw it at all.
- **Failure:** Raw feed is too verbose / too sparse / doesn't show the
  scoring decision.

### S7 — "Watch a specific token" (gap today)
Trader pastes a mint they're tracking from elsewhere; wants the radar's
read on it.

- **Trigger:** Search box, paste mint.
- **Inputs:** Search filter today (matches name/symbol/meta/description).
- **Gap:** No direct mint lookup that fetches & scores an arbitrary token
  not currently in the candidate set.

---

## 5. User flows

### Flow A — Cold open (S1 + S3 fused)
```
Open app
  ↓
Header status bar visible (SVS, gRPC, scanned count, last-updated)
  ↓
Top of token list shows ranked candidates
  ↓
Trader scans top 5 in ~5s — name, symbol, score, 1h%, market cap
  ↓
Either: nothing interesting → leave tab open, wait for SSE update
Or:     candidate worth a look → click row → enter Flow B
```
**Critical UX:** the cold-open glance must answer "is this fresh?" and
"what's the best signal right now?" simultaneously, without any clicks.

### Flow B — Decide buy/skip (S2)
```
Click row in token list
  ↓
Detail panel updates: score, name, mint, meme type
  ↓
Trader reads top of detail panel:
  - Final score (big number, color-coded)
  - 4 sub-scores: velocity, virality, upside, risk
  ↓
If score promising → read meme decode (~1 sentence)
  ↓
If still promising → glance at risk note + live tape (volume, liq, age)
  ↓
Decision branches:
  - APE  → click "Open DexScreener" or "Copy mint" → leaves the radar
  - SKIP → back to list, scan next candidate
  - WATCH → keep tab open, wait for SSE update on this token
```
**Critical UX:** the decision-eligible info must be in the **first viewport**
of the detail panel. Scrolling = friction = missed move.

### Flow C — Trust check (S3)
```
Trader notices: list looks stale / all scores feel wrong / no SSE updates
  ↓
Glance at header status badges (SVS, gRPC, last-updated time)
  ↓
Branch:
  - All green → assume scoring/UX issue → reload, refile concern
  - One red → click "Raw feed" link → enter Flow F
  - Hard broken → BrokenScreen with retry button (current "fail loudly" gate)
```

### Flow D — Filter narrow (S4)
```
Sidebar filter click (e.g. "Lower risk")
  ↓
Token list re-ranks client-side over current snapshot
  ↓
Trader scans filtered list (S1 micro-loop)
  ↓
Picks → Flow B  /  empty → relax filter to "All signals"
```

### Flow E — Meta context (S5)
```
Trader glances at Hot Metas rail (sidebar)
  ↓
Notices a dominant meta, e.g. "AI agents +47% / 1h"
  ↓
Returns to token list with meta in mind
  ↓
Bias: weights candidates that fit the hot meta higher when scoring is close
```
**Note:** this is currently *passive context*; could become active if the
rail filtered the token list by meta tag on click.

### Flow F — Raw debug (S6)
```
Open #/raw
  ↓
Filter chips: grpc.tx / decode / candidate / dex / svs / radar
  ↓
Trader inspects which stage is failing or missing events
  ↓
Returns to dashboard once root cause is understood (or files an issue)
```

---

## 6. Information hierarchy on the main screen

For an aggressive trader, the **first viewport** must contain in order of
visual prominence:

1. **Top candidate name + score** — huge, glanceable
2. **Top candidate 1h% change** — color-coded with arrow
3. **Top candidate market cap + liquidity** — for sizing intuition
4. **Top 4-5 other candidates** — same row format, smaller
5. **Trust signals** — header status badges, last-updated timestamp
6. **Filters** — sidebar / chips for narrow by archetype
7. **Hot metas** — context, not action

Everything else (meme decode body text, virality/upside paragraphs, risk
note, live tape detail, volume chart) lives in the **detail panel** which
is opened on click. Scrollable is fine for those.

---

## 7. Gaps & open product questions

These should be resolved next, in priority order.

### P1 — must answer to close the core loop
- **Mobile experience.** Most aggressive trading happens on phone. The
  current dashboard is desktop-first. Decision: build a mobile layout
  that reorders the detail panel above the list when a row is selected,
  or commit to desktop-only with a mobile "view-only" warning?
- **Search-by-mint flow gap (S7).** Trader pastes an arbitrary mint from
  outside the radar's candidate set. Today: no result. Decision: build a
  one-shot fetch+score for arbitrary mints?
- **Silent staleness defense.** Today the trust signal is the timestamp.
  Better: a visible "last-event-age" counter that turns red >60s. Even
  better: pulse animation on each SSE update so live-ness is felt, not
  read.

### P2 — high value, defer until P1 is resolved
- **Push alerts / notifications.** Trader closes the tab, comes back to
  a missed pump. Browser notifications when a watched mint crosses score
  threshold. Requires: opt-in, watchlist, and a delivery channel decision
  (browser push? Telegram bot? email?).
- **Personal watchlist.** Pin specific mints. Show their current score
  prominently regardless of overall rank.
- **Score history per token.** Sparkline showing how this candidate's
  score evolved over the last hour. Helps distinguish "ramping" from
  "spiking and dying."

### P3 — nice-to-have / experimental
- **Click-to-filter on Hot Metas** — make the rail interactive (Flow E
  upgrade).
- **Copy-mint contextual menu** — right-click a token → copy mint /
  open DexScreener / open Phantom / open Jupiter.
- **Replay mode** — scrub backward through the last hour of snapshots
  to see what would have been on screen at a specific moment.
- **Score auditing** — click the score → see which underlying signals
  contributed and how (transparency / trust).

### Decisions that need an explicit answer
- Mobile primary or desktop primary? (currently desktop)
- Watchlist + alerts: in-scope or out-of-scope?
- Search-by-mint: in-scope or out-of-scope?
- Free public hosted instance, or self-host only?

---

## 8. What this doc is not

- Not a feature backlog. The roadmap lives in `docs/ROADMAP.md`.
- Not implementation guidance. Architecture lives in `docs/ARCHITECTURE.md`.
- Not a marketing document. PRODUCT.md is the outward-facing pitch.

This doc captures **how the user moves through the product** so that
every UX change can be checked against the persona's actual job.
