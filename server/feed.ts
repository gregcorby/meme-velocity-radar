// In-process raw-event bus + ring buffer for the /api/raw debug feed.
// Backend-only. No persistence; pure observability.

import { EventEmitter } from "node:events";

export type RawFeedEvent =
  | {
      id: string;
      ts: string;
      stage: "grpc.tx.received";
      summary: string;
      slot: number;
      signature: string;
      filters: string[];
      programs: string[];
      txCount: number;
    }
  | {
      id: string;
      ts: string;
      stage: "grpc.tx.ignored";
      summary: string;
      reason: string;
      slot?: number;
      signature?: string;
    }
  | {
      id: string;
      ts: string;
      stage: "grpc.decode.matched";
      summary: string;
      protocol: string;
      instruction: string;
      type: string;
      mint: string | null;
      creator: string | null;
      signature: string;
      slot: number;
    }
  | {
      id: string;
      ts: string;
      stage: "grpc.candidate.upserted";
      summary: string;
      mint: string;
      source: string;
      eventType: string;
      txCount: number;
      isNew: boolean;
    }
  | {
      id: string;
      ts: string;
      stage: "dex.fetch";
      summary: string;
      path: string;
      label: string;
      ms: number;
      ok: boolean;
      status?: string;
      count?: number;
    }
  | {
      id: string;
      ts: string;
      stage: "svs.fetch";
      summary: string;
      kind: "metadata" | "price" | "mint_info";
      mints: number;
      ms: number;
      ok: boolean;
      returned: number;
      error?: string;
    }
  | {
      id: string;
      ts: string;
      stage: "radar.snapshot";
      summary: string;
      tokens: number;
      candidates: number;
      latencyMs: number;
      sourceHealth: { ok: number; degraded: number; error: number; missing: number };
    };

export type RawFeedStage = RawFeedEvent["stage"];

const RING_MAX = 500;
const STRING_CAP = 400;

const ring: RawFeedEvent[] = [];
const bus = new EventEmitter();
bus.setMaxListeners(50);

let counter = 0;
function nextId(): string {
  counter = (counter + 1) >>> 0;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

function cap(value: string): string {
  if (value.length <= STRING_CAP) return value;
  return value.slice(0, STRING_CAP) + "…";
}

function sanitize<T extends RawFeedEvent>(event: T): T {
  // Cap any string field on the event to keep payloads bounded.
  const out: Record<string, unknown> = { ...(event as unknown as Record<string, unknown>) };
  for (const key of Object.keys(out)) {
    const v = out[key];
    if (typeof v === "string") out[key] = cap(v);
  }
  return out as T;
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export type RawFeedInput = DistributiveOmit<RawFeedEvent, "id" | "ts">;

export function emit(input: RawFeedInput): void {
  const event = sanitize({
    ...input,
    id: nextId(),
    ts: new Date().toISOString(),
  } as RawFeedEvent);
  ring.push(event);
  while (ring.length > RING_MAX) ring.shift();
  bus.emit("event", event);
}

export function recent(limit = 200): RawFeedEvent[] {
  const cap = Math.max(1, Math.min(limit, RING_MAX));
  if (ring.length <= cap) return ring.slice().reverse();
  return ring.slice(ring.length - cap).reverse();
}

export function subscribe(handler: (event: RawFeedEvent) => void): () => void {
  bus.on("event", handler);
  return () => bus.off("event", handler);
}
