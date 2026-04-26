import type { Express } from "express";
import type { Server } from "node:http";
import { storage } from "./storage";
import type { MetaSignal, RadarSnapshot, TokenSignal } from "@shared/schema";
import {
  fetchSvsMetadata,
  fetchSvsMintInfo,
  fetchSvsPrices,
  getSvsConfig,
  getSvsHealthReport,
  type SvsMetadataRecord,
  type SvsMintInfoRecord,
  type SvsPriceRecord,
} from "./svs";

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
const CACHE_MS = 25_000;
const REFRESH_SECONDS = 20;
const MAX_CANDIDATES = 14;
let memoryCache: { expires: number; snapshot: RadarSnapshot } | null = null;
let lastGoodSnapshot: RadarSnapshot | null = null;

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

async function fetchJson<T>(path: string, label: string, timeoutMs = 8_000): Promise<{ ok: true; data: T } | { ok: false; error: string; label: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${DEX}${path}`, {
      signal: controller.signal,
      headers: { "User-Agent": "meme-velocity-radar/1.0" },
    });
    if (!response.ok) {
      return { ok: false, error: `${response.status} ${response.statusText}`, label };
    }
    return { ok: true, data: (await response.json()) as T };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "unknown fetch error", label };
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
    fetchJson<TokenProfile[]>("/token-boosts/latest/v1", "boosts"),
    fetchJson<TokenProfile[]>("/token-profiles/latest/v1", "profiles"),
    fetchJson<TokenProfile[]>("/token-profiles/recent-updates/v1", "profile updates"),
    fetchJson<DexMeta[]>("/metas/trending/v1", "metas"),
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

  const prioritizedCandidates = [
    ...boosts.filter((profile) => profile.chainId === "solana").map((profile) => profile.tokenAddress).filter(Boolean),
    ...updates.filter((profile) => profile.chainId === "solana").map((profile) => profile.tokenAddress).filter(Boolean),
    ...profiles.filter((profile) => profile.chainId === "solana").map((profile) => profile.tokenAddress).filter(Boolean),
  ] as string[];
  const candidates = Array.from(new Set(prioritizedCandidates)).slice(0, MAX_CANDIDATES);
  const pairResults = await mapPool(candidates, 7, async (address) => {
    const result = await fetchJson<DexPair[]>(`/token-pairs/v1/solana/${address}`, `pairs:${address}`, 6_000);
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
    const [metaResult, priceResult] = await Promise.all([
      fetchSvsMetadata(candidates),
      fetchSvsPrices(candidates),
    ]);
    if (metaResult.ok) {
      svsMetadataMap = metaResult.map;
      sourceHealth.push({
        name: "svs-metadata",
        status: metaResult.map.size ? "ok" : "degraded",
        detail: metaResult.map.size ? `${metaResult.map.size}/${candidates.length} mints` : "no metadata returned",
      });
    } else {
      sourceHealth.push({ name: "svs-metadata", status: "degraded", detail: metaResult.error });
    }
    if (priceResult.ok) {
      svsPriceMap = priceResult.map;
      sourceHealth.push({
        name: "svs-price",
        status: priceResult.map.size ? "ok" : "degraded",
        detail: priceResult.map.size ? `${priceResult.map.size}/${candidates.length} mints` : "no price returned",
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
      return bestPairs.map((pair) => scorePair(pair, profile, svs)).filter((token): token is TokenSignal => Boolean(token));
    })
    .sort((a, b) => b.scores.final - a.scores.final)
    .slice(0, 24);

  // Optional mint_info enrichment for the top short-list. Concurrency-limited
  // and tolerant: if it fails, we keep the snapshot we already have.
  if (svsConfig.hasApiKey && tokens.length) {
    const topMints = tokens.slice(0, 6).map((token) => token.tokenAddress);
    const mintInfoResult = await fetchSvsMintInfo(topMints, 3);
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

  const snapshot: RadarSnapshot = {
    generatedAt: new Date().toISOString(),
    latencyMs: Date.now() - started,
    scannedTokens: candidates.length,
    dataMode: "public onchain-indexed fast feed",
    refreshSeconds: REFRESH_SECONDS,
    sourceHealth,
    metas: metas.slice(0, 8).map(normalizeMeta),
    tokens,
  };

  if (!snapshot.tokens.length && (candidates.length === 0 || sourceHealth.some((source) => source.status === "error"))) {
    const fallback = await latestUsableSnapshot();
    if (fallback) {
      fallback.sourceHealth = [
        { name: "stale-while-rate-limited", status: "degraded", detail: "serving last non-empty scan while public feeds recover" },
        ...sourceHealth,
      ];
      fallback.generatedAt = new Date().toISOString();
      fallback.latencyMs = Date.now() - started;
      memoryCache = { expires: Date.now() + CACHE_MS, snapshot: fallback };
      return fallback;
    }
  }

  memoryCache = { expires: Date.now() + CACHE_MS, snapshot };
  if (snapshot.tokens.length) lastGoodSnapshot = snapshot;
  storage
    .saveRadarSnapshot({
      capturedAt: snapshot.generatedAt,
      payload: JSON.stringify(snapshot),
    })
    .catch(() => undefined);
  return snapshot;
}

async function latestUsableSnapshot(): Promise<RadarSnapshot | null> {
  if (lastGoodSnapshot?.tokens.length) return structuredClone(lastGoodSnapshot);
  const latest = await storage.getLatestRadarSnapshot().catch(() => undefined);
  if (!latest) return null;
  try {
    const parsed = JSON.parse(latest.payload) as RadarSnapshot;
    return parsed.tokens?.length ? parsed : null;
  } catch {
    return null;
  }
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  app.get("/api/svs/health", async (_req, res) => {
    try {
      const report = await getSvsHealthReport();
      // Only booleans/status/details are returned — never echo secret values.
      res.json(report);
    } catch (error) {
      res.status(500).json({
        message: error instanceof Error ? error.message : "svs health failed",
      });
    }
  });

  app.get("/api/radar", async (req, res) => {
    const force = req.query.force === "1";
    try {
      res.json(await buildSnapshot(force));
    } catch (error) {
      const latest = await storage.getLatestRadarSnapshot().catch(() => undefined);
      if (latest) {
        const snapshot = JSON.parse(latest.payload) as RadarSnapshot;
        snapshot.sourceHealth.unshift({ name: "cache", status: "degraded", detail: "serving last saved snapshot" });
        return res.json(snapshot);
      }
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
    const send = async () => {
      if (closed) return;
      try {
        const snapshot = await buildSnapshot(true);
        res.write(`event: radar\n`);
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      } catch (error) {
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ message: error instanceof Error ? error.message : "scanner failed" })}\n\n`);
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
