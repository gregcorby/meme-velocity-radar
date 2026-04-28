// Solana Vibe Station (SVS) integration helpers.
// Backend-only — never import this module from any client/* code, since it
// reads secret env vars and forwards them in Authorization headers.

const DEFAULT_API_BASE_URL = "https://free.api.solanavibestation.com";
const SVS_TIMEOUT_MS = 8_000;
const SVS_PROBE_TIMEOUT_MS = 3_000;
const BATCH_SIZE = 36;
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

function authHeaders() {
  const key = process.env.SVS_API_KEY?.trim();
  if (!key) return null;
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } as Record<string, string>;
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

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
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
  const headers = authHeaders();
  if (!headers) return { ok: false, error: "SVS_API_KEY not configured" };
  const cooldown = inAuthCooldown();
  if (cooldown.cooling) {
    return {
      ok: false,
      error: `auth rejected — skipping for ${Math.round(cooldown.remainingMs / 1000)}s (status ${lastAuthRejectStatus ?? "?"})`,
    };
  }
  const config = getSvsConfig();
  const merged = new Map<string, T>();
  try {
    for (const group of chunk(mints, BATCH_SIZE)) {
      const response = await fetchWithTimeout(`${config.apiBaseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ mints: group }),
      });
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

export async function fetchSvsMetadata(mints: string[]) {
  if (!mints.length) return { ok: true as const, map: new Map<string, SvsMetadataRecord>() };
  return postBatch<SvsMetadataRecord>("/metadata", mints);
}

export async function fetchSvsPrices(mints: string[]) {
  if (!mints.length) return { ok: true as const, map: new Map<string, SvsPriceRecord>() };
  return postBatch<SvsPriceRecord>("/price", mints);
}

export async function fetchSvsMintInfo(
  mints: string[],
  concurrency = 3,
): Promise<{ ok: true; map: Map<string, SvsMintInfoRecord> } | { ok: false; error: string }> {
  if (!mints.length) return { ok: true, map: new Map() };
  const headers = authHeaders();
  if (!headers) return { ok: false, error: "SVS_API_KEY not configured" };
  const cooldown = inAuthCooldown();
  if (cooldown.cooling) {
    return {
      ok: false,
      error: `auth rejected — skipping for ${Math.round(cooldown.remainingMs / 1000)}s`,
    };
  }
  const config = getSvsConfig();
  const map = new Map<string, SvsMintInfoRecord>();
  let cursor = 0;
  let firstError: string | null = null;
  let authRejected = false;
  const reqHeaders = headers;
  async function worker() {
    while (cursor < mints.length) {
      if (authRejected) return;
      const idx = cursor++;
      const mint = mints[idx];
      try {
        const response = await fetchWithTimeout(`${config.apiBaseUrl}/mint_info`, {
          method: "POST",
          headers: reqHeaders,
          body: JSON.stringify({ mint }),
        });
        if (response.status === 401 || response.status === 403) {
          noteAuthRejected(response.status);
          authRejected = true;
          if (!firstError) firstError = `auth rejected (${response.status})`;
          return;
        }
        if (!response.ok) {
          if (!firstError) firstError = `${response.status} ${response.statusText}`;
          continue;
        }
        const json = (await response.json()) as SvsMintInfoRecord;
        if (json && typeof json === "object") {
          map.set(mint, { ...json, mint });
        }
      } catch (error) {
        if (!firstError) firstError = error instanceof Error ? error.message : "svs mint_info failed";
      }
    }
  }
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), mints.length) }, worker);
  await Promise.all(workers);
  if (!map.size && firstError) return { ok: false, error: firstError };
  return { ok: true, map };
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

export async function probeSvsApiReachability(): Promise<SvsApiProbeResult> {
  const config = getSvsConfig();
  if (!config.hasApiKey) {
    return { configured: false, status: "missing", detail: "SVS_API_KEY not set" };
  }
  // Use SOL native mint as a known-safe probe target.
  const probeMint = "So11111111111111111111111111111111111111112";
  const headers = authHeaders();
  if (!headers) return { configured: false, status: "missing", detail: "SVS_API_KEY not set" };
  try {
    const response = await fetchWithTimeout(
      `${config.apiBaseUrl}/price`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ mints: [probeMint] }),
      },
      SVS_PROBE_TIMEOUT_MS,
    );
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
