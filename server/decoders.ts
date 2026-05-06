// Per-protocol Solana program decoders for the gRPC live stream.
//
// Each decoder is best-effort and defensive: yellowstone proto types are
// wide and many fields are optional. Decoders return a typed `LaunchEvent`
// when a known create / pool-creation / graduation instruction is detected,
// or null otherwise. The caller (grpcStream) falls back to its generic
// token-balance based candidate extraction when no decoder matches.
//
// Anchor convention: instruction discriminator = first 8 bytes of
// sha256("global:<instruction_name>"). We compute these at module load so
// matching is a constant-time byte compare.
//
// Per-program account positions are taken from the public IDLs for each
// program. For Pump.fun the layout is well-known and stable. For other
// programs we use a feePayer-as-creator heuristic and tag the event with
// the matched discriminator name.

import { createHash } from "node:crypto";
import bs58 from "bs58";

export type LaunchEventType = "launch.created" | "pool.created" | "launch.graduated";

export type LaunchEvent = {
  type: LaunchEventType;
  protocol: string;        // e.g. "pumpfun", "pumpswap", "raydium-launchlab"
  instruction: string;     // anchor instruction name matched (e.g. "create")
  creator: string | null;  // base58 wallet that created the launch / pool
  mint: string | null;     // primary mint (when decodable from instruction layout)
  signature: string;
  slot: number;
  decimals: number | null; // mint decimals when surfacable from token balances
};

// ---- Discriminator helpers ----

