import type { Express } from "express";
import type { Server } from "node:http";
import { storage } from "./storage";
import type { MetaSignal, RadarSnapshot, TokenSignal } from "@shared/schema";
import {
  fetchSvsMetadata,
  fetchSvsMintInfo,
  fetchSvsPrices,
  fetchTokenLargestAccounts,
  fetchTokenSupply,
  fetchSignaturesForAddress,
  getSvsConfig,
  getSvsHealthReport,
  isRpcNotConfigured,
  type LargestAccountEntry,
  type SignatureEntry,
  type SvsMetadataRecord,
  type SvsMintInfoRecord,
  type SvsPriceRecord,
} from "./svs";
import {
  getGrpcStatus,
  getRecentGrpcCandidates,
  type GrpcCandidate,
} from "./grpcStream";
import { emit as emitFeed, recent as feedRecent, subscribe as feedSubscribe } from "./feed";

type DexLink = { type?: string; label?: string; url?: string };
type TokenProfile = {
  url?: string;
  chainId?: string;
  tokenAddress?: string;
  description?: string;
  icon?: string;
  header?: string;
  openGraph?: string;
  links?: DexLink[];
  totalAmount?: number;
  amount?: number;
  updatedAt?: string;
  cto?: boolean;
};

type DexPair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  txns?: Record<string, { buys?: number; sells?: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    header?: string;
    openGraph?: string;
    websites?: Array<{ url?: string; label?: string }>;
    socials?: Array<{ url?: string; type?: string }>;
  };
  boosts?: { active?: number };
};

type DexMeta = {
  name?: string;
  slug?: string;
  description?: string;
  icon?: { type?: string; value?: string };
  marketCap?: number;
  liquidity?: number;
  volume?: number;
  tokenCount?: number;
  marketCapChange?: Record<string, number>;
};

const DEX = "https://api.dexscreener.com";
// Tuned for SVS Ultra (250 r/s). DexScreener is the remaining bottleneck —
// keep CACHE_MS / REFRESH_SECONDS ≥ 5s so pair-fetch waves stay under
// DexScreener's ~5 r/s public limit. Going lower will trigger 429s.
const CACHE_MS = 5_000;
const REFRESH_SECONDS = 5;
const MAX_CANDIDATES = 30;
const DEX_FEED_TIMEOUT_MS = 4_000;
const DEX_PAIR_TIMEOUT_MS = 3_500;
const DEX_HARD_DEADLINE_GRACE_MS = 1_000;
const PAIR_FETCH_CONCURRENCY = MAX_CANDIDATES;
const SVS_ENRICHMENT_CANDIDATE_LIMIT = 24;
const SVS_METADATA_BUDGET_MS = 2_500;
const SVS_PRICE_BUDGET_MS = 2_500;
const SVS_MINT_INFO_LIMIT = 8;
const SVS_MINT_INFO_BUDGET_MS = 1_250;
const BUILD_DEADLINE_RESERVE_MS = 1_500;
// Hard cap on the total time /api/radar will spend building a snapshot. If
// fetches are slow or the event loop is starved, we return whatever we have
// (or the last good snapshot) instead of hanging the request for minutes.
const RADAR_BUILD_DEADLINE_MS = 12_000;
const HEALTH_DEADLINE_MS = 6_000;
let memoryCache: { expires: number; snapshot: RadarSnapshot } | null = null;
let lastGoodSnapshot: RadarSnapshot | null = null;
let inflightSnapshot: Promise<RadarSnapshot> | null = null;

function withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        resolve(onTimeout());
      } catch {
        resolve(onTimeout());
      }
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(onTimeout());
      },
    );
  });
}

function clamp(value: number, min = 0, max = 100) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function n(value: unknown, fallback = 0) {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : fallback;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function compactUrlLabel(url: string) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host.replace("x.com", "X").replace("twitter.com", "X");
  } catch {
    return null;
  }
}

async function fetchJson<T>(path: string, label: string, timeoutMs = 6_000): Promise<{ ok: true; data: T } | { ok: false; error: string; label: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }, timeoutMs);
  const start = Date.now();
  // Wrap the fetch in a hard deadline to defend against event-loop starvation
  // where the AbortController's setTimeout might be delayed past the timeout.
  const hardDeadline = new Promise<{ ok: false; error: string; label: string }>((resolve) => {
    setTimeout(
      () => resolve({ ok: false, error: `hard deadline ${timeoutMs + DEX_HARD_DEADLINE_GRACE_MS}ms`, label }),
      timeoutMs + DEX_HARD_DEADLINE_GRACE_MS,
    );
  });
  try {
    const result = await Promise.race([
      (async () => {
        try {
          const response = await fetch(`${DEX}${path}`, {
            signal: controller.signal,
            headers: { "User-Agent": "meme-velocity-radar/1.0" },
          });
          if (!response.ok) {
            return { ok: false as const, error: `${response.status} ${response.statusText}`, label };
          }
          return { ok: true as const, data: (await response.json()) as T };
        } catch (error) {
          return { ok: false as const, error: error instanceof Error ? error.message : "unknown fetch error", label };
        }
      })(),
      hardDeadline,
    ]);
    const ms = Date.now() - start;
    const count = result.ok && Array.isArray(result.data) ? (result.data as unknown[]).length : undefined;
    emitFeed({
      stage: "dex.fetch",
      summary: `${label} · ${ms}ms · ${result.ok ? `ok${count != null ? ` · ${count} items` : ""}` : `err: ${result.error}`}`,
      path,
      label,
      ms,
      ok: result.ok,
      status: result.ok ? undefined : result.error,
      count,
    });
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function mapPool<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = items[index++];
      results.push(await mapper(current));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

type SvsMapResult<T extends { mint?: string }> =
  | { ok: true; map: Map<string, T> }
  | { ok: false; error: string };

function remainingBuildBudgetMs(started: number, reserveMs = BUILD_DEADLINE_RESERVE_MS) {
  return Math.max(0, RADAR_BUILD_DEADLINE_MS - (Date.now() - started) - reserveMs);
}

async function withSvsBuildBudget<T extends { mint?: string }>(
  label: string,
  started: number,
  budgetMs: number,
  work: () => Promise<SvsMapResult<T>>,
): Promise<SvsMapResult<T>> {
  const ms = Math.min(budgetMs, remainingBuildBudgetMs(started));
  if (ms <= 0) {
    return { ok: false, error: `${label} skipped — radar build budget exhausted` };
  }

  return Promise.race([
    work(),
    new Promise<SvsMapResult<T>>((resolve) => {
      setTimeout(() => resolve({ ok: false, error: `${label} skipped after ${ms}ms radar budget` }), ms);
    }),
  ]);
}

function getTxns(pair: DexPair, window: "m5" | "h1" | "h6" | "h24") {
  const tx = pair.txns?.[window] ?? {};
  return { buys: n(tx.buys), sells: n(tx.sells) };
}

function getVolume(pair: DexPair, window: "m5" | "h1" | "h6" | "h24") {
  return n(pair.volume?.[window]);
}

function getChange(pair: DexPair, window: "m5" | "h1" | "h6" | "h24") {
  return n(pair.priceChange?.[window]);
}

function logNorm(value: number, max: number) {
  return clamp((Math.log10(value + 1) / Math.log10(max + 1)) * 100);
}

function firstSentence(text: string) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const match = cleaned.match(/^(.{30,220}?[.!?])\s/);
  return match?.[1] ?? cleaned.slice(0, 180);
}

