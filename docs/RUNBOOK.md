# Runbook — Meme Velocity Radar

Operational guide for running and deploying Meme Velocity Radar. Optimised for the realistic case: one operator, Railway, sometimes from a phone.

## TL;DR

- Local: `npm install && cp .env.example .env && npm run dev` → http://localhost:5000
- Production: `npm run build && npm start`
- Railway: deploy from GitHub, set env vars, generate a public domain.
- Default safe production config: launchpads + Raydium CPMM on, **AMM v4 OFF**.
- Health: `/api/svs/health`, `/api/grpc/status`.

---

## 1. Run locally

```bash
npm install
cp .env.example .env
# edit .env with any SVS keys you have (all optional)
npm run dev
```

Open http://localhost:5000.

The dev server uses `tsx` for TypeScript. The frontend (Vite/React) is served by the same Express process via the dev middleware.

If you have no SVS keys at all, the radar runs on the DexScreener public feed.

### Production build

```bash
npm run build
npm start
```

The server reads `PORT` from the host environment and defaults to `5000`.
The build emits a single CommonJS bundle in `dist/`. Railway should build from source — `dist/` is gitignored.

---

## 2. Deploy / redeploy on Railway from a phone

1. Open Railway in mobile browser.
2. **New project** → **Deploy from GitHub repo** → pick `meme-velocity-radar`.
3. Variables tab → paste the variables from section 3 below.
4. If Railway asks for build/start commands:
   - Build: `npm install && npm run build`
   - Start: `npm start`
5. **Settings → Networking → Generate Domain** to get a public URL.

### Redeploy after a change

- Push to `master` on GitHub. Railway auto-redeploys on push.
- Or in Railway: **Deployments → Redeploy** on the latest commit.
- After changing env vars: Railway redeploys automatically once you save them. If a value looks "stale" in logs, hit **Redeploy** manually — env-var edits during a build are not always picked up.

---

## 3. Required Railway variables

All values below are placeholders. Real values must come from the operator's own SVS account.

### Always set

```bash
NODE_ENV=production
```

### SVS API (metadata, price, mint info)

```bash
SVS_API_BASE_URL=https://free.api.solanavibestation.com   # optional, this is the default
SVS_API_KEY=                                              # bearer token for SVS API tier
```

### SVS RPC (HTTP + WebSocket)

```bash
SVS_RPC_HTTP_URL=https://ultra.rpc.solanavibestation.com/?api_key=YOUR_KEY
SVS_RPC_WS_URL=wss://ultra.rpc.solanavibestation.com/?api_key=YOUR_KEY
```

### SVS gRPC (Yellowstone live transactions)

```bash
SVS_GRPC_ENDPOINT=https://ultra.grpc.solanavibestation.com
SVS_GRPC_X_TOKEN=                                         # blank if your plan is IP-whitelist
```

### Stream toggles (safe production defaults shown)

```bash
ENABLE_GRPC_DEX_POOLS=true     # Raydium CPMM / CLMM. Set false for launchpad-only.
ENABLE_RAYDIUM_AMM_V4=false    # KEEP FALSE on small Railway containers.
```

### Watched program IDs (defaults are baked in; only override to disable or change)

```bash
WATCH_PUMPSWAP_PROGRAM=pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
WATCH_RAYDIUM_LAUNCHLAB_PROGRAM=LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj
WATCH_RAYDIUM_CPMM_PROGRAM=CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
WATCH_RAYDIUM_AMM_V4_PROGRAM=     # blank = off; setting this is itself an opt-in
WATCH_RAYDIUM_CLMM_PROGRAM=
WATCH_PUMPFUN_PROGRAM=
```

Setting `WATCH_RAYDIUM_AMM_V4_PROGRAM` to a non-empty value is treated as an explicit opt-in to the AMM v4 firehose, even if `ENABLE_RAYDIUM_AMM_V4=false`. To stay safe, leave it blank.

### Do NOT prefix with `VITE_`

Anything prefixed with `VITE_` becomes accessible to browser JS. Every secret here belongs to the backend.

---

## 4. Safe production defaults

