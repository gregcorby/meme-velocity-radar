// Solana Vibe Station (SVS) integration helpers.
// Backend-only — never import this module from any client/* code, since it
// reads secret env vars and forwards them in Authorization headers.

const DEFAULT_API_BASE_URL = "https://free.api.solanavibestation.com";
const SVS_TIMEOUT_MS = 8_000;
const SVS_PROBE_TIMEOUT_MS = 3_000;
// Tuned for SVS Ultra (250 r/s). Each mint in a POST body counts as one
// request against the budget. 50% utilisation leaves headroom for
// /api/svs/health probes, per-mint detail endpoints, and provider fuzz.
const BATCH_SIZE = 50;
const SVS_RATE_BUDGET_PER_SEC = 120;
const SVS_RATE_WINDOW_MS = 1_000;
const SVS_RATE_SAFETY_MS = 75;
const SVS_DEFAULT_RETRY_AFTER_MS = 2_500;
const SVS_MAX_RETRY_AFTER_MS = 5_000;
const SVS_MAX_429_RETRIES = 2;
// Cooldown after the SVS API returns an auth-rejected status (401/403). While
// the cooldown is active we short-circuit /metadata, /price, and /mint_info
// calls so the radar stops hammering the API with an invalid key. Probes
// (used by /api/svs/health) skip the cooldown so users can see when the key
// becomes valid again.
const AUTH_REJECTED_COOLDOWN_MS = 5 * 60_000;
let authRejectedUntil = 0;
let lastAuthRejectStatus: number | null = null;

function noteAuthRejected(status: number) {
  authRejectedUntil = Date.now() + AUTH_REJECTED_COOLDOWN_MS;
  lastAuthRejectStatus = status;
}

function inAuthCooldown(): { cooling: boolean; remainingMs: number } {
  const remaining = authRejectedUntil - Date.now();
  return { cooling: remaining > 0, remainingMs: Math.max(0, remaining) };
}

export function getSvsAuthCooldown() {
  const { cooling, remainingMs } = inAuthCooldown();
  return {
    cooling,
    remainingSec: Math.round(remainingMs / 1000),
    lastStatus: lastAuthRejectStatus,
  };
}

export type SvsHealthStatus = "ok" | "degraded" | "error" | "missing";

export type SvsConfig = {
  apiBaseUrl: string;
  hasApiKey: boolean;
  hasRpcHttp: boolean;
  hasRpcWs: boolean;
  hasGrpc: boolean;
};

export function getSvsConfig(): SvsConfig {
  return {
    apiBaseUrl: process.env.SVS_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL,
    hasApiKey: Boolean(process.env.SVS_API_KEY?.trim()),
    hasRpcHttp: Boolean(process.env.SVS_RPC_HTTP_URL?.trim()),
    hasRpcWs: Boolean(process.env.SVS_RPC_WS_URL?.trim()),
    hasGrpc: Boolean(process.env.SVS_GRPC_ENDPOINT?.trim()),
  };
}

// SVS REST API authenticates via `?api_key=` query param (same scheme as their
// RPC endpoint), not an Authorization header. We return JSON content-type
// headers and append the key to the URL via `apiUrl()`.
function apiHeaders() {
  const key = process.env.SVS_API_KEY?.trim();
  if (!key) return null;
  return { "Content-Type": "application/json" } as Record<string, string>;
}

