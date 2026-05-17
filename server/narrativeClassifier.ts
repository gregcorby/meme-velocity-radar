import type { z } from "zod";
import { narrativeCategorySchema, narrativeClassificationSchema } from "@shared/schema";

export type NarrativeCategory = z.infer<typeof narrativeCategorySchema>;
export type NarrativeClassification = z.infer<typeof narrativeClassificationSchema>;

export type NarrativeClassifierInput = {
  name?: string | null;
  symbol?: string | null;
  description?: string | null;
  links?: Array<{ type?: string | null; label?: string | null; url?: string | null }>;
  sourceTags?: string[];
  metrics?: {
    volumeAcceleration?: number | null;
    buyPressureH1?: number | null;
    marketCap?: number | null;
    liquidityUsd?: number | null;
    pairAgeMinutes?: number | null;
    boostAmount?: number | null;
    socialCount?: number | null;
  };
};

type Rule = {
  category: NarrativeCategory;
  label: string;
  summary: string;
  weight: number;
  patterns: RegExp[];
};

type RuleHit = {
  category: NarrativeCategory;
  label: string;
  summary: string;
  weight: number;
  evidence: string[];
};

const RULES: Rule[] = [
  {
    category: "ai",
    label: "AI / agent meta",
    summary: "AI-coded token using model, agent, robot, or automation language.",
    weight: 34,
    patterns: [/\b(ai|agent|agents|grok|robot|bot|openai|claude|deepseek|neural|llm|agi)\b/i],
  },
  {
    category: "animal",
    label: "Animal mascot",
    summary: "Readable animal mascot meme with familiar memecoin reflexes.",
    weight: 30,
    patterns: [/\b(pepe|frog|kermit|toad|doge|dog|shib|inu|bonk|wif|puppy|cat|michi|kitty|kitten|popcat|meow|pengu|goat)\b/i],
  },
  {
    category: "political",
    label: "Political parody",
    summary: "Election, state, or politician-coded narrative that spreads through controversy.",
    weight: 33,
    patterns: [/\b(trump|biden|maga|election|president|senate|congress|democrat|republican|politic|government)\b/i],
  },
  {
    category: "celebrity",
    label: "Celebrity / public figure",
    summary: "Public-figure riff trading on recognition and fast remixability.",
    weight: 30,
    patterns: [/\b(elon|musk|vitalik|cz|tate|kanye|saylor|drake|swift|celebrity)\b/i],
  },
  {
    category: "crypto-culture",
    label: "Crypto-native reaction meme",
    summary: "Timeline-native crypto archetype built for reaction images and in-jokes.",
    weight: 28,
    patterns: [/\b(wojak|chad|cope|based|npc|goblin|degen|jeet|wagmi|ngmi|hodl|diamond|hands)\b/i],
  },
  {
    category: "brainrot",
    label: "Absurdist brainrot",
    summary: "Shock-value or nonsense internet humor with high repeatability and high fragility.",
    weight: 29,
    patterns: [/\b(fart|poop|butt|piss|brainrot|skibidi|rizz|sigma|idiot|retard|clown)\b/i],
  },
  {
    category: "community",
    label: "Community takeover",
    summary: "Community-ownership story where revival and coordination are the hook.",
    weight: 38,
    patterns: [/\b(cto|community takeover|takeover|revive|revival|community owned|cult)\b/i],
  },
  {
    category: "regional",
    label: "Regional / language meta",
    summary: "Language, country, or regional meme seeking novelty and local community pull.",
    weight: 27,
    patterns: [/\b(china|chinese|japan|japanese|korea|korean|america|usa|russia|arab|solana)\b|[币狗猫龙救命]/i],
  },
  {
    category: "utility",
    label: "Utility claim",
    summary: "Token copy leans on product, protocol, or infrastructure claims rather than pure meme.",
    weight: 23,
    patterns: [/\b(protocol|platform|utility|app|tool|defi|yield|staking|bridge|oracle|pay|wallet|launchpad)\b/i],
  },
  {
    category: "gaming",
    label: "Gaming / entertainment",
    summary: "Game, streamer, or entertainment-coded meme with fandom-style spread potential.",
    weight: 24,
    patterns: [/\b(game|gaming|play|player|streamer|twitch|minecraft|fortnite|roblox|anime|manga)\b/i],
  },
  {
    category: "launchpad",
    label: "Launchpad-native",
    summary: "Narrative is still mostly the live launch venue or pool-create event.",
    weight: 18,
    patterns: [/\b(pump|pumpswap|pumpfun|launchlab|raydium|moonshot|fair launch)\b/i],
  },
];

