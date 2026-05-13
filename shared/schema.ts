import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const radarSnapshots = sqliteTable("radar_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  capturedAt: text("captured_at").notNull(),
  payload: text("payload").notNull(),
});

export const insertRadarSnapshotSchema = createInsertSchema(radarSnapshots).omit({
  id: true,
});

export type InsertRadarSnapshot = z.infer<typeof insertRadarSnapshotSchema>;
export type RadarSnapshotRecord = typeof radarSnapshots.$inferSelect;

export const timeframeStatsSchema = z.object({
  m5: z.number().optional(),
  h1: z.number().optional(),
  h6: z.number().optional(),
  h24: z.number().optional(),
});

export const scoreBreakdownSchema = z.object({
  velocity: z.number(),
  virality: z.number(),
  upside: z.number(),
  risk: z.number(),
  final: z.number(),
});

export const narrativeCategorySchema = z.enum([
  "ai",
  "animal",
  "political",
  "celebrity",
  "crypto-culture",
  "brainrot",
  "community",
  "regional",
  "utility",
  "gaming",
  "launchpad",
  "fresh-ticker",
]);

export const narrativeLifecycleSchema = z.enum(["seed", "emerging", "hot", "saturated", "unclear"]);
export const confidenceBandSchema = z.enum(["low", "medium", "high"]);

export const narrativeClassificationSchema = z.object({
  primary: narrativeCategorySchema,
  secondary: z.array(narrativeCategorySchema),
  label: z.string(),
  summary: z.string(),
  confidence: z.number().min(0).max(1),
  confidenceBand: confidenceBandSchema,
  lifecycle: narrativeLifecycleSchema,
  signals: z.array(z.string()),
  evidence: z.array(z.string()),
  explanation: z.string(),
});

export const tokenSignalSchema = z.object({
  id: z.string(),
  chainId: z.string(),
  tokenAddress: z.string(),
  pairAddress: z.string(),
  dexId: z.string(),
  url: z.string(),
  name: z.string(),
  symbol: z.string(),
  imageUrl: z.string().nullable(),
  headerUrl: z.string().nullable(),
  description: z.string(),
  memeType: z.string(),
  memeDecode: z.string(),
  narrative: narrativeClassificationSchema,
  viralityThesis: z.string(),
  upsideThesis: z.string(),
  dangerNote: z.string(),
  priceUsd: z.number().nullable(),
  marketCap: z.number().nullable(),
  fdv: z.number().nullable(),
  liquidityUsd: z.number(),
  pairAgeMinutes: z.number().nullable(),
  volume: timeframeStatsSchema,
  priceChange: timeframeStatsSchema,
  txns: z.object({
    m5: z.object({ buys: z.number(), sells: z.number() }),
    h1: z.object({ buys: z.number(), sells: z.number() }),
    h6: z.object({ buys: z.number(), sells: z.number() }),
    h24: z.object({ buys: z.number(), sells: z.number() }),
  }),
  boostAmount: z.number(),
  boostTotalAmount: z.number(),
  buyPressureM5: z.number(),
  buyPressureH1: z.number(),
  volumeAcceleration: z.number(),
  txnAcceleration: z.number(),
  sourceTags: z.array(z.string()),
  links: z.array(z.object({ type: z.string(), label: z.string().nullable(), url: z.string() })),
  riskFlags: z.array(z.string()),
  opportunityFlags: z.array(z.string()),
  // Scam heuristic outputs. `scamSignals` lists which patterns fired;
  // `suspectedScam` is true when ≥2 fire (or one high-confidence one).
  // Suspected-scam tokens are pushed to the bottom of the ranking via a
  // score penalty rather than being removed — surface + collect user votes.
  scamSignals: z.array(z.string()),
  suspectedScam: z.boolean(),
  scores: scoreBreakdownSchema,
  // Per-protocol decoded event metadata (P1.1). Optional because most
  // tokens come from the DexScreener path or generic gRPC token-balance
  // extraction with no instruction-level decode.
  creatorWallet: z.string().nullable().optional(),
  launchEvent: z
    .object({
      type: z.enum(["launch.created", "pool.created", "launch.graduated"]),
      protocol: z.string(),
      instruction: z.string(),
      signature: z.string(),
      slot: z.number(),
    })
    .nullable()
    .optional(),
});

export const metaSignalSchema = z.object({
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  icon: z.string(),
  marketCap: z.number(),
  liquidity: z.number(),
  volume: z.number(),
  tokenCount: z.number(),
  marketCapChange: timeframeStatsSchema,
});

export const grpcSummarySchema = z.object({
  status: z.enum(["disabled", "configured", "connecting", "connected", "reconnecting", "error"]),
  endpointConfigured: z.boolean(),
  hasToken: z.boolean(),
  activeStreams: z.number(),
  filters: z.array(z.string()),
  lastEventAt: z.string().nullable(),
  lastEventAgeSec: z.number().nullable(),
  eventsReceived: z.number(),
  eventsPerMinute: z.number(),
  candidateCount: z.number(),
});

export const radarSnapshotSchema = z.object({
  generatedAt: z.string(),
  latencyMs: z.number(),
  scannedTokens: z.number(),
  dataMode: z.string(),
  refreshSeconds: z.number(),
  sourceHealth: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["ok", "degraded", "error", "missing"]),
      detail: z.string(),
    }),
  ),
  metas: z.array(metaSignalSchema),
  tokens: z.array(tokenSignalSchema),
  grpc: grpcSummarySchema.optional(),
  // App-wide health gate. "broken" means at least one required upstream
  // (DexScreener, SVS REST, gRPC) is not delivering. The client renders a
  // hard error screen — we never serve a partial / inferior radar.
  status: z.enum(["ok", "broken"]),
  brokenSources: z.array(z.string()),
});

export type TokenSignal = z.infer<typeof tokenSignalSchema>;
export type MetaSignal = z.infer<typeof metaSignalSchema>;
export type RadarSnapshot = z.infer<typeof radarSnapshotSchema>;
export type GrpcSummary = z.infer<typeof grpcSummarySchema>;
