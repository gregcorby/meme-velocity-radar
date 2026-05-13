import assert from "node:assert/strict";
import test from "node:test";
import { classifyNarrative } from "./narrativeClassifier";

test("classifies explicit AI agent narratives with high confidence", () => {
  const result = classifyNarrative({
    name: "Grok Agent Pepe",
    symbol: "GROKAI",
    description: "An autonomous AI agent meme coin with a Telegram bot and on-chain agent lore.",
    links: [{ type: "social", url: "https://x.com/grokagent" }],
    metrics: { socialCount: 2, volumeAcceleration: 2.4, pairAgeMinutes: 45 },
  });

  assert.equal(result.primary, "ai");
  assert.equal(result.label, "AI / agent meta");
  assert.ok(result.secondary.includes("animal"));
  assert.equal(result.confidenceBand, "high");
  assert.ok(result.confidence >= 0.68);
  assert.equal(result.lifecycle, "hot");
});

test("classifies CTO tokens as community narratives", () => {
  const result = classifyNarrative({
    name: "Moon Cat CTO",
    symbol: "MCTO",
    description: "Community takeover revival. Holders are rebuilding socials after the dev left.",
    sourceTags: ["profiles/latest", "cto"],
    metrics: { socialCount: 1, pairAgeMinutes: 180, volumeAcceleration: 1.1 },
  });

  assert.equal(result.primary, "community");
  assert.ok(result.secondary.includes("animal"));
  assert.equal(result.lifecycle, "emerging");
  assert.ok(result.signals.includes("Community takeover"));
});

test("falls back to fresh ticker when evidence is sparse", () => {
  const result = classifyNarrative({
    name: "ZXQ",
    symbol: "ZXQ",
    description: "",
    metrics: { pairAgeMinutes: 3 },
  });

  assert.equal(result.primary, "fresh-ticker");
  assert.equal(result.confidenceBand, "low");
  assert.equal(result.lifecycle, "unclear");
  assert.deepEqual(result.secondary, []);
});

test("uses source tags to identify launchpad-native pre-dex signals", () => {
  const result = classifyNarrative({
    name: "grpc:abcd…wxyz",
    symbol: "???",
    sourceTags: ["grpc-live", "pumpfun", "pool.created"],
    metrics: { pairAgeMinutes: 1 },
  });

  assert.equal(result.primary, "launchpad");
  assert.equal(result.lifecycle, "seed");
  assert.ok(result.evidence.some((item) => item.includes("grpc-live")));
});