function textParts(input: NarrativeClassifierInput) {
  const links = input.links ?? [];
  const linkText = links
    .map((link) => [link.type, link.label, link.url].filter(Boolean).join(" "))
    .join(" ");
  return [input.name, input.symbol, input.description, linkText, ...(input.sourceTags ?? [])]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function excerpt(corpus: string, regex: RegExp) {
  const match = corpus.match(regex);
  if (!match || match.index == null) return null;
  const start = Math.max(0, match.index - 24);
  const end = Math.min(corpus.length, match.index + match[0].length + 24);
  return corpus.slice(start, end).trim();
}

function confidenceBand(confidence: number): NarrativeClassification["confidenceBand"] {
  if (confidence >= 0.68) return "high";
  if (confidence >= 0.42) return "medium";
  return "low";
}

function lifecycle(input: NarrativeClassifierInput, confidence: number): NarrativeClassification["lifecycle"] {
  const metrics = input.metrics ?? {};
  const age = Number(metrics.pairAgeMinutes ?? NaN);
  const volumeAcceleration = Number(metrics.volumeAcceleration ?? 0);
  const boostAmount = Number(metrics.boostAmount ?? 0);
  const socialCount = Number(metrics.socialCount ?? 0);
  const marketCap = Number(metrics.marketCap ?? 0);

  const hasLaunchSource = (input.sourceTags ?? []).some((tag) => /grpc|pump|raydium|launch|pool/i.test(tag));
  if (Number.isFinite(age) && age <= 20 && (hasLaunchSource || confidence >= 0.32)) return "seed";
  if (confidence < 0.32) return "unclear";
  if (volumeAcceleration >= 2.2 || boostAmount > 0 || socialCount >= 2) return "hot";
  if (marketCap >= 8_000_000 && volumeAcceleration < 0.9) return "saturated";
  return "emerging";
}

function dedupe<T>(values: T[]) {
  return Array.from(new Set(values));
}

export function classifyNarrative(input: NarrativeClassifierInput): NarrativeClassification {
  const corpus = textParts(input);
  const hits: RuleHit[] = [];

  for (const rule of RULES) {
    const evidence = dedupe(rule.patterns.map((pattern) => excerpt(corpus, pattern)).filter(Boolean) as string[]);
    if (evidence.length) {
      hits.push({ ...rule, weight: rule.weight + Math.min(evidence.length - 1, 2) * 4, evidence });
    }
  }

  const socialCount = input.metrics?.socialCount ?? input.links?.length ?? 0;
  const descriptionLength = input.description?.trim().length ?? 0;
  const sourceTags = input.sourceTags ?? [];
  const launchSource = sourceTags.some((tag) => /grpc|pump|raydium|launch/i.test(tag));
  if (launchSource && !hits.some((hit) => hit.category === "launchpad")) {
    hits.push({
      category: "launchpad",
      label: "Launchpad-native",
      summary: "Narrative is still mostly the live launch venue or pool-create event.",
      weight: 16,
      evidence: [sourceTags.filter((tag) => /grpc|pump|raydium|launch/i.test(tag)).slice(0, 3).join(", ")],
    });
  }

  hits.sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label));
  const primaryHit = hits[0];
  const primary: NarrativeCategory = primaryHit?.category ?? "fresh-ticker";
  const secondary = hits.slice(1, 4).map((hit) => hit.category).filter((category) => category !== primary);
  const distinctSecondary = dedupe(secondary);
  const signalScore = hits.reduce((sum, hit, index) => sum + hit.weight / (index + 1.7), 0);
  const metadataScore = Math.min(18, descriptionLength / 18) + Math.min(12, socialCount * 4);
  const confidence = Math.max(0.18, Math.min(0.96, (signalScore + metadataScore) / 62));
  const band = confidenceBand(confidence);
  const resolvedLifecycle = lifecycle(input, confidence);
  const evidence = dedupe(hits.flatMap((hit) => hit.evidence)).slice(0, 6);
  const signals = hits.map((hit) => hit.label).slice(0, 5);

  if (!primaryHit) {
    return {
      primary,
      secondary: [],
      label: "Fresh ticker meme",
      summary:
        descriptionLength > 0
          ? "A newly seeded ticker narrative; metadata exists, but the meme category is not yet obvious."
          : "A very early token with sparse metadata; the meme narrative is not yet proven.",
      confidence,
      confidenceBand: band,
      lifecycle: resolvedLifecycle,
      signals: descriptionLength > 0 ? ["metadata present"] : ["sparse metadata"],
      evidence: descriptionLength > 0 ? [(input.description ?? "").slice(0, 120)] : [],
      explanation: `No strong taxonomy rule matched; confidence is ${band} because evidence is sparse or generic.`,
    };
  }

  return {
    primary,
    secondary: distinctSecondary,
    label: primaryHit.label,
    summary: primaryHit.summary,
    confidence,
    confidenceBand: band,
    lifecycle: resolvedLifecycle,
    signals,
    evidence,
    explanation: `${primaryHit.label} selected from ${evidence.length || 1} evidence point${evidence.length === 1 ? "" : "s"}; lifecycle reads as ${resolvedLifecycle}.`,
  };
}