function classifyMeme(name: string, symbol: string, description: string) {
  const corpus = `${name} ${symbol} ${description}`.toLowerCase();
  const checks: Array<[RegExp, string, string]> = [
    [/(pepe|frog|kermit|toad|tepe)/, "Pepe / frog derivative", "A frog-coded remix with built-in recognition from the Pepe family tree."],
    [/(doge|dog|shib|inu|bonk|wif|puppy|pitbull)/, "Dog coin lineage", "A dog mascot coin using the oldest memecoin reflex: instantly readable animal identity."],
    [/(cat|michi|kitty|kitten|popcat|meow)/, "Cat mascot", "A cat meme where shareability comes from simple character art and reaction-image potential."],
    [/(elon|trump|biden|vitalik|cz|tate|kanye|saylor)/, "Personality parody", "A public-figure riff that trades on recognition, controversy, and fast remixability."],
    [/(ai|grok|robot|agent|openai|claude|deepseek)/, "AI meta", "A token riding the AI narrative rather than a single legacy meme character."],
    [/(wojak|chad|cope|based|npc|goblin)/, "Crypto-native reaction meme", "A reaction-face or crypto-culture archetype built for timeline jokes."],
    [/(china|chinese|币|狗|猫|龙|救命)/, "China / language meta", "A language and regional-meme play that can spread through novelty and community in-jokes."],
    [/(fart|poop|butt|piss|brainrot|retard|idiot)/, "Absurdist brainrot", "Shock-value internet nonsense; easy to repeat, risky to hold."],
    [/(cto|community takeover)/, "Community takeover", "The meme story is less the character and more the community trying to revive or own it."],
  ];

  for (const [regex, type, decode] of checks) {
    if (regex.test(corpus)) return { type, decode };
  }

  return {
    type: "Fresh ticker meme",
    decode: description
      ? "A newly seeded ticker narrative. The meme has to be inferred from its copy and social links until the community standardizes the joke."
      : "A very early token with sparse metadata. Treat the meme as unproven until social posts make the joke obvious.",
  };
}

