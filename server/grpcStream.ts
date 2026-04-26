// SVS Geyser gRPC live stream manager.
// Backend-only — never import this from client/* code. It reads secret env
// vars (SVS_GRPC_X_TOKEN) and forwards them to the SVS endpoint.
//
// Defensive parsing: yellowstone proto types are wide and many fields are
// optional. We isolate `any` access to this file and produce a small,
// well-typed candidate object for the rest of the app.

import bs58 from "bs58";

type GrpcStatusKind =
  | "disabled"
  | "configured"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export type GrpcStatus = {
  status: GrpcStatusKind;
  endpointConfigured: boolean;
  hasToken: boolean;
  activeStreams: number;
  filters: string[];
  lastEventAt: string | null;
  lastEventAgeSec: number | null;
  lastError: string | null;
  eventsReceived: number;
  eventsPerMinute: number;
  candidateCount: number;
  watchedPrograms: { name: string; programId: string }[];
};

export type GrpcCandidate = {
  mint: string;
  firstSeenAt: string;
  lastSeenAt: string;
  signature: string;
  slot: number;
  source: string; // primary watched program name
  observedPrograms: string[];
  sourceTags: string[];
  eventType: "grpc-transaction";
  txCount: number;
};

const STABLE_BLOCKLIST = new Set<string>([
  "So11111111111111111111111111111111111111112", // wSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", // mSOL
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", // jitoSOL
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", // WIF
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // ETH (wormhole)
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", // JUP
]);

const KEEPALIVE_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const CANDIDATE_TTL_MS = 45 * 60_000; // 45 minutes
const CANDIDATE_MAX = 1_000;

type WatchProgram = { name: string; programId: string };

