# Handoff — Raw Feed page + "fail loudly" health gate

Date: 2026-05-06

## What was just shipped (committed-ready, `npm run check` passes)

### 1. Raw event feed (`#/raw`)
- `server/feed.ts` — in-process EventEmitter + 500-event ring buffer. Exports `emit`, `recent`, `subscribe`. String fields capped at 400 chars.
- `server/grpcStream.ts` — instrumented to emit `grpc.tx.received`, `grpc.tx.ignored` (with reason+slot+sig), `grpc.decode.matched`, `grpc.candidate.upserted` (with `isNew`). `CandidateStore.upsert` now returns `{ candidate, isNew }`.
- `server/routes.ts` — `fetchJson` emits `dex.fetch`; SVS metadata/price/mint_info calls emit `svs.fetch`; end of `buildSnapshot` emits `radar.snapshot`. New endpoints `GET /api/raw/recent?limit=` and `GET /api/raw/stream` (SSE; replays last 200; 15s heartbeat).
- `client/src/pages/raw-feed.tsx` — page with stage chips (all/grpc.tx/decode/candidate/dex/svs/radar), free-text filter, per-stage events/min counters, click-to-expand JSON rows, live/pause toggle, clear button.
- `client/src/App.tsx` — `#/raw` wouter route + sidebar link.

### 2. "Fail loudly" health gate
User decided: **all sources required (gRPC + SVS REST + DexScreener)**, broken state shows **full-page error block**.

- `shared/schema.ts` — `RadarSnapshot` gained `status: "ok" | "broken"` + `brokenSources: string[]`.
- `server/routes.ts`:
  - End of `buildSnapshot` computes brokenness — any `sourceHealth.status !== "ok"` OR `grpcStatus.status !== "connected"` → `status = "broken"`.
  - Removed stale-while-rate-limited fallback.
  - Removed deadline → `lastGoodSnapshot` fallback (returns broken snapshot with deadline error instead).
  - Removed `/api/radar` catch-block "last saved" fallback.
  - Removed unused `latestUsableSnapshot()`.
- `client/src/App.tsx` — new `BrokenScreen` component; `RadarHome` short-circuits to it when `snapshot.status === "broken"`. Lists every broken source verbatim with Retry button + link to `#/raw`.

### 3. Local-dev fixes
- `server/index.ts` — gate `reusePort: true` to Linux only (macOS `ENOTSUP`).
- `server/grpcStream.ts` — added permanent `stream.on("error", () => {})` no-op handler right after `client.subscribe()` so late async errors from the keepalive ping don't crash the process.

## Open issue (NOT YET VERIFIED)

User's first `npm run dev` crashed with:
```
Error: channel closed
  at ClientDuplexStream._write
  at pingTimer (server/grpcStream.ts:561:12)
```

This crash happened **before** the no-op error handler was added. **User has not yet restarted to verify the fix works.**

User's stance: "this is standard stuff we should not be facing errors" — meaning gRPC reconnect should be silent/clean, not crash.

### Next step for fresh session
1. Read `.env` (file exists at repo root, 2021 bytes) to confirm `SVS_GRPC_ENDPOINT` + `SVS_GRPC_X_TOKEN` are set. **Sanitize the token before echoing.**
2. Have user run `PORT=5050 npm run dev` (port 5000 is hogged by macOS ControlCenter/AirPlay).
3. Observe: does the no-op handler fix the crash? If yes — does the channel still close repeatedly? If yes — investigate keepalive interval (currently `KEEPALIVE_MS = 30_000`), commitment level, or auth token validity.
4. Possible deeper fix: clear `pingTimer` on the FIRST stream `error`/`end`/`close` event (inside the named handlers), not just in `.finally`, so the ping can never fire on a closing stream.

## Local-dev gotchas captured
- macOS port 5000 is taken by ControlCenter (AirPlay Receiver) — use `PORT=5050`.
- Node 25 broke `better-sqlite3`; user is now on Node 22.22.2 via nvm, `npm rebuild better-sqlite3` not needed after switch.
- `reusePort` flag is Linux-only — already gated.

## Files touched this session
- `server/feed.ts` (new)
- `server/grpcStream.ts` (instrumented + no-op error handler + upsert return shape)
- `server/routes.ts` (instrumentation + endpoints + health gate + removed fallbacks)
- `server/index.ts` (reusePort gate)
- `shared/schema.ts` (status + brokenSources)
- `client/src/App.tsx` (BrokenScreen + route + sidebar link)
- `client/src/pages/raw-feed.tsx` (new)

`npm run check` is clean as of last edit.