function buildLinks(profile?: TokenProfile, pair?: DexPair) {
  const links = new Map<string, { type: string; label: string | null; url: string }>();
  function add(type: string, url?: string, label?: string | null) {
    if (!url || !/^https?:\/\//.test(url)) return;
    links.set(url, { type, label: label ?? compactUrlLabel(url), url });
  }
  profile?.links?.forEach((link) => add(link.type ?? "link", link.url, link.label ?? null));
  pair?.info?.websites?.forEach((site) => add("website", site.url, site.label ?? "Website"));
  pair?.info?.socials?.forEach((social) => add(social.type ?? "social", social.url, null));
  if (pair?.url) add("dexscreener", pair.url, "DexScreener");
  if (profile?.url) add("profile", profile.url, "Profile");
  return Array.from(links.values());
}

type SvsEnrichment = {
  metadata?: SvsMetadataRecord;
  price?: SvsPriceRecord;
  mintInfo?: SvsMintInfoRecord;
};

function scorePair(pair: DexPair, profile?: TokenProfile, svs: SvsEnrichment = {}): TokenSignal | null {
  const tokenAddress = safeString(profile?.tokenAddress || pair.baseToken?.address);
  const pairAddress = safeString(pair.pairAddress);
  if (!tokenAddress || !pairAddress) return null;

  const svsDescription = safeString(svs.metadata?.description) || safeString(svs.mintInfo?.description);
  const description = safeString(profile?.description) || svsDescription;
  const name = safeString(pair.baseToken?.name, "") || safeString(svs.metadata?.name, "Unknown") || "Unknown";
  const symbol = safeString(pair.baseToken?.symbol, "") || safeString(svs.metadata?.symbol, "???") || "???";
  const txM5 = getTxns(pair, "m5");
  const txH1 = getTxns(pair, "h1");
  const txH6 = getTxns(pair, "h6");
  const txH24 = getTxns(pair, "h24");
  const m5Tx = txM5.buys + txM5.sells;
  const h1Tx = txH1.buys + txH1.sells;
  const dexM5Vol = getVolume(pair, "m5");
  const dexH1Vol = getVolume(pair, "h1");
  const dexH6Vol = getVolume(pair, "h6");
  const dexH24Vol = getVolume(pair, "h24");
  // SVS price/volume payload — windows mapped to existing m5/h1/h6/h24 buckets.
  const svsVol1m = n(svs.price?.volume_1min);
  const svsVol15m = n(svs.price?.volume_15min);
  const svsVol1h = n(svs.price?.volume_1h);
  const svsVol24h = n(svs.price?.volume_24h);
  const m5Vol = svsVol15m > 0 ? svsVol15m / 3 : svsVol1m > 0 ? svsVol1m * 5 : dexM5Vol;
  const h1Vol = svsVol1h > 0 ? svsVol1h : dexH1Vol;
  const h6Vol = svsVol24h > 0 ? svsVol24h / 4 : dexH6Vol;
  const h24Vol = svsVol24h > 0 ? svsVol24h : dexH24Vol;
  const liquidityUsd = n(pair.liquidity?.usd);
  const marketCap = n(pair.marketCap || pair.fdv, 0) || null;
  const dexPriceUsd = n(pair.priceUsd, NaN);
  const svsPriceUsd = n(svs.price?.latest_price, NaN);
  const priceUsd = Number.isFinite(svsPriceUsd) && svsPriceUsd > 0 ? svsPriceUsd : dexPriceUsd;
  const pairAgeMinutes = pair.pairCreatedAt ? Math.max(0, (Date.now() - pair.pairCreatedAt) / 60_000) : null;
  const volumeAcceleration = h1Vol > 0 ? (m5Vol * 12) / h1Vol : m5Vol > 0 ? 4 : 0;
  const txnAcceleration = h1Tx > 0 ? (m5Tx * 12) / h1Tx : m5Tx > 0 ? 4 : 0;
  const buyPressureM5 = m5Tx > 0 ? txM5.buys / m5Tx : 0.5;
  const buyPressureH1 = h1Tx > 0 ? txH1.buys / h1Tx : 0.5;
  const boostAmount = n(profile?.amount ?? pair.boosts?.active);
  const boostTotalAmount = n(profile?.totalAmount ?? pair.boosts?.active);
  const links = buildLinks(profile, pair);
  const socialCount = links.filter((link) => ["twitter", "telegram", "discord", "social", "x"].includes(link.type.toLowerCase()) || /x\.com|twitter|t\.me|discord/i.test(link.url)).length;
  const hasProfile = Boolean(description || profile?.icon || pair.info?.imageUrl);
  const { type: memeType, decode } = classifyMeme(name, symbol, description);
  const story = firstSentence(description);

  const velocity =
    logNorm(m5Vol, 75_000) * 0.2 +
    clamp((volumeAcceleration / 3) * 100) * 0.22 +
    clamp((txnAcceleration / 3) * 100) * 0.18 +
    clamp((buyPressureM5 - 0.45) * 220) * 0.12 +
    clamp((getChange(pair, "h1") / 140) * 100) * 0.16 +
    clamp((getChange(pair, "m5") / 25) * 100) * 0.07 +
    clamp((liquidityUsd / 45_000) * 100) * 0.05;

  const descriptionSignal = clamp((description.length / 260) * 100);
  const virality =
    clamp((boostAmount / 30) * 100) * 0.22 +
    clamp((socialCount / 3) * 100) * 0.24 +
    descriptionSignal * 0.16 +
    (hasProfile ? 16 : 0) +
    (memeType === "Fresh ticker meme" ? 8 : 18) +
    clamp((h1Tx / 900) * 100) * 0.12;

  const cap = marketCap ?? n(pair.fdv);
  const capHeadroom =
    cap <= 0 ? 35 : cap < 50_000 ? 72 : cap < 250_000 ? 88 : cap < 1_500_000 ? 78 : cap < 8_000_000 ? 58 : 30;
  const liquidityHealth = liquidityUsd < 8_000 ? liquidityUsd / 120 : liquidityUsd < 80_000 ? 68 + liquidityUsd / 4_000 : 88;
  const ageScore = pairAgeMinutes == null ? 45 : pairAgeMinutes < 8 ? 35 : pairAgeMinutes < 90 ? 90 : pairAgeMinutes < 720 ? 70 : 45;
  const upside =
    velocity * 0.34 +
    virality * 0.2 +
    capHeadroom * 0.16 +
    clamp(liquidityHealth) * 0.12 +
    clamp((buyPressureH1 - 0.44) * 210) * 0.1 +
    ageScore * 0.08;

  const riskFlags: string[] = [];
  if (liquidityUsd < 10_000) riskFlags.push("thin liquidity");
  if (buyPressureH1 < 0.46) riskFlags.push("sell pressure");
  if (getChange(pair, "m5") < -8) riskFlags.push("5m reversal");
  if (boostAmount > 0 && socialCount === 0) riskFlags.push("boosted, no socials");
  if (pairAgeMinutes != null && pairAgeMinutes < 12) riskFlags.push("new pair");
  if (description.length < 20) riskFlags.push("sparse meme story");

  const opportunityFlags: string[] = [];
  if (volumeAcceleration > 1.8) opportunityFlags.push("5m volume acceleration");
  if (txnAcceleration > 1.5) opportunityFlags.push("trade count ramping");
  if (buyPressureM5 > 0.56) opportunityFlags.push("buyers leading");
  if (boostAmount > 0) opportunityFlags.push("paid attention boost");
  if (socialCount > 0) opportunityFlags.push("social surface exists");
  if (cap && cap < 350_000 && liquidityUsd > 15_000) opportunityFlags.push("low-cap with usable liquidity");

  const risk =
    (liquidityUsd < 10_000 ? 24 : liquidityUsd < 25_000 ? 12 : 3) +
    (buyPressureH1 < 0.48 ? 18 : 4) +
    (getChange(pair, "m5") < -6 ? 18 : 0) +
    (description.length < 20 ? 12 : 0) +
    (pairAgeMinutes != null && pairAgeMinutes < 10 ? 14 : 0) +
    (boostAmount > 0 && socialCount === 0 ? 12 : 0);

  const final = clamp(upside * 0.54 + velocity * 0.3 + virality * 0.22 - risk * 0.18);
  const scoreValues = {
    velocity: Math.round(clamp(velocity)),
    virality: Math.round(clamp(virality)),
    upside: Math.round(clamp(upside)),
    risk: Math.round(clamp(risk)),
    final: Math.round(final),
  };

  const viralityThesis = socialCount
    ? `${socialCount} social surface${socialCount > 1 ? "s" : ""}, ${boostAmount ? `${boostAmount} active boost units, ` : ""}${memeType.toLowerCase()} hook.`
    : `${boostAmount ? "Boosted but" : "Early and"} still weak on social proof.`;
  const upsideThesis = `${volumeAcceleration.toFixed(1)}x 5m volume pace, ${(buyPressureH1 * 100).toFixed(0)}% h1 buy pressure, ${cap ? `$${Math.round(cap).toLocaleString()} cap` : "unknown cap"}.`;
  const dangerNote = riskFlags.length ? riskFlags.slice(0, 3).join(", ") : "No major scanner flags, but memecoin risk remains extreme.";

  return {
    id: `${tokenAddress}-${pairAddress}`,
    chainId: safeString(pair.chainId, "solana"),
    tokenAddress,
    pairAddress,
    dexId: safeString(pair.dexId, "unknown"),
    url: safeString(pair.url || profile?.url),
    name,
    symbol,
    imageUrl: safeString(pair.info?.imageUrl || profile?.icon || null) || null,
    headerUrl: safeString(pair.info?.header || profile?.header || profile?.openGraph || null) || null,
    description,
    memeType,
    memeDecode: story ? `${decode} Metadata lead: “${story}”` : decode,
    viralityThesis,
    upsideThesis,
    dangerNote,
    priceUsd: Number.isFinite(priceUsd) ? priceUsd : null,
    marketCap,
    fdv: n(pair.fdv, 0) || null,
    liquidityUsd,
    pairAgeMinutes: pairAgeMinutes == null ? null : Math.round(pairAgeMinutes),
    volume: { m5: m5Vol, h1: h1Vol, h6: h6Vol, h24: h24Vol },
    priceChange: { m5: getChange(pair, "m5"), h1: getChange(pair, "h1"), h6: getChange(pair, "h6"), h24: getChange(pair, "h24") },
    txns: { m5: txM5, h1: txH1, h6: txH6, h24: txH24 },
    boostAmount,
    boostTotalAmount,
    buyPressureM5,
    buyPressureH1,
    volumeAcceleration,
    txnAcceleration,
    sourceTags: [
      profile?.amount ? "boosts/latest" : "profiles/latest",
      pair.dexId ? `${pair.dexId}` : "dex",
      profile?.cto ? "cto" : "",
      svs.metadata ? "svs-metadata" : "",
      svs.price ? "svs-price" : "",
      svs.mintInfo ? "svs-mint-info" : "",
    ].filter(Boolean),
    links,
    riskFlags,
    opportunityFlags,
    scores: scoreValues,
  };
}

function buildGrpcOnlyToken(
  candidate: GrpcCandidate,
  meta: SvsMetadataRecord | undefined,
  price: SvsPriceRecord | undefined,
): TokenSignal {
  const name = safeString(meta?.name) || `grpc:${candidate.mint.slice(0, 4)}…${candidate.mint.slice(-4)}`;
  const symbol = safeString(meta?.symbol) || "???";
  const description = safeString(meta?.description);
  const { type: memeType, decode } = classifyMeme(name, symbol, description);
  const story = firstSentence(description);
  const priceUsd = n(price?.latest_price, NaN);
  const m5Vol = n(price?.volume_15min) > 0 ? n(price?.volume_15min) / 3 : n(price?.volume_1min) * 5;
  const h1Vol = n(price?.volume_1h);
  const h6Vol = n(price?.volume_24h) > 0 ? n(price?.volume_24h) / 4 : 0;
  const h24Vol = n(price?.volume_24h);
  const ageMinutes = Math.max(0, (Date.now() - Date.parse(candidate.firstSeenAt)) / 60_000);
  const sourceTags = Array.from(
    new Set([...candidate.sourceTags, meta ? "svs-metadata" : "", price ? "svs-price" : ""].filter(Boolean)),
  );
  const opportunityFlags = ["grpc live tx", `grpc source: ${candidate.source}`];
  if (candidate.txCount > 1) opportunityFlags.push(`${candidate.txCount} grpc txs`);
  if (candidate.launchEvent) {
    opportunityFlags.push(`${candidate.launchEvent.protocol}:${candidate.launchEvent.instruction}`);
    opportunityFlags.push(`event ${candidate.launchEvent.type}`);
  }
  if (candidate.creatorWallet) {
    opportunityFlags.push(`creator ${candidate.creatorWallet.slice(0, 4)}…${candidate.creatorWallet.slice(-4)}`);
  }
  const riskFlags = ["pre-dex or no pair yet", "grpc-only early signal"];
  if (!meta) riskFlags.push("no svs metadata");
  if (!price) riskFlags.push("no svs price");

  // Conservative scoring: gRPC-only signals can never dominate the ranking.
  const velocity = clamp(20 + Math.min(candidate.txCount, 8) * 4);
  const virality = clamp(description ? 25 : 12);
  const upside = clamp(20 + (price ? 8 : 0) + (meta ? 6 : 0));
  const risk = clamp(45 + (meta ? 0 : 6) + (price ? 0 : 6));
  const final = clamp(upside * 0.4 + velocity * 0.3 + virality * 0.2 - risk * 0.2);

  const links: TokenSignal["links"] = [];
  if (meta?.uri && /^https?:\/\//.test(meta.uri)) {
    links.push({ type: "metadata", label: "metadata uri", url: meta.uri });
  }
  if (typeof meta?.image === "string" && /^https?:\/\//.test(meta.image)) {
    links.push({ type: "image", label: "image", url: meta.image });
  }

  return {
    id: `grpc-${candidate.mint}`,
    chainId: "solana",
    tokenAddress: candidate.mint,
    pairAddress: "",
    dexId: candidate.source,
    url: "",
    name,
    symbol,
    imageUrl: typeof meta?.image === "string" ? meta.image : null,
    headerUrl: null,
    description,
    memeType,
    memeDecode: story
      ? `${decode} Metadata lead: “${story}”`
      : `${decode} (Surfaced from live gRPC tx on ${candidate.source} before a DEX pair appeared.)`,
    viralityThesis: description
      ? `Has metadata; ${candidate.txCount} live gRPC tx${candidate.txCount > 1 ? "s" : ""} on ${candidate.source}.`
      : `No metadata yet; only ${candidate.txCount} live gRPC tx${candidate.txCount > 1 ? "s" : ""} on ${candidate.source}.`,
    upsideThesis: `Pre-DEX surface: liquidity/marketCap unknown. Treat as a watchlist seed, not a buy signal.`,
    dangerNote: "gRPC-only early signal. No DexScreener pair, no liquidity verified, narrative may not exist yet.",
    priceUsd: Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null,
    marketCap: null,
    fdv: null,
    liquidityUsd: 0,
    pairAgeMinutes: Math.round(ageMinutes),
    volume: { m5: m5Vol, h1: h1Vol, h6: h6Vol, h24: h24Vol },
    priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 },
    txns: {
      m5: { buys: 0, sells: 0 },
      h1: { buys: 0, sells: 0 },
      h6: { buys: 0, sells: 0 },
      h24: { buys: 0, sells: 0 },
    },
    boostAmount: 0,
    boostTotalAmount: 0,
    buyPressureM5: 0.5,
    buyPressureH1: 0.5,
    volumeAcceleration: 0,
    txnAcceleration: 0,
    sourceTags,
    links,
    riskFlags,
    opportunityFlags,
    scores: {
      velocity: Math.round(velocity),
      virality: Math.round(virality),
      upside: Math.round(upside),
      risk: Math.round(risk),
      final: Math.round(final),
    },
    creatorWallet: candidate.creatorWallet,
    launchEvent: candidate.launchEvent
      ? {
          type: candidate.launchEvent.type,
          protocol: candidate.launchEvent.protocol,
          instruction: candidate.launchEvent.instruction,
          signature: candidate.launchEvent.signature,
          slot: candidate.launchEvent.slot,
        }
      : null,
  };
}