| Variable | Safe value | Why |
| --- | --- | --- |
| `ENABLE_RAYDIUM_AMM_V4` | `false` (or unset) | AMM v4 is the highest-volume mature pool stream and will OOM a small Railway container. Has caused production OOMs; fixed by gating in commit 793a5e1. |
| `ENABLE_GRPC_DEX_POOLS` | `true` | CPMM/CLMM are reasonable. Set to `false` for launchpad-only ingestion if memory is tight. |
| `WATCH_RAYDIUM_AMM_V4_PROGRAM` | blank | Setting it is an opt-in. Leave blank. |
| `WATCH_PUMPFUN_PROGRAM` | blank unless you have the program ID | The watcher only enables if a program ID is present. |

For a minimal launchpad-only config: keep `ENABLE_GRPC_DEX_POOLS=false`, leave AMM v4 off, leave Pump.fun blank, keep PumpSwap and Raydium LaunchLab. This is the lowest-event-volume mode that still gives you live launches.

---

## 5. Startup checklist

After (re)deploy on Railway:

1. Visit `/` — confirm the dashboard renders and the header badges show.
2. Hit `/api/svs/health` — expect `overall: "ok"` (or `degraded` if some SVS pieces are unset; that's fine).
3. Hit `/api/grpc/status`:
   - `status: "connected"` within ~10s of the gRPC worker booting.
   - `activeStreams >= 1`.
   - `eventsReceived` increasing on subsequent reads.
   - `eventsPerMinute` reasonable (low thousands for launchpad-only; tens of thousands+ if AMM v4 is on, which is your sign to turn it off).
4. Hit `/api/radar` — `tokens` array non-empty within ~30s.
5. Tail logs for ~2 minutes. Look for `gRPC connected`, no `OOM`/`Killed`, no repeating auth-rejected lines.

If `candidateCount` stays 0 for >5 minutes despite `eventsReceived > 0`, see Troubleshooting → "gRPC connected with candidateCount 0".

---

## 6. Health endpoints — how to interpret

### `GET /api/svs/health`

Returns:

```json
{
  "apiBaseUrl": "...",
  "api":  { "configured": true, "status": "ok" | "degraded" | "error", "detail": "..." },
  "rpc":  { "configured": true, "status": "...", "detail": "..." },
  "grpc": {
    "configured": true,
    "status": "...",
    "worker": "disabled|configured|connecting|connected|reconnecting|error",
    "activeStreams": 1,
    "filters": ["launchpads", "dexPools"],
    "candidateCount": 42,
    "eventsPerMinute": 850,
    "lastEventAgeSec": 2,
    "diagnostics": { ... }
  },
  "authCooldown": { "cooling": false, "remainingSec": 0, "lastStatus": null },
  "overall": "ok|degraded|error",
  "checkedAt": "..."
}
```

Reading it:

- `api.status: "error"` with `detail` mentioning `401`/`403` → wrong or unentitled `SVS_API_KEY`. Fix the key.
- `authCooldown.cooling: true` → the backend is in a cooldown after a 401/403. It will re-attempt after `remainingSec`. The radar continues to work; it just skips paid SVS calls during the cooldown.
- `rpc.status: "error"` → `SVS_RPC_HTTP_URL` is unreachable or invalid.
- `grpc.worker: "disabled"` → `SVS_GRPC_ENDPOINT` is unset. Set it to enable live ingestion.
- `grpc.worker: "connected"` + `candidateCount: 0` for >5 min → see troubleshooting matrix.
- This endpoint is **deadline-bound** (`HEALTH_DEADLINE_MS`). If upstreams hang, you get a `degraded` fallback report rather than a hung request.

### `GET /api/grpc/status`

Synchronous, instant, never waits on the stream. Returns the full `GrpcStatus` object: `status`, `endpointConfigured`, `hasToken`, `activeStreams`, `filters`, `lastEventAt`, `lastEventAgeSec`, `lastError`, `eventsReceived`, `eventsPerMinute`, `candidateCount`, `watchedPrograms`, and a `diagnostics` block:

```json
{
  "diagnostics": {
    "eventsWithTokenBalances": 12345,
    "eventsWithCandidateMints": 678,
    "eventsByProgram": { "raydium-cpmm": 9000, "pumpswap": 800, ... },
    "eventsByFilter": { "launchpads": 800, "dexPools": 9000 },
    "ignoredBaseMintCount": 4500,
    "parseErrorCount": 0,
    "lastCandidateAt": "...",
    "lastCandidateAgeSec": 12,
    "ignoredReasonCounts": { "blocklisted-mint": 4500, "no-token-balance-delta": 7000 }
  }
}
```

Use `diagnostics` to explain `candidateCount: 0` despite high `eventsReceived`. If `eventsByFilter.launchpads` is 0 but `dexPools` is huge, your launchpad program IDs are wrong or those launchpads are quiet right now.

---

## 7. Troubleshooting matrix

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Container restart loop, log shows `OOM` / `Killed` | AMM v4 firehose is on (`ENABLE_RAYDIUM_AMM_V4=true` or `WATCH_RAYDIUM_AMM_V4_PROGRAM` set) | Set `ENABLE_RAYDIUM_AMM_V4=false`, blank `WATCH_RAYDIUM_AMM_V4_PROGRAM`, redeploy. AMM v4 is opt-in for this exact reason. |
| `/api/svs/health` shows `api.status: "error"` with `403` | SVS API key missing entitlement, expired, or wrong tier | Check `SVS_API_KEY`. Confirm with SVS that the key has the API entitlement (not just RPC/gRPC). Free key may not have API access. |
| `authCooldown.cooling: true` | Backend received 401/403 from SVS API and is sleeping the calls | Fix `SVS_API_KEY`. Cooldown auto-clears after the window. |
| `/api/grpc/status` `status: "connected"` but `candidateCount: 0` | Either filters aren't matching launches, base-mint blocklist is filtering everything, or the watched programs aren't producing token-balance deltas | Inspect `diagnostics`: if `eventsReceived` is high but `eventsWithTokenBalances` is low, the stream isn't carrying balance deltas the parser needs (transaction filter / encoding issue). If `ignoredBaseMintCount` is huge, traffic is on stable pairs only — wait for fresh launches or enable a launchpad. |
| `/api/grpc/status` `status: "disabled"` or `"not configured"` | `SVS_GRPC_ENDPOINT` is blank | Set `SVS_GRPC_ENDPOINT`. If your plan needs a token, also set `SVS_GRPC_X_TOKEN`. |
| `/api/grpc/status` `status: "error"` or `"reconnecting"` with auth-rejected error | Wrong `SVS_GRPC_X_TOKEN`, or IP not whitelisted on an IP-restricted plan | Confirm token / whitelist with SVS. The worker auto-retries with backoff to 30s. |
| `/api/radar` slow (>5s) | Upstream DexScreener / SVS API slow | The endpoint is deadline-bound — it will return cached or stale snapshot rather than hang. If consistent, check `/api/svs/health` for which leg is slow. |
| `/api/radar` returns no tokens | Both DexScreener fallback and gRPC produced nothing | Hit `/api/radar?force=1` to bypass cache. Check `/api/grpc/status` for `eventsPerMinute > 0`. Check that DexScreener is reachable from the container. |
| `eventsPerMinute` extremely high (>50k) | AMM v4 or other firehose enabled | Disable AMM v4. Consider `ENABLE_GRPC_DEX_POOLS=false` for launchpad-only. |
| Env var change "didn't take effect" | Railway build picked up old vars, or you didn't trigger a redeploy | Manually **Redeploy** in Railway. Check the build log shows the new value. |
| Header SVS badge stuck on `not configured` | No `SVS_API_KEY` set | Set the key, or accept this — the radar still works via DexScreener. |
| Header gRPC badge `error` | `lastError` in `/api/grpc/status` | Read `lastError` for the actual upstream message. Common: auth, DNS, TLS. |

---

## 8. Expected logs

Healthy boot looks like:

- `serving radar from port 5000`
- `gRPC worker booting endpoint=...`
- `gRPC connected streams=1 filters=launchpads,dexPools`
- Periodic compact lines: events received, candidates seen, last error if any.
- No stack traces, no repeating `auth rejected` lines, no `OOM`.

Lines you should care about:

- `gRPC reconnecting in Xms` — transient, fine if it stops within a minute.
- `auth rejected — skipping for Ns` — cooldown engaged on SVS API; fix the key.
- `radar build deadline exceeded — serving stale snapshot` — upstream slowness; not fatal.
- `Killed` / `out of memory` — disable AMM v4, redeploy.

Logs are deliberately compact (one-line, bounded counters) so the Railway log buffer doesn't fill in minutes.
