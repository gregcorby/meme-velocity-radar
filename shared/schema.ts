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
  scores: scoreBreakdownSchema,
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
});

export type TokenSignal = z.infer<typeof tokenSignalSchema>;
export type MetaSignal = z.infer<typeof metaSignalSchema>;
export type RadarSnapshot = z.infer<typeof radarSnapshotSchema>;
export type GrpcSummary = z.infer<typeof grpcSummarySchema>;