function normalizeMeta(meta: DexMeta): MetaSignal {
  return {
    name: safeString(meta.name, "Unknown meta"),
    slug: safeString(meta.slug, "unknown"),
    description: safeString(meta.description),
    icon: safeString(meta.icon?.value, "◇"),
    marketCap: n(meta.marketCap),
    liquidity: n(meta.liquidity),
    volume: n(meta.volume),
    tokenCount: n(meta.tokenCount),
    marketCapChange: {
      m5: n(meta.marketCapChange?.m5),
      h1: n(meta.marketCapChange?.h1),
      h6: n(meta.marketCapChange?.h6),
      h24: n(meta.marketCapChange?.h24),
    },
  };
}

async function buildSnapshot(force = false): Promise<RadarSnapshot> {
  if (!force && memoryCache && memoryCache.expires > Date.now()) return memoryCache.snapshot;

  const started = Date.now();
  const [boostsResult, profilesResult, updatesResult, metasResult] = await Promise.all([
    fetchJson<TokenProfile[]>("/token-boosts/latest/v1", "boosts", DEX_FEED_TIMEOUT_MS),
    fetchJson<TokenProfile[]>("/token-profiles/latest/v1", "profiles", DEX_FEED_TIMEOUT_MS),
    fetchJson<TokenProfile[]>("/token-profiles/recent-updates/v1", "profile updates", DEX_FEED_TIMEOUT_MS),
    fetchJson<DexMeta[]>("/metas/trending/v1", "metas", DEX_FEED_TIMEOUT_MS),
  ]);

  const sourceHealth: RadarSnapshot["sourceHealth"] = [];
  const boosts = boostsResult.ok ? boostsResult.data : [];
  const profiles = profilesResult.ok ? profilesResult.data : [];
  const updates = updatesResult.ok ? updatesResult.data : [];
  const metas = metasResult.ok ? metasResult.data : [];
  [
    ["token boosts", boostsResult],
    ["token profiles", profilesResult],
    ["profile updates", updatesResult],
    ["trending metas", metasResult],
  ].forEach(([name, result]) => {
    const typed = result as typeof boostsResult;
    sourceHealth.push({
      name: name as string,
      status: typed.ok ? "ok" : "error",
      detail: typed.ok ? "fresh response" : typed.error,
    });
  });

  const profileByAddress = new Map<string, TokenProfile>();
  [...boosts, ...profiles, ...updates].forEach((profile) => {
    if (profile.chainId === "solana" && profile.tokenAddress) {
      const existing = profileByAddress.get(profile.tokenAddress);
      profileByAddress.set(profile.tokenAddress, {
        ...existing,
        ...profile,
        description: profile.description || existing?.description || "",
        links: [...(existing?.links ?? []), ...(profile.links ?? [])],
        amount: Math.max(n(existing?.amount), n(profile.amount)),
        totalAmount: Math.max(n(existing?.totalAmount), n(profile.totalAmount)),
      });
    }
  });

  const grpcCandidatesRaw = getRecentGrpcCandidates(40);
  const grpcCandidateByMint = new Map<string, GrpcCandidate>();
  for (const candidate of grpcCandidatesRaw) {
    grpcCandidateByMint.set(candidate.mint, candidate);
  }
  const grpcMints = grpcCandidatesRaw.map((entry) => entry.mint);

  const prioritizedCandidates = [
    ...grpcMints,
    ...boosts.filter((profile) => profile.chainId === "solana").map((profile) => profile.tokenAddress).filter(Boolean),
    ...updates.filter((profile) => profile.chainId === "solana").map((profile) => profile.tokenAddress).filter(Boolean),
    ...profiles.filter((profile) => profile.chainId === "solana").map((profile) => profile.tokenAddress).filter(Boolean),
  ] as string[];
  // gRPC candidates get priority but we still cap total candidates to keep DexScreener calls bounded.
  const candidates = Array.from(new Set(prioritizedCandidates)).slice(0, MAX_CANDIDATES);
  const pairResults = await mapPool(candidates, PAIR_FETCH_CONCURRENCY, async (address) => {
    const result = await fetchJson<DexPair[]>(`/token-pairs/v1/solana/${address}`, `pairs:${address}`, DEX_PAIR_TIMEOUT_MS);
    if (!result.ok) {
      sourceHealth.push({ name: `pairs:${address.slice(0, 4)}…`, status: "degraded", detail: result.error });
      return { address, pairs: [] };
    }
    return { address, pairs: result.data };
  });

  // SVS enrichment for candidate mints. Falls back gracefully if API key is
  // missing or upstream fails — radar still works on DexScreener data alone.
  const svsConfig = getSvsConfig();
  let svsMetadataMap = new Map<string, SvsMetadataRecord>();
  let svsPriceMap = new Map<string, SvsPriceRecord>();
  if (svsConfig.hasApiKey && candidates.length) {
    const svsCandidates = candidates.slice(0, SVS_ENRICHMENT_CANDIDATE_LIMIT);
    // Sequential, not parallel — free SVS tier is 10 r/s, parallel batches
    // can blow the budget. Cache layer in svs.ts means most snapshots are
    // mostly cache hits anyway. SVS is optional, so each leg also has a small
    // build budget and can degrade without delaying the radar.
    const metaStart = Date.now();
    const metaResult = await withSvsBuildBudget<SvsMetadataRecord>("metadata", started, SVS_METADATA_BUDGET_MS, () => {
      return fetchSvsMetadata(svsCandidates);
    });
    {
      const ms = Date.now() - metaStart;
      emitFeed({
        stage: "svs.fetch",
        summary: `metadata · ${svsCandidates.length}/${candidates.length} mints · ${ms}ms · ${metaResult.ok ? `${metaResult.map.size} returned` : `err: ${metaResult.error}`}`,
        kind: "metadata",
        mints: svsCandidates.length,
        ms,
        ok: metaResult.ok,
        returned: metaResult.ok ? metaResult.map.size : 0,
        error: metaResult.ok ? undefined : metaResult.error,
      });
    }
    const priceStart = Date.now();
    const priceResult = await withSvsBuildBudget<SvsPriceRecord>("price", started, SVS_PRICE_BUDGET_MS, () => {
      return fetchSvsPrices(svsCandidates);
    });
    {
      const ms = Date.now() - priceStart;
      emitFeed({
        stage: "svs.fetch",
        summary: `price · ${svsCandidates.length}/${candidates.length} mints · ${ms}ms · ${priceResult.ok ? `${priceResult.map.size} returned` : `err: ${priceResult.error}`}`,
        kind: "price",
        mints: svsCandidates.length,
        ms,
        ok: priceResult.ok,
        returned: priceResult.ok ? priceResult.map.size : 0,
        error: priceResult.ok ? undefined : priceResult.error,
      });
    }
    if (metaResult.ok) {
      svsMetadataMap = metaResult.map;
      sourceHealth.push({
        name: "svs-metadata",
        status: metaResult.map.size ? "ok" : "degraded",
        detail: metaResult.map.size ? `${metaResult.map.size}/${svsCandidates.length} mints` : "no metadata returned",
      });
    } else {
      sourceHealth.push({ name: "svs-metadata", status: "degraded", detail: metaResult.error });
    }
    if (priceResult.ok) {
      svsPriceMap = priceResult.map;
      sourceHealth.push({
        name: "svs-price",
        status: priceResult.map.size ? "ok" : "degraded",
        detail: priceResult.map.size ? `${priceResult.map.size}/${svsCandidates.length} mints` : "no price returned",
      });
    } else {
      sourceHealth.push({ name: "svs-price", status: "degraded", detail: priceResult.error });
    }
  } else if (svsConfig.hasApiKey) {
    // configured but no candidates this round
    sourceHealth.push({ name: "svs-api", status: "ok", detail: "configured (no candidates this cycle)" });
  } else {
    sourceHealth.push({ name: "svs-api", status: "missing", detail: "SVS_API_KEY not set" });
  }

  const matchedAddresses = new Set<string>();
  const tokens = pairResults
    .flatMap(({ address, pairs }) => {
      const profile = profileByAddress.get(address);
      const svs: SvsEnrichment = {
        metadata: svsMetadataMap.get(address),
        price: svsPriceMap.get(address),
      };
      const bestPairs = pairs
        .filter((pair) => pair.chainId === "solana" && pair.baseToken?.address === address)
        .sort((a, b) => n(b.liquidity?.usd) + n(b.volume?.h1) * 0.2 - (n(a.liquidity?.usd) + n(a.volume?.h1) * 0.2))
        .slice(0, 1);
      const built = bestPairs
        .map((pair) => scorePair(pair, profile, svs))
        .filter((token): token is TokenSignal => Boolean(token));
      if (built.length) {
        matchedAddresses.add(address);
        const grpcCandidate = grpcCandidateByMint.get(address);
        if (grpcCandidate) {
          for (const token of built) {
            for (const tag of grpcCandidate.sourceTags) {
              if (!token.sourceTags.includes(tag)) token.sourceTags.push(tag);
            }
            if (!token.opportunityFlags.includes("grpc live tx")) {
              token.opportunityFlags.push("grpc live tx");
            }
            if (grpcCandidate.creatorWallet && !token.creatorWallet) {
              token.creatorWallet = grpcCandidate.creatorWallet;
            }
            if (grpcCandidate.launchEvent && !token.launchEvent) {
              token.launchEvent = {
                type: grpcCandidate.launchEvent.type,
                protocol: grpcCandidate.launchEvent.protocol,
                instruction: grpcCandidate.launchEvent.instruction,
                signature: grpcCandidate.launchEvent.signature,
                slot: grpcCandidate.launchEvent.slot,
              };
              const evtTag = `event:${grpcCandidate.launchEvent.type}`;
              if (!token.opportunityFlags.includes(evtTag)) token.opportunityFlags.push(evtTag);
            }
          }
        }
      }
      return built;
    });

  // gRPC-only candidates: surface conservative TokenSignal entries when no
  // DexScreener pair exists yet but we have at least gRPC tx evidence and
  // ideally SVS metadata/price.
  for (const candidate of grpcCandidatesRaw) {
    if (matchedAddresses.has(candidate.mint)) continue;
    const meta = svsMetadataMap.get(candidate.mint);
    const price = svsPriceMap.get(candidate.mint);
    tokens.push(buildGrpcOnlyToken(candidate, meta, price));
  }

  tokens.sort((a, b) => b.scores.final - a.scores.final);
  tokens.splice(24);

  // Optional mint_info enrichment for the top short-list. Concurrency-limited
  // and tolerant: if it fails, we keep the snapshot we already have.
  if (svsConfig.hasApiKey && tokens.length) {
    const topMints = tokens.slice(0, SVS_MINT_INFO_LIMIT).map((token) => token.tokenAddress);
    const mintInfoStart = Date.now();
    const mintInfoResult = await withSvsBuildBudget<SvsMintInfoRecord>("mint_info", started, SVS_MINT_INFO_BUDGET_MS, () => {
      return fetchSvsMintInfo(topMints, 1);
    });
    {
      const ms = Date.now() - mintInfoStart;
      emitFeed({
        stage: "svs.fetch",
        summary: `mint_info · ${topMints.length} mints · ${ms}ms · ${mintInfoResult.ok ? `${mintInfoResult.map.size} returned` : `err: ${mintInfoResult.error}`}`,
        kind: "mint_info",
        mints: topMints.length,
        ms,
        ok: mintInfoResult.ok,
        returned: mintInfoResult.ok ? mintInfoResult.map.size : 0,
        error: mintInfoResult.ok ? undefined : mintInfoResult.error,
      });
    }
    if (mintInfoResult.ok && mintInfoResult.map.size) {
      mintInfoResult.map.forEach((info, mint) => {
        const target = tokens.find((token) => token.tokenAddress === mint);
        if (!target) return;
        const extra = safeString(info.description);
        if (extra && !target.description.includes(extra)) {
          target.description = target.description ? `${target.description} ${extra}` : extra;
        }
        if (!target.sourceTags.includes("svs-mint-info")) target.sourceTags.push("svs-mint-info");
      });
      sourceHealth.push({
        name: "svs-mint-info",
        status: "ok",
        detail: `${mintInfoResult.map.size}/${topMints.length} top mints enriched`,
      });
    } else if (!mintInfoResult.ok) {
      sourceHealth.push({ name: "svs-mint-info", status: "degraded", detail: mintInfoResult.error });
    }
  }

  const grpcStatus = getGrpcStatus();
  if (grpcStatus.endpointConfigured) {
    const detail = `${grpcStatus.status} · ${grpcStatus.candidateCount} mints · ${grpcStatus.eventsPerMinute}/min`;
    const status =
      grpcStatus.status === "connected" ? "ok"
      : grpcStatus.status === "error" ? "error"
      : grpcStatus.status === "disabled" ? "missing"
      : "degraded";
    sourceHealth.push({ name: "svs-grpc", status, detail });
  } else {
    sourceHealth.push({ name: "svs-grpc", status: "missing", detail: "SVS_GRPC_ENDPOINT not set" });
  }

  // Hard health gate: only required public seed feeds can break the radar.
  // SVS REST/gRPC enrichments are optional; when they rate-limit or are absent,
  // the snapshot should continue with DexScreener-backed data.
  const brokenSources: string[] = [];
  for (const src of sourceHealth) {
    const isRequiredSeed = ["token boosts", "token profiles", "profile updates", "trending metas"].includes(src.name);
    if (isRequiredSeed && src.status !== "ok") {
      brokenSources.push(`${src.name}: ${src.status}${src.detail ? ` — ${src.detail}` : ""}`);
    }
  }
  const status: "ok" | "broken" = brokenSources.length ? "broken" : "ok";

  const snapshot: RadarSnapshot = {
    generatedAt: new Date().toISOString(),
    latencyMs: Date.now() - started,
    scannedTokens: candidates.length,
    dataMode: "public onchain-indexed fast feed",
    refreshSeconds: REFRESH_SECONDS,
    sourceHealth,
    metas: metas.slice(0, 8).map(normalizeMeta),
    tokens,
    grpc: {
      status: grpcStatus.status,
      endpointConfigured: grpcStatus.endpointConfigured,
      hasToken: grpcStatus.hasToken,
      activeStreams: grpcStatus.activeStreams,
      filters: grpcStatus.filters,
      lastEventAt: grpcStatus.lastEventAt,
      lastEventAgeSec: grpcStatus.lastEventAgeSec,
      eventsReceived: grpcStatus.eventsReceived,
      eventsPerMinute: grpcStatus.eventsPerMinute,
      candidateCount: grpcStatus.candidateCount,
    },
    status,
    brokenSources,
  };

  // No stale-while-rate-limited fallback: if the live scan is broken we want
  // the broken status to surface to the client, not a stale radar dressed up
  // as fresh.
  memoryCache = { expires: Date.now() + CACHE_MS, snapshot };
  if (snapshot.tokens.length) lastGoodSnapshot = snapshot;
  storage
    .saveRadarSnapshot({
      capturedAt: snapshot.generatedAt,
      payload: JSON.stringify(snapshot),
    })
    .catch(() => undefined);
  const healthCounts = snapshot.sourceHealth.reduce(
    (acc, src) => {
      acc[src.status] = (acc[src.status] ?? 0) + 1;
      return acc;
    },
    { ok: 0, degraded: 0, error: 0, missing: 0 } as Record<"ok" | "degraded" | "error" | "missing", number>,
  );
  emitFeed({
    stage: "radar.snapshot",
    summary: `${snapshot.tokens.length} tokens · ${candidates.length} candidates · ${snapshot.latencyMs}ms · ${healthCounts.ok}/${snapshot.sourceHealth.length} ok`,
    tokens: snapshot.tokens.length,
    candidates: candidates.length,
    latencyMs: snapshot.latencyMs,
    sourceHealth: healthCounts,
  });
  return snapshot;
}