function anchorDiscriminator(name: string): Uint8Array {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function bytesEqual(a: Uint8Array | undefined | null, b: Uint8Array): boolean {
  if (!a || a.length < b.length) return false;
  for (let i = 0; i < b.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Pre-compute discriminators we look for. Adding a new program is a single
// line in this table.
const DISC = {
  pumpfunCreate: anchorDiscriminator("create"),
  pumpfunCompleteEvent: anchorDiscriminator("complete_event"),
  pumpfunWithdraw: anchorDiscriminator("withdraw"),
  pumpswapCreatePool: anchorDiscriminator("create_pool"),
  pumpswapInitialize: anchorDiscriminator("initialize"),
  raydiumLaunchlabInitialize: anchorDiscriminator("initialize"),
  raydiumCpmmInitialize: anchorDiscriminator("initialize"),
} as const;

// ---- Instruction shape (yellowstone proto, defensive `any` access) ----

type RawInstruction = {
  programIdIndex?: number;
  accounts?: Uint8Array | number[]; // indexes into accountKeys
  data?: Uint8Array | string;       // raw instruction bytes
};

type RawTransactionInfo = {
  transaction?: {
    message?: {
      instructions?: RawInstruction[];
    };
  };
  meta?: {
    innerInstructions?: Array<{ index?: number; instructions?: RawInstruction[] }>;
    preTokenBalances?: Array<{ mint?: string; uiTokenAmount?: { decimals?: number } }>;
    postTokenBalances?: Array<{ mint?: string; uiTokenAmount?: { decimals?: number } }>;
  };
};

function toBytes(value: Uint8Array | string | undefined): Uint8Array | null {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") {
    // yellowstone occasionally serialises bytes as base58 strings
    try {
      return bs58.decode(value);
    } catch {
      try {
        return Buffer.from(value, "base64");
      } catch {
        return null;
      }
    }
  }
  return null;
}

function toIndexes(accounts: Uint8Array | number[] | undefined): number[] {
  if (!accounts) return [];
  if (accounts instanceof Uint8Array) return Array.from(accounts);
  if (Array.isArray(accounts)) return accounts.slice();
  return [];
}

function flattenInstructions(info: RawTransactionInfo): RawInstruction[] {
  const top = info?.transaction?.message?.instructions ?? [];
  const inner = (info?.meta?.innerInstructions ?? []).flatMap((g) => g.instructions ?? []);
  return [...top, ...inner];
}

function resolveAccount(accountKeys: string[], idx: number | undefined): string | null {
  if (idx == null) return null;
  if (idx < 0 || idx >= accountKeys.length) return null;
  return accountKeys[idx] ?? null;
}

function feePayer(accountKeys: string[]): string | null {
  return accountKeys[0] ?? null;
}

function decimalsForMint(info: RawTransactionInfo, mint: string | null): number | null {
  if (!mint) return null;
  const all = [
    ...(info?.meta?.preTokenBalances ?? []),
    ...(info?.meta?.postTokenBalances ?? []),
  ];
  for (const balance of all) {
    if (balance?.mint === mint && typeof balance?.uiTokenAmount?.decimals === "number") {
      return balance.uiTokenAmount.decimals;
    }
  }
  return null;
}

// ---- Per-protocol decoders ----

type DecodeContext = {
  info: RawTransactionInfo;
  accountKeys: string[];
  signature: string;
  slot: number;
};

type ProtocolDecoder = (programId: string, ctx: DecodeContext) => LaunchEvent | null;

// Pump.fun: the `create` instruction has a stable Anchor IDL with the
// following account positions (index): 0=mint, 1=mint_authority,
// 2=bonding_curve, 3=associated_bonding_curve, 4=global,
// 5=mpl_token_metadata, 6=metadata, 7=user (creator), 8..=program/sysvars.
const PUMPFUN_DECODER: ProtocolDecoder = (programId, ctx) => {
  const ixs = flattenInstructions(ctx.info);
  for (const ix of ixs) {
    const programIndex = ix.programIdIndex;
    const program = resolveAccount(ctx.accountKeys, programIndex);
    if (program !== programId) continue;
    const data = toBytes(ix.data);
    if (!data) continue;

    if (bytesEqual(data, DISC.pumpfunCreate)) {
      const accounts = toIndexes(ix.accounts);
      const mint = resolveAccount(ctx.accountKeys, accounts[0]);
      const creator = resolveAccount(ctx.accountKeys, accounts[7]) ?? feePayer(ctx.accountKeys);
      return {
        type: "launch.created",
        protocol: "pumpfun",
        instruction: "create",
        creator,
        mint,
        signature: ctx.signature,
        slot: ctx.slot,
        decimals: decimalsForMint(ctx.info, mint),
      };
    }

    if (bytesEqual(data, DISC.pumpfunCompleteEvent) || bytesEqual(data, DISC.pumpfunWithdraw)) {
      // Bonding-curve graduation: complete_event fires when the curve
      // completes; withdraw is the migration path to PumpSwap. Treat both
      // as graduation signals.
      const accounts = toIndexes(ix.accounts);
      const mint = resolveAccount(ctx.accountKeys, accounts[0]);
      return {
        type: "launch.graduated",
        protocol: "pumpfun",
        instruction: bytesEqual(data, DISC.pumpfunCompleteEvent) ? "complete_event" : "withdraw",
        creator: feePayer(ctx.accountKeys),
        mint,
        signature: ctx.signature,
        slot: ctx.slot,
        decimals: decimalsForMint(ctx.info, mint),
      };
    }
  }
  return null;
};

// PumpSwap: AMM-style create_pool. We use the feePayer as creator and
// surface the first non-stable mint we can identify from token balances
// as the "primary" mint. Per-IDL account positions vary across PumpSwap
// versions, so we deliberately avoid hard-coding them.
const PUMPSWAP_DECODER: ProtocolDecoder = (programId, ctx) => {
  const ixs = flattenInstructions(ctx.info);
  for (const ix of ixs) {
    const program = resolveAccount(ctx.accountKeys, ix.programIdIndex);
    if (program !== programId) continue;
    const data = toBytes(ix.data);
    if (!data) continue;
    if (bytesEqual(data, DISC.pumpswapCreatePool) || bytesEqual(data, DISC.pumpswapInitialize)) {
      return {
        type: "pool.created",
        protocol: "pumpswap",
        instruction: bytesEqual(data, DISC.pumpswapCreatePool) ? "create_pool" : "initialize",
        creator: feePayer(ctx.accountKeys),
        mint: null, // resolved by the caller from token balances
        signature: ctx.signature,
        slot: ctx.slot,
        decimals: null,
      };
    }
  }
  return null;
};

const RAYDIUM_LAUNCHLAB_DECODER: ProtocolDecoder = (programId, ctx) => {
  const ixs = flattenInstructions(ctx.info);
  for (const ix of ixs) {
    const program = resolveAccount(ctx.accountKeys, ix.programIdIndex);
    if (program !== programId) continue;
    const data = toBytes(ix.data);
    if (!data) continue;
    if (bytesEqual(data, DISC.raydiumLaunchlabInitialize)) {
      return {
        type: "launch.created",
        protocol: "raydium-launchlab",
        instruction: "initialize",
        creator: feePayer(ctx.accountKeys),
        mint: null,
        signature: ctx.signature,
        slot: ctx.slot,
        decimals: null,
      };
    }
  }
  return null;
};

const RAYDIUM_CPMM_DECODER: ProtocolDecoder = (programId, ctx) => {
  const ixs = flattenInstructions(ctx.info);
  for (const ix of ixs) {
    const program = resolveAccount(ctx.accountKeys, ix.programIdIndex);
    if (program !== programId) continue;
    const data = toBytes(ix.data);
    if (!data) continue;
    if (bytesEqual(data, DISC.raydiumCpmmInitialize)) {
      return {
        type: "pool.created",
        protocol: "raydium-cpmm",
        instruction: "initialize",
        creator: feePayer(ctx.accountKeys),
        mint: null,
        signature: ctx.signature,
        slot: ctx.slot,
        decimals: null,
      };
    }
  }
  return null;
};

// Registry — one decoder per watched-program name. Keys must match the
// names produced by grpcStream.loadWatchPrograms().
const REGISTRY: Record<string, ProtocolDecoder> = {
  pumpfun: PUMPFUN_DECODER,
  pumpswap: PUMPSWAP_DECODER,
  "raydium-launchlab": RAYDIUM_LAUNCHLAB_DECODER,
  "raydium-cpmm": RAYDIUM_CPMM_DECODER,
};

/**
 * Run every applicable decoder against a parsed transaction. Returns the
 * first matched LaunchEvent, preferring `launch.created` over
 * `pool.created` over `launch.graduated`. Returns null when no decoder
 * matches — caller falls back to the generic candidate path.
 */
export function decodeLaunchEvent(
  observedPrograms: string[],          // watched-program *names* present in this tx
  programIdsByName: Map<string, string>, // name -> base58 programId
  ctx: DecodeContext,
): LaunchEvent | null {
  const collected: LaunchEvent[] = [];
  for (const name of observedPrograms) {
    const decoder = REGISTRY[name];
    if (!decoder) continue;
    const programId = programIdsByName.get(name);
    if (!programId) continue;
    try {
      const event = decoder(programId, ctx);
      if (event) collected.push(event);
    } catch {
      // Decoder errors must never kill the stream.
    }
  }
  if (!collected.length) return null;
  const priority: Record<LaunchEventType, number> = {
    "launch.created": 0,
    "pool.created": 1,
    "launch.graduated": 2,
  };
  collected.sort((a, b) => priority[a.type] - priority[b.type]);
  return collected[0];
}

// Exported for tests / introspection.
export const DISCRIMINATORS = DISC;