function apiUrl(path: string): string | null {
  const key = process.env.SVS_API_KEY?.trim();
  if (!key) return null;
  const config = getSvsConfig();
  const base = config.apiBaseUrl.replace(/\/+$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${cleanPath}?api_key=${encodeURIComponent(key)}`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = SVS_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type RateReservation = { at: number; cost: number };

const rateReservations: RateReservation[] = [];
let rateQueue = Promise.resolve();
let svsRateLimitedUntil = 0;

function pruneRateReservations(now: number) {
  while (rateReservations.length && now - rateReservations[0].at >= SVS_RATE_WINDOW_MS) {
    rateReservations.shift();
  }
}

async function waitForSvsCapacity(cost: number) {
  const normalizedCost = Math.min(SVS_RATE_BUDGET_PER_SEC, Math.max(1, Math.ceil(cost)));
  const reserve = async () => {
    for (;;) {
      const now = Date.now();
      const rateCooldownMs = svsRateLimitedUntil - now;
      if (rateCooldownMs > 0) {
        await sleep(rateCooldownMs + SVS_RATE_SAFETY_MS);
        continue;
      }

      pruneRateReservations(now);
      const used = rateReservations.reduce((sum, item) => sum + item.cost, 0);
      if (used + normalizedCost <= SVS_RATE_BUDGET_PER_SEC) {
        rateReservations.push({ at: now, cost: normalizedCost });
        return;
      }

      const oldest = rateReservations[0];
      const waitMs = oldest ? oldest.at + SVS_RATE_WINDOW_MS - now + SVS_RATE_SAFETY_MS : SVS_RATE_SAFETY_MS;
      await sleep(Math.max(SVS_RATE_SAFETY_MS, waitMs));
    }
  };

  const next = rateQueue.then(reserve, reserve);
  rateQueue = next.catch(() => undefined);
  await next;
}

function retryAfterMs(response: Response) {
  const header = response.headers.get("retry-after");
  if (!header) return SVS_DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds * 1000, SVS_MAX_RETRY_AFTER_MS));
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) return Math.max(0, Math.min(dateMs - Date.now(), SVS_MAX_RETRY_AFTER_MS));
  return SVS_DEFAULT_RETRY_AFTER_MS;
}

function noteSvsRateLimited(response: Response) {
  const waitMs = retryAfterMs(response);
  svsRateLimitedUntil = Math.max(svsRateLimitedUntil, Date.now() + waitMs);
  return waitMs;
}

function rateLimitedError(response: Response) {
  const waitSec = Math.max(1, Math.ceil(Math.max(0, svsRateLimitedUntil - Date.now()) / 1000));
  return `${response.status} ${response.statusText || "Too Many Requests"} — backing off SVS API for ~${waitSec}s`;
}

export type SvsMetadataRecord = {
  mint?: string;
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
  creator?: string;
  creators?: Array<{ address?: string; share?: number }>;
  uri?: string;
  decimals?: number;
  [key: string]: unknown;
};

export type SvsPriceRecord = {
  mint?: string;
  latest_price?: number;
  avg_price_1min?: number;
  avg_price_15min?: number;
  avg_price_1h?: number;
  volume_1min?: number;
  volume_15min?: number;
  volume_1h?: number;
  volume_24h?: number;
  volume_72h?: number;
  [key: string]: unknown;
};

export type SvsMintInfoRecord = {
  mint?: string;
  description?: string;
  creator?: string;
  authority?: string;
  earlyTrades?: Array<{ slot?: number; signature?: string; type?: string }>;
  [key: string]: unknown;
};

function recordsByMint<T extends { mint?: string }>(items: unknown): Map<string, T> {
  const map = new Map<string, T>();
  if (!items) return map;
  let arr: any[] = [];
  if (Array.isArray(items)) arr = items;
  else if (typeof items === "object") {
    const obj = items as Record<string, unknown>;
    if (Array.isArray((obj as any).data)) arr = (obj as any).data;
    else if (Array.isArray((obj as any).results)) arr = (obj as any).results;
    else {
      // object keyed by mint
      for (const [mint, value] of Object.entries(obj)) {
        if (value && typeof value === "object") {
          map.set(mint, { ...(value as object), mint } as T);
        }
      }
      return map;
    }
  }
  for (const entry of arr) {
    if (!entry || typeof entry !== "object") continue;
    const mint = (entry.mint || entry.address || entry.tokenAddress) as string | undefined;
    if (!mint) continue;
    map.set(mint, { ...(entry as object), mint } as T);
  }
  return map;
}

async function postBatch<T extends { mint?: string }>(
  path: string,
  mints: string[],
): Promise<{ ok: true; map: Map<string, T> } | { ok: false; error: string }> {
  const headers = apiHeaders();
  const url = apiUrl(path);
  if (!headers || !url) return { ok: false, error: "SVS_API_KEY not configured" };
  const cooldown = inAuthCooldown();
  if (cooldown.cooling) {
    return {
      ok: false,
      error: `auth rejected — skipping for ${Math.round(cooldown.remainingMs / 1000)}s (status ${lastAuthRejectStatus ?? "?"})`,
    };
  }
  const merged = new Map<string, T>();
  const doRequest = async (group: string[]) => {
    await waitForSvsCapacity(group.length);
    return fetchWithTimeout(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ mints: group }),
    });
  };
  try {
    for (const group of chunk(mints, BATCH_SIZE)) {
      let response = await doRequest(group);
      for (let attempt = 0; response.status === 429 && attempt < SVS_MAX_429_RETRIES; attempt++) {
        const waitMs = noteSvsRateLimited(response);
        await sleep(waitMs);
        response = await doRequest(group);
      }
      if (response.status === 429) {
        noteSvsRateLimited(response);
        return { ok: false, error: rateLimitedError(response) };
      }
      if (response.status === 401 || response.status === 403) {
        noteAuthRejected(response.status);
        return {
          ok: false,
          error: `auth rejected (${response.status}) — check SVS_API_KEY / API entitlement`,
        };
      }
      if (!response.ok) {
        return { ok: false, error: `${response.status} ${response.statusText}` };
      }
      const json = (await response.json()) as unknown;
      const partial = recordsByMint<T>(json);
      partial.forEach((value, key) => merged.set(key, value));
    }
    return { ok: true, map: merged };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "svs request failed" };
  }
}

// Per-mint TTL caches. Free SVS tier is 10 r/s; without caches we burn the
// budget re-fetching the same mints every snapshot cycle (every 20s). Remove
// or expand TTLs when the SVS plan is upgraded.
type CacheEntry<T> = { data: T; expires: number };

class MintCache<T> {
  private map = new Map<string, CacheEntry<T>>();
  constructor(private ttlMs: number) {}

  get(mint: string): T | undefined {
    const entry = this.map.get(mint);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.map.delete(mint);
      return undefined;
    }
    return entry.data;
  }

  set(mint: string, data: T): void {
    this.map.set(mint, { data, expires: Date.now() + this.ttlMs });
  }
}

const METADATA_TTL_MS = 5 * 60_000; // metadata is essentially static
const PRICE_TTL_MS = 30_000;        // tighter — price changes fast, but 30s keeps us under 10 r/s
const MINT_INFO_TTL_MS = 5 * 60_000; // mint info is static once seen

const metadataCache = new MintCache<SvsMetadataRecord>(METADATA_TTL_MS);
const priceCache = new MintCache<SvsPriceRecord>(PRICE_TTL_MS);
const mintInfoCache = new MintCache<SvsMintInfoRecord>(MINT_INFO_TTL_MS);

export async function fetchSvsMetadata(mints: string[]) {
  if (!mints.length) return { ok: true as const, map: new Map<string, SvsMetadataRecord>() };
  const result = new Map<string, SvsMetadataRecord>();
  const misses: string[] = [];
  for (const mint of mints) {
    const cached = metadataCache.get(mint);
    if (cached) result.set(mint, cached);
    else misses.push(mint);
  }
  if (!misses.length) return { ok: true as const, map: result };
  const fresh = await postBatch<SvsMetadataRecord>("/metadata", misses);
  if (!fresh.ok) return fresh;
  fresh.map.forEach((value, key) => {
    result.set(key, value);
    metadataCache.set(key, value);
  });
  return { ok: true as const, map: result };
}

export async function fetchSvsPrices(mints: string[]) {
  if (!mints.length) return { ok: true as const, map: new Map<string, SvsPriceRecord>() };
  const result = new Map<string, SvsPriceRecord>();
  const misses: string[] = [];
  for (const mint of mints) {
    const cached = priceCache.get(mint);
    if (cached) result.set(mint, cached);
    else misses.push(mint);
  }
  if (!misses.length) return { ok: true as const, map: result };
  const fresh = await postBatch<SvsPriceRecord>("/price", misses);
  if (!fresh.ok) return fresh;
  fresh.map.forEach((value, key) => {
    result.set(key, value);
    priceCache.set(key, value);
  });
  return { ok: true as const, map: result };
}

export async function fetchSvsMintInfo(
  mints: string[],
  concurrency = 3,
): Promise<{ ok: true; map: Map<string, SvsMintInfoRecord> } | { ok: false; error: string }> {
  if (!mints.length) return { ok: true, map: new Map() };
  // Serve cache hits, then fetch only the misses.
  const map = new Map<string, SvsMintInfoRecord>();
  const misses: string[] = [];
  for (const mint of mints) {
    const cached = mintInfoCache.get(mint);
    if (cached) map.set(mint, cached);
    else misses.push(mint);
  }
  if (!misses.length) return { ok: true, map };

  const headers = apiHeaders();
  const url = apiUrl("/mint_info");
  if (!headers || !url) return { ok: false, error: "SVS_API_KEY not configured" };
  const cooldown = inAuthCooldown();
  if (cooldown.cooling) {
    return {
      ok: false,
      error: `auth rejected — skipping for ${Math.round(cooldown.remainingMs / 1000)}s`,
    };
  }
  let cursor = 0;
  let firstError: string | null = null;
  let authRejected = false;
  const reqHeaders = headers;
  const reqUrl = url;
  async function worker() {
    while (cursor < misses.length) {
      if (authRejected) return;
      const idx = cursor++;
      const mint = misses[idx];
      try {
        const doRequest = async () => {
          await waitForSvsCapacity(1);
          return fetchWithTimeout(reqUrl, {
            method: "POST",
            headers: reqHeaders,
            body: JSON.stringify({ mint }),
          });
        };
        let response = await doRequest();
        for (let attempt = 0; response.status === 429 && attempt < SVS_MAX_429_RETRIES; attempt++) {
          const waitMs = noteSvsRateLimited(response);
          await sleep(waitMs);
          response = await doRequest();
        }
        if (response.status === 429) {
          noteSvsRateLimited(response);
          if (!firstError) firstError = rateLimitedError(response);
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          noteAuthRejected(response.status);
          authRejected = true;
          if (!firstError) firstError = `auth rejected (${response.status})`;
          return;
        }
        // /mint_info only serves pump.fun / bonk.fun launches <72h old.
        // 404 = "not eligible", which is normal for most mints — skip silently
        // and cache an empty record so we don't re-ask for 5 min.
        if (response.status === 404) {
          mintInfoCache.set(mint, { mint });
          continue;
        }
        if (!response.ok) {
          if (!firstError) firstError = `${response.status} ${response.statusText}`;
          continue;
        }
        const json = (await response.json()) as SvsMintInfoRecord;
        if (json && typeof json === "object") {
          const record = { ...json, mint };
          map.set(mint, record);
          mintInfoCache.set(mint, record);
        }
      } catch (error) {
        if (!firstError) firstError = error instanceof Error ? error.message : "svs mint_info failed";
      }
    }
  }
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), misses.length) }, worker);
  await Promise.all(workers);
  if (!map.size && firstError) return { ok: false, error: firstError };
  return { ok: true, map };
}

// Solana JSON-RPC helper. Separate from the SVS-API rate limiter because
// Solana RPC has its own budget and most providers tolerate higher RPS.
const SOLANA_RPC_TIMEOUT_MS = 6000;

class RpcNotConfiguredError extends Error {
  constructor() {
    super("SVS_RPC_HTTP_URL not set");
    this.name = "RpcNotConfiguredError";
  }
}

async function callSolanaRpc<T>(method: string, params: unknown[]): Promise<T> {
  const url = process.env.SVS_RPC_HTTP_URL?.trim();
  if (!url) throw new RpcNotConfiguredError();
  const response = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
    SOLANA_RPC_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(`Solana RPC ${method} ${response.status}`);
  }
  const json = (await response.json()) as { result?: T; error?: { message?: string; code?: number } };
  if (json.error) throw new Error(json.error.message ?? `Solana RPC ${method} error`);
  if (json.result === undefined) throw new Error(`Solana RPC ${method} empty result`);
  return json.result;
}

export function isRpcNotConfigured(err: unknown): boolean {
  return err instanceof RpcNotConfiguredError;
}

export type SolanaTokenAmount = {
  amount: string;
  decimals: number;
  uiAmount: number | null;
  uiAmountString?: string;
};

export type LargestAccountEntry = {
  address: string;
  amount: string;
  decimals: number;
  uiAmount: number | null;
  uiAmountString?: string;
};

export async function fetchTokenLargestAccounts(mint: string): Promise<LargestAccountEntry[]> {
  const result = await callSolanaRpc<{ value: LargestAccountEntry[] }>("getTokenLargestAccounts", [
    mint,
    { commitment: "confirmed" },
  ]);
  return result.value ?? [];
}

export async function fetchTokenSupply(mint: string): Promise<SolanaTokenAmount> {
  const result = await callSolanaRpc<{ value: SolanaTokenAmount }>("getTokenSupply", [mint]);
  return result.value;
}

export type SignatureEntry = {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
  confirmationStatus?: string;
};

export async function fetchSignaturesForAddress(mint: string, limit = 25): Promise<SignatureEntry[]> {
  const result = await callSolanaRpc<SignatureEntry[]>("getSignaturesForAddress", [
    mint,
    { limit: Math.min(Math.max(1, limit), 100) },
  ]);
  return result ?? [];
}

export type RpcProbeResult = {
  configured: boolean;
  status: SvsHealthStatus;
  detail: string;
  blockhash?: string;
};

export async function probeRpcReachability(): Promise<RpcProbeResult> {
  const url = process.env.SVS_RPC_HTTP_URL?.trim();
  if (!url) return { configured: false, status: "missing", detail: "SVS_RPC_HTTP_URL not set" };
  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash" }),
      },
      SVS_PROBE_TIMEOUT_MS,
    );
    if (!response.ok) {
      return { configured: true, status: "degraded", detail: `rpc ${response.status}` };
    }
    const json = (await response.json()) as { result?: { value?: { blockhash?: string } }; error?: { message?: string } };
    if (json?.error) {
      return { configured: true, status: "degraded", detail: json.error.message ?? "rpc error" };
    }
    const blockhash = json?.result?.value?.blockhash;
    return {
      configured: true,
      status: "ok",
      detail: blockhash ? "getLatestBlockhash ok" : "rpc reachable",
      blockhash,
    };
  } catch (error) {
    return {
      configured: true,
      status: "degraded",
      detail: error instanceof Error ? error.message : "rpc unreachable",
    };
  }
}

export type SvsApiProbeResult = {
  configured: boolean;
  status: SvsHealthStatus;
  detail: string;
};

// Cache the API probe to avoid hammering /price every time /api/svs/health
// is hit. Without this, dashboards/scripts polling health spend our 10 r/s
// budget probing instead of enriching the radar.
let lastProbeResult: SvsApiProbeResult | null = null;
let lastProbeAt = 0;
const PROBE_CACHE_MS = 30_000;

export async function probeSvsApiReachability(): Promise<SvsApiProbeResult> {
  if (lastProbeResult && Date.now() - lastProbeAt < PROBE_CACHE_MS) {
    return lastProbeResult;
  }
  const result = await runProbe();
  lastProbeResult = result;
  lastProbeAt = Date.now();
  return result;
}

async function runProbe(): Promise<SvsApiProbeResult> {
  const config = getSvsConfig();
  if (!config.hasApiKey) {
    return { configured: false, status: "missing", detail: "SVS_API_KEY not set" };
  }
  // Use SOL native mint as a known-safe probe target.
  const probeMint = "So11111111111111111111111111111111111111112";
  const headers = apiHeaders();
  const url = apiUrl("/price");
  if (!headers || !url) return { configured: false, status: "missing", detail: "SVS_API_KEY not set" };
  try {
    await waitForSvsCapacity(1);
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ mints: [probeMint] }),
      },
      SVS_PROBE_TIMEOUT_MS,
    );
    if (response.status === 429) {
      noteSvsRateLimited(response);
      return { configured: true, status: "degraded", detail: rateLimitedError(response) };
    }
    if (response.status === 401 || response.status === 403) {
      noteAuthRejected(response.status);
      return {
        configured: true,
        status: "error",
        detail: `auth rejected (${response.status}) — check SVS_API_KEY / API entitlement; falling back to DexScreener`,
      };
    }
    if (!response.ok) {
      // 404/422 is still "configured" — endpoint reachable, just not happy with probe.
      return { configured: true, status: "degraded", detail: `api ${response.status}` };
    }
    return { configured: true, status: "ok", detail: "/price probe ok" };
  } catch (error) {
    return {
      configured: true,
      status: "degraded",
      detail: error instanceof Error ? error.message : "api unreachable",
    };
  }
}

export type SvsHealthReport = {
  apiBaseUrl: string;
  api: { configured: boolean; status: SvsHealthStatus; detail: string };
  rpc: { configured: boolean; status: SvsHealthStatus; detail: string };
  grpc: { configured: boolean; status: SvsHealthStatus; detail: string };
  authCooldown: { cooling: boolean; remainingSec: number; lastStatus: number | null };
  overall: SvsHealthStatus;
  checkedAt: string;
};

function combineStatus(parts: SvsHealthStatus[]): SvsHealthStatus {
  if (parts.some((p) => p === "ok")) {
    if (parts.some((p) => p === "error" || p === "degraded")) return "degraded";
    return "ok";
  }
  if (parts.every((p) => p === "missing")) return "missing";
  if (parts.some((p) => p === "error")) return "error";
  return "degraded";
}

export async function getSvsHealthReport(): Promise<SvsHealthReport> {
  const config = getSvsConfig();
  const [api, rpc] = await Promise.all([probeSvsApiReachability(), probeRpcReachability()]);
  const grpc = config.hasGrpc
    ? { configured: true, status: "ok" as SvsHealthStatus, detail: "endpoint configured" }
    : { configured: false, status: "missing" as SvsHealthStatus, detail: "SVS_GRPC_ENDPOINT not set" };
  const overall = combineStatus([api.status, rpc.status, grpc.status]);
  return {
    apiBaseUrl: config.apiBaseUrl,
    api,
    rpc,
    grpc,
    authCooldown: getSvsAuthCooldown(),
    overall,
    checkedAt: new Date().toISOString(),
  };
}