async function buildSnapshotWithDeadline(force: boolean): Promise<RadarSnapshot> {
  // Coalesce concurrent /api/radar calls onto a single in-flight build to
  // protect a small Railway container from running multiple builds in
  // parallel under load.
  if (!inflightSnapshot) {
    const work = (async () => {
      try {
        return await buildSnapshot(force);
      } finally {
        // Defer the clear so additional callers in the same tick still
        // receive the in-flight promise.
        setImmediate(() => {
          inflightSnapshot = null;
        });
      }
    })();
    inflightSnapshot = work;
  }

  return withDeadline(inflightSnapshot, RADAR_BUILD_DEADLINE_MS, () => {
    // Deadline exceeded → broken. We don't dress a stale snapshot as fresh.
    const grpcStatus = getGrpcStatus();
    const detail = `radar build exceeded ${RADAR_BUILD_DEADLINE_MS}ms`;
    return {
      generatedAt: new Date().toISOString(),
      latencyMs: RADAR_BUILD_DEADLINE_MS,
      scannedTokens: 0,
      dataMode: "deadline-exceeded",
      refreshSeconds: REFRESH_SECONDS,
      sourceHealth: [{ name: "deadline", status: "error", detail }],
      metas: [],
      tokens: [],
      grpc: {
        status: grpcStatus.status,
        endpointConfigured: grpcStatus.endpointConfigured,
        hasToken: grpcStatus.hasToken,
        activeStreams: grpcStatus.activeStreams,
        filters: grpcStatus.filters,
        lastEventAt: grpcStatus.lastEventAt,
        lastEventAgeSec: grpcStatus.lastEventAgeSec,
        eventsReceived: grpcStatus.eventsReceived,
        eventsPerMinute: grpcStatus.eventsPerMinute,
        candidateCount: grpcStatus.candidateCount,
      },
      status: "broken",
      brokenSources: [`radar build: ${detail}`],
    } as RadarSnapshot;
  });
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  app.get("/api/svs/health", async (_req, res) => {
    // Deadline-bound: never wait on radar fetches or external APIs longer than HEALTH_DEADLINE_MS.
    const grpcStatus = getGrpcStatus();
    const grpcSummary = {
      worker: grpcStatus.status,
      activeStreams: grpcStatus.activeStreams,
      filters: grpcStatus.filters,
      candidateCount: grpcStatus.candidateCount,
      eventsPerMinute: grpcStatus.eventsPerMinute,
      lastEventAgeSec: grpcStatus.lastEventAgeSec,
      eventsReceived: grpcStatus.eventsReceived,
      diagnostics: grpcStatus.diagnostics,
    };
    const fallbackReport = {
      apiBaseUrl: "",
      api: { configured: false, status: "degraded" as const, detail: "health probe deadline exceeded" },
      rpc: { configured: false, status: "degraded" as const, detail: "health probe deadline exceeded" },
      grpc: { configured: grpcStatus.endpointConfigured, status: "degraded" as const, detail: "health probe deadline exceeded" },
      authCooldown: { cooling: false, remainingSec: 0, lastStatus: null as number | null },
      overall: "degraded" as const,
      checkedAt: new Date().toISOString(),
    };
    const report = await withDeadline(getSvsHealthReport(), HEALTH_DEADLINE_MS, () => fallbackReport);
    res.json({ ...report, grpc: { ...report.grpc, ...grpcSummary } });
  });

  app.get("/api/grpc/status", (_req, res) => {
    // Synchronous and instant — never waits on gRPC stream or external APIs.
    try {
      res.json(getGrpcStatus());
    } catch (error) {
      res.status(500).json({
        message: error instanceof Error ? error.message : "grpc status failed",
      });
    }
  });

  // Per-mint endpoints — best-effort, NOT health-gated. Used by the detail
  // panel for holders + recent signatures. Cache TTL kept short (15-30s) so
  // an active token's view stays fresh without hammering Solana RPC.
  const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  type HoldersPayload = {
    supply: { uiAmount: number; decimals: number; amount: string };
    top: Array<{ address: string; uiAmount: number; pct: number }>;
    top10Pct: number;
    fetchedAt: string;
  };
  type TradesPayload = {
    signatures: SignatureEntry[];
    fetchedAt: string;
  };
  const holdersCache = new Map<string, { at: number; value: HoldersPayload }>();
  const tradesCache = new Map<string, { at: number; value: TradesPayload }>();
  const HOLDERS_TTL_MS = 30_000;
  const TRADES_TTL_MS = 15_000;

  app.get("/api/token/:mint/holders", async (req, res) => {
    const mint = String(req.params.mint || "");
    if (!MINT_RE.test(mint)) {
      res.status(400).json({ message: "invalid mint address" });
      return;
    }
    const cached = holdersCache.get(mint);
    if (cached && Date.now() - cached.at < HOLDERS_TTL_MS) {
      res.json(cached.value);
      return;
    }
    try {
      const [largest, supply] = await Promise.all([
        fetchTokenLargestAccounts(mint),
        fetchTokenSupply(mint),
      ]);
      const supplyUi = supply.uiAmount ?? 0;
      const top = (largest as LargestAccountEntry[]).slice(0, 20).map((entry) => {
        const ui = entry.uiAmount ?? 0;
        const pct = supplyUi > 0 ? (ui / supplyUi) * 100 : 0;
        return { address: entry.address, uiAmount: ui, pct };
      });
      const top10Pct = top.slice(0, 10).reduce((sum, h) => sum + h.pct, 0);
      const payload: HoldersPayload = {
        supply: { uiAmount: supplyUi, decimals: supply.decimals, amount: supply.amount },
        top,
        top10Pct,
        fetchedAt: new Date().toISOString(),
      };
      holdersCache.set(mint, { at: Date.now(), value: payload });
      res.json(payload);
    } catch (error) {
      if (isRpcNotConfigured(error)) {
        res.status(503).json({ message: "Solana RPC not configured (SVS_RPC_HTTP_URL)" });
        return;
      }
      res.status(502).json({
        message: error instanceof Error ? error.message : "holders fetch failed",
      });
    }
  });

  app.get("/api/token/:mint/trades", async (req, res) => {
    const mint = String(req.params.mint || "");
    if (!MINT_RE.test(mint)) {
      res.status(400).json({ message: "invalid mint address" });
      return;
    }
    const cached = tradesCache.get(mint);
    if (cached && Date.now() - cached.at < TRADES_TTL_MS) {
      res.json(cached.value);
      return;
    }
    try {
      const signatures = await fetchSignaturesForAddress(mint, 30);
      const payload: TradesPayload = {
        signatures,
        fetchedAt: new Date().toISOString(),
      };
      tradesCache.set(mint, { at: Date.now(), value: payload });
      res.json(payload);
    } catch (error) {
      if (isRpcNotConfigured(error)) {
        res.status(503).json({ message: "Solana RPC not configured (SVS_RPC_HTTP_URL)" });
        return;
      }
      res.status(502).json({
        message: error instanceof Error ? error.message : "trades fetch failed",
      });
    }
  });

  app.get("/api/raw/recent", (req, res) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit ?? 200) || 200, 500));
    try {
      res.json(feedRecent(limit));
    } catch (error) {
      res.status(500).json({
        message: error instanceof Error ? error.message : "feed recent failed",
      });
    }
  });

  app.get("/api/raw/stream", (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    let closed = false;
    const write = (event: unknown) => {
      if (closed) return;
      try {
        res.write(`event: feed\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // ignore — client likely disconnected
      }
    };
    // Replay backlog newest-first so the page has immediate content.
    for (const event of feedRecent(200)) write(event);

    const unsubscribe = feedSubscribe((event) => write(event));
    const heartbeat = setInterval(() => {
      if (closed) return;
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        // ignore
      }
    }, 15_000);

    _req.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get("/api/radar", async (req, res) => {
    const force = req.query.force === "1";
    try {
      const snapshot = await buildSnapshotWithDeadline(force);
      res.json(snapshot);
    } catch (error) {
      // Fail loudly — never serve a stale "last saved" snapshot.
      res.status(502).json({ message: error instanceof Error ? error.message : "scanner failed" });
    }
  });

  app.get("/api/radar/stream", async (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    let closed = false;
    let sending = false;
    const send = async () => {
      if (closed || sending) return;
      sending = true;
      try {
        const snapshot = await buildSnapshotWithDeadline(true);
        if (closed) return;
        res.write(`event: radar\n`);
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      } catch (error) {
        if (!closed) {
          res.write(`event: error\n`);
          res.write(`data: ${JSON.stringify({ message: error instanceof Error ? error.message : "scanner failed" })}\n\n`);
        }
      } finally {
        sending = false;
      }
    };

    await send();
    const interval = setInterval(send, REFRESH_SECONDS * 1000);
    _req.on("close", () => {
      closed = true;
      clearInterval(interval);
    });
  });

  return httpServer;
}