function loadWatchPrograms(): WatchProgram[] {
  const list: WatchProgram[] = [];
  const push = (name: string, envName: string, fallback?: string) => {
    const id = (process.env[envName] ?? fallback ?? "").trim();
    if (id) list.push({ name, programId: id });
  };
  push("pumpswap", "WATCH_PUMPSWAP_PROGRAM", "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
  push(
    "raydium-launchlab",
    "WATCH_RAYDIUM_LAUNCHLAB_PROGRAM",
    "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
  );
  push(
    "raydium-cpmm",
    "WATCH_RAYDIUM_CPMM_PROGRAM",
    "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  );
  push(
    "raydium-amm-v4",
    "WATCH_RAYDIUM_AMM_V4_PROGRAM",
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  );
  push("raydium-clmm", "WATCH_RAYDIUM_CLMM_PROGRAM");
  push("pumpfun", "WATCH_PUMPFUN_PROGRAM");
  return list;
}

const WATCH_PROGRAMS = loadWatchPrograms();
const WATCH_BY_ID = new Map(WATCH_PROGRAMS.map((p) => [p.programId, p.name]));

const LAUNCHPAD_NAMES = new Set(["pumpswap", "raydium-launchlab", "pumpfun"]);
const DEX_POOL_NAMES = new Set(["raydium-cpmm", "raydium-amm-v4", "raydium-clmm"]);

function buildFilters(): {
  filters: Record<string, { vote: false; failed: false; accountInclude: string[]; accountExclude: string[]; accountRequired: string[] }>;
  filterNames: string[];
} {
  const launchpadIds = WATCH_PROGRAMS.filter((p) => LAUNCHPAD_NAMES.has(p.name)).map((p) => p.programId);
  const dexIds = WATCH_PROGRAMS.filter((p) => DEX_POOL_NAMES.has(p.name)).map((p) => p.programId);
  const filters: Record<string, any> = {};
  if (launchpadIds.length) {
    filters["launchpads"] = {
      vote: false,
      failed: false,
      accountInclude: launchpadIds,
      accountExclude: [],
      accountRequired: [],
    };
  }
  if (dexIds.length) {
    filters["dexPools"] = {
      vote: false,
      failed: false,
      accountInclude: dexIds,
      accountExclude: [],
      accountRequired: [],
    };
  }
  return { filters, filterNames: Object.keys(filters) };
}

class CandidateStore {
  private map = new Map<string, GrpcCandidate>();

  upsert(record: {
    mint: string;
    signature: string;
    slot: number;
    sourceProgramId: string;
    observedPrograms: string[];
  }) {
    const now = new Date().toISOString();
    const sourceName = WATCH_BY_ID.get(record.sourceProgramId) ?? "unknown-program";
    const existing = this.map.get(record.mint);
    if (existing) {
      existing.lastSeenAt = now;
      existing.signature = record.signature;
      existing.slot = record.slot;
      existing.txCount += 1;
      for (const program of record.observedPrograms) {
        if (!existing.observedPrograms.includes(program)) {
          existing.observedPrograms.push(program);
        }
      }
      this.map.delete(record.mint);
      this.map.set(record.mint, existing);
      return existing;
    }
    const created: GrpcCandidate = {
      mint: record.mint,
      firstSeenAt: now,
      lastSeenAt: now,
      signature: record.signature,
      slot: record.slot,
      source: sourceName,
      observedPrograms: record.observedPrograms.slice(),
      sourceTags: ["grpc-live", "grpc-transaction", `grpc:${sourceName}`],
      eventType: "grpc-transaction",
      txCount: 1,
    };
    this.map.set(record.mint, created);
    this.evict();
    return created;
  }

  private evict() {
    const cutoff = Date.now() - CANDIDATE_TTL_MS;
    const expired: string[] = [];
    this.map.forEach((entry, mint) => {
      if (Date.parse(entry.lastSeenAt) < cutoff) expired.push(mint);
    });
    for (const mint of expired) this.map.delete(mint);
    while (this.map.size > CANDIDATE_MAX) {
      const oldest = this.map.keys().next().value;
      if (!oldest) break;
      this.map.delete(oldest);
    }
  }

  recent(limit: number): GrpcCandidate[] {
    this.evict();
    const all = Array.from(this.map.values());
    all.sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
    return all.slice(0, limit);
  }

  size() {
    return this.map.size;
  }
}

const candidates = new CandidateStore();

let status: GrpcStatusKind = "disabled";
let lastError: string | null = null;
let lastEventAt: number | null = null;
let eventsReceived = 0;
const EVENTS_WINDOW_MS = 60_000;
const eventTimestamps: number[] = [];
let activeStreams = 0;
let activeFilterNames: string[] = [];
let started = false;

function eventsPerMinute(): number {
  const now = Date.now();
  while (eventTimestamps.length && eventTimestamps[0] < now - EVENTS_WINDOW_MS) {
    eventTimestamps.shift();
  }
  return eventTimestamps.length;
}

function recordEvent() {
  eventsReceived++;
  const now = Date.now();
  eventTimestamps.push(now);
  lastEventAt = now;
}

function toBase58Maybe(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) {
    try {
      return bs58.encode(value);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    try {
      return bs58.encode(Uint8Array.from(value as number[]));
    } catch {
      return null;
    }
  }
  return null;
}

function extractSignature(info: any): string | null {
  return toBase58Maybe(info?.signature);
}

function extractAccountKeys(info: any): string[] {
  const keys: string[] = [];
  const message = info?.transaction?.message;
  const raw = message?.accountKeys;
  if (Array.isArray(raw)) {
    for (const key of raw) {
      const encoded = toBase58Maybe(key);
      if (encoded) keys.push(encoded);
    }
  }
  const meta = info?.meta;
  if (Array.isArray(meta?.loadedWritableAddresses)) {
    for (const key of meta.loadedWritableAddresses) {
      const encoded = toBase58Maybe(key);
      if (encoded) keys.push(encoded);
    }
  }
  if (Array.isArray(meta?.loadedReadonlyAddresses)) {
    for (const key of meta.loadedReadonlyAddresses) {
      const encoded = toBase58Maybe(key);
      if (encoded) keys.push(encoded);
    }
  }
  return keys;
}

function extractMints(info: any): string[] {
  const mints = new Set<string>();
  const meta = info?.meta;
  const balances = [
    ...(Array.isArray(meta?.preTokenBalances) ? meta.preTokenBalances : []),
    ...(Array.isArray(meta?.postTokenBalances) ? meta.postTokenBalances : []),
  ];
  for (const balance of balances) {
    const mint = typeof balance?.mint === "string" ? balance.mint : null;
    if (mint && !STABLE_BLOCKLIST.has(mint)) mints.add(mint);
  }
  return Array.from(mints);
}

function findWatchedProgram(accountKeys: string[]): { sourceProgramId: string; observedPrograms: string[] } | null {
  const observed: string[] = [];
  let primary: string | null = null;
  for (const key of accountKeys) {
    const name = WATCH_BY_ID.get(key);
    if (name) {
      if (!primary) primary = key;
      if (!observed.includes(name)) observed.push(name);
    }
  }
  if (!primary) return null;
  return { sourceProgramId: primary, observedPrograms: observed };
}

function processTransactionUpdate(update: any) {
  const txWrapper = update?.transaction;
  if (!txWrapper) return;
  const info = txWrapper.transaction;
  if (!info) return;
  if (info.isVote) return;
  if (info.meta?.err) return;

  recordEvent();

  const accountKeys = extractAccountKeys(info);
  if (!accountKeys.length) return;
  const watched = findWatchedProgram(accountKeys);
  if (!watched) return;
  const signature = extractSignature(info);
  if (!signature) return;
  const slot = Number(txWrapper.slot ?? 0);
  const mints = extractMints(info);
  if (!mints.length) return;
  for (const mint of mints) {
    candidates.upsert({
      mint,
      signature,
      slot,
      sourceProgramId: watched.sourceProgramId,
      observedPrograms: watched.observedPrograms,
    });
  }
}

let stopRequested = false;

async function runStreamOnce(endpoint: string, token: string | undefined) {
  const { default: Client } = await import("@triton-one/yellowstone-grpc");
  const ClientCtor = Client as unknown as new (
    endpoint: string,
    xToken: string | undefined,
    options: undefined,
  ) => any;
  const client = new ClientCtor(endpoint, token, undefined);
  await client.connect();
  status = "connected";
  lastError = null;
  const stream = await client.subscribe();
  activeStreams = 1;

  const { filters, filterNames } = buildFilters();
  activeFilterNames = filterNames;

  await new Promise<void>((resolve, reject) => {
    stream.write(
      {
        accounts: {},
        slots: {},
        transactions: filters,
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        accountsDataSlice: [],
        commitment: 1, // confirmed
      },
      (err: Error | null | undefined) => (err ? reject(err) : resolve()),
    );
  });

  let pingTimer: NodeJS.Timeout | null = null;
  let lastPingId = 1;
  pingTimer = setInterval(() => {
    try {
      stream.write(
        {
          accounts: {},
          slots: {},
          transactions: {},
          transactionsStatus: {},
          blocks: {},
          blocksMeta: {},
          entry: {},
          accountsDataSlice: [],
          ping: { id: lastPingId++ },
        },
        () => undefined,
      );
    } catch {
      // ignore — stream errors will surface via 'error' event
    }
  }, KEEPALIVE_MS);

  await new Promise<void>((resolve, reject) => {
    stream.on("data", (update: any) => {
      try {
        if (update?.transaction) {
          processTransactionUpdate(update);
        } else if (update?.ping || update?.pong) {
          // keepalive — count as a tick to update lastEventAt
          if (lastEventAt == null) lastEventAt = Date.now();
        }
      } catch (error) {
        // never let parser errors kill the stream
        // eslint-disable-next-line no-console
        console.error("[grpc] update parse error:", error);
      }
    });
    stream.on("error", (error: Error) => {
      reject(error);
    });
    stream.on("end", () => resolve());
    stream.on("close", () => resolve());
  }).finally(() => {
    if (pingTimer) clearInterval(pingTimer);
    activeStreams = 0;
    try {
      stream.end();
    } catch {
      // ignore
    }
  });
}

async function runStreamLoop(endpoint: string, token: string | undefined) {
  let backoff = RECONNECT_BASE_MS;
  while (!stopRequested) {
    try {
      status = activeStreams ? "connected" : "connecting";
      await runStreamOnce(endpoint, token);
      // stream ended normally — treat as reconnect
      if (!stopRequested) status = "reconnecting";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      status = "reconnecting";
      // eslint-disable-next-line no-console
      console.error(`[grpc] stream error: ${lastError}`);
    }
    if (stopRequested) break;
    const wait = Math.min(backoff, RECONNECT_MAX_MS);
    await new Promise((r) => setTimeout(r, wait));
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  }
  status = stopRequested ? "disabled" : status;
}

export function startGrpcWorker(): { started: boolean; reason?: string } {
  if (started) return { started: true };
  const endpoint = process.env.SVS_GRPC_ENDPOINT?.trim();
  const token = process.env.SVS_GRPC_X_TOKEN?.trim();
  if (!endpoint) {
    status = "disabled";
    return { started: false, reason: "SVS_GRPC_ENDPOINT not set" };
  }
  if (!WATCH_PROGRAMS.length) {
    status = "disabled";
    return { started: false, reason: "no watched programs configured" };
  }
  started = true;
  status = "configured";
  void runStreamLoop(endpoint, token || undefined).catch((error) => {
    lastError = error instanceof Error ? error.message : String(error);
    status = "error";
  });
  return { started: true };
}

export function getGrpcStatus(): GrpcStatus {
  const endpoint = process.env.SVS_GRPC_ENDPOINT?.trim();
  const token = process.env.SVS_GRPC_X_TOKEN?.trim();
  const epm = eventsPerMinute();
  const lastIso = lastEventAt ? new Date(lastEventAt).toISOString() : null;
  const lastAgeSec = lastEventAt ? Math.round((Date.now() - lastEventAt) / 1000) : null;
  return {
    status,
    endpointConfigured: Boolean(endpoint),
    hasToken: Boolean(token),
    activeStreams,
    filters: activeFilterNames,
    lastEventAt: lastIso,
    lastEventAgeSec: lastAgeSec,
    lastError,
    eventsReceived,
    eventsPerMinute: epm,
    candidateCount: candidates.size(),
    watchedPrograms: WATCH_PROGRAMS.map((p) => ({ name: p.name, programId: p.programId })),
  };
}

export function getRecentGrpcCandidates(limit = 30): GrpcCandidate[] {
  return candidates.recent(Math.max(1, Math.min(limit, CANDIDATE_MAX)));
}

export function stopGrpcWorker() {
  stopRequested = true;
}
