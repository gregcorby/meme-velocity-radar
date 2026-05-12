import { useEffect, useMemo, useState } from "react";
import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import NotFound from "@/pages/not-found";
import RawFeedPage from "@/pages/raw-feed";
import type { RadarSnapshot, TokenSignal } from "@shared/schema";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Copy,
  Download,
  ExternalLink,
  Moon,
  RefreshCcw,
  Search,
  Sun,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";

const EVENT_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

type SortMode = "score" | "velocity" | "virality" | "upside" | "risk";
type FilterMode = "all" | "turbo" | "early" | "social" | "lower-risk";

type SvsHealthStatus = "ok" | "degraded" | "error" | "missing";
type SvsHealthReport = {
  apiBaseUrl: string;
  api: { configured: boolean; status: SvsHealthStatus; detail: string };
  rpc: { configured: boolean; status: SvsHealthStatus; detail: string };
  grpc: { configured: boolean; status: SvsHealthStatus; detail: string };
  overall: SvsHealthStatus;
  checkedAt: string;
};

type HoldersResponse = {
  supply: { uiAmount: number; decimals: number; amount: string };
  top: Array<{ address: string; uiAmount: number; pct: number }>;
  top10Pct: number;
  fetchedAt: string;
};
type TradeEntry = {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
  confirmationStatus?: string;
};
type TradesResponse = { signatures: TradeEntry[]; fetchedAt: string };

type GrpcWorkerStatus = "disabled" | "configured" | "connecting" | "connected" | "reconnecting" | "error";
type GrpcStatusReport = {
  status: GrpcWorkerStatus;
  endpointConfigured: boolean;
  hasToken: boolean;
  activeStreams: number;
  filters: string[];
  lastEventAt: string | null;
  lastEventAgeSec: number | null;
  lastError: string | null;
  eventsReceived: number;
  eventsPerMinute: number;
  candidateCount: number;
  watchedPrograms: { name: string; programId: string }[];
};

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "dark";
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  return { theme, setTheme };
}

function fmtMoney(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "n/a";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toPrecision(3)}`;
}

function fmtPct(value: number | undefined) {
  const v = value ?? 0;
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(Math.abs(v) >= 10 ? 0 : 1)}%`;
}

function fmtAge(minutes: number | null) {
  if (minutes == null) return "unknown";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d`;
}

function scoreTone(score: number) {
  if (score >= 80) return "text-emerald-600 dark:text-emerald-300";
  if (score >= 62) return "text-amber-600 dark:text-amber-300";
  return "text-muted-foreground";
}

function riskTone(score: number) {
  if (score >= 55) return "text-red-600 dark:text-red-300";
  if (score >= 32) return "text-amber-600 dark:text-amber-300";
  return "text-emerald-600 dark:text-emerald-300";
}

function trendIcon(value: number | undefined) {
  return (value ?? 0) >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />;
}

function normalizeChart(token: TokenSignal | undefined) {
  if (!token) return [];
  return [
    { label: "24h", volume: token.volume.h24 ?? 0, price: token.priceChange.h24 ?? 0 },
    { label: "6h", volume: token.volume.h6 ?? 0, price: token.priceChange.h6 ?? 0 },
    { label: "1h", volume: token.volume.h1 ?? 0, price: token.priceChange.h1 ?? 0 },
    { label: "5m", volume: (token.volume.m5 ?? 0) * 12, price: token.priceChange.m5 ?? 0 },
  ];
}

type Driver = { label: string; value: string };

function ScorePill({
  label,
  value,
  drivers,
  danger = false,
}: {
  label: string;
  value: number;
  drivers: Driver[];
  danger?: boolean;
}) {
  // concentric: outer rounded-xl (12) = inner driver row has no radius but padding p-3 (12).
  return (
    <div className="rounded-xl border border-border/70 bg-card p-3" data-testid={`score-${label.toLowerCase()}`}>
      <div className="flex items-baseline justify-between">
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
        <span
          className={`font-mono text-xl font-semibold leading-none tabular-nums tracking-tight ${
            danger ? riskTone(value) : scoreTone(value)
          }`}
        >
          {value}
        </span>
      </div>
      <div className="mt-2.5 divide-y divide-border/40">
        {drivers.map((d) => (
          <div key={d.label} className="flex items-center justify-between py-1 first:pt-0 last:pb-0">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{d.label}</span>
            <span className="font-mono text-[11px] tabular-nums text-foreground/85">{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function fmtMult(value: number) {
  if (!Number.isFinite(value)) return "n/a";
  return `${value.toFixed(value >= 10 ? 0 : 1)}x`;
}

function countSocialLinks(token: TokenSignal) {
  return token.links.filter((link) => /x\.com|twitter|t\.me|telegram|discord|tiktok|instagram/i.test(link.url)).length;
}

function velocityDrivers(token: TokenSignal): Driver[] {
  return [
    { label: "Vol accel", value: fmtMult(token.volumeAcceleration) },
    { label: "Tx accel", value: fmtMult(token.txnAcceleration) },
    { label: "Buy press 1h", value: fmtPct(token.buyPressureH1 * 100) },
  ];
}

function viralityDrivers(token: TokenSignal): Driver[] {
  return [
    { label: "Boost", value: token.boostAmount ? `${token.boostAmount}u` : "0" },
    { label: "Socials", value: String(countSocialLinks(token)) },
    { label: "Live", value: token.sourceTags.some((tag) => tag.includes("grpc")) ? "yes" : "no" },
  ];
}

function upsideDrivers(token: TokenSignal): Driver[] {
  return [
    { label: "Mcap", value: fmtMoney(token.marketCap) },
    { label: "Liq", value: fmtMoney(token.liquidityUsd) },
    { label: "Age", value: fmtAge(token.pairAgeMinutes) },
  ];
}

function riskDrivers(token: TokenSignal): Driver[] {
  return [
    { label: "Liq", value: fmtMoney(token.liquidityUsd) },
    { label: "Age", value: fmtAge(token.pairAgeMinutes) },
    { label: "Flags", value: String(token.riskFlags.length) },
  ];
}

type TokenVerdict = "Investigate" | "Watch" | "Pass";

function tokenVerdict(token: TokenSignal): TokenVerdict {
  if (token.scores.risk >= 58 || token.riskFlags.some((flag) => /pre-dex|sell pressure|reversal/i.test(flag))) {
    return "Pass";
  }
  if (token.scores.final >= 58 || token.volumeAcceleration >= 2 || token.opportunityFlags.includes("buyers leading")) {
    return "Investigate";
  }
  return "Watch";
}

function verdictClass(verdict: TokenVerdict) {
  if (verdict === "Investigate") return "text-primary";
  if (verdict === "Pass") return "text-destructive";
  return "text-amber-600 dark:text-amber-300";
}

function verdictBorder(verdict: TokenVerdict) {
  if (verdict === "Investigate") return "border-l-primary";
  if (verdict === "Pass") return "border-l-destructive";
  return "border-l-amber-500";
}

function actionReasons(token: TokenSignal): string[] {
  const reasons: string[] = [];
  if (token.volumeAcceleration >= 1.5) reasons.push(`${fmtMult(token.volumeAcceleration)} volume`);
  if (token.txnAcceleration >= 1.5) reasons.push(`${fmtMult(token.txnAcceleration)} trades`);
  if (token.buyPressureH1 >= 0.56) reasons.push(`${fmtPct(token.buyPressureH1 * 100)} buyers`);
  if ((token.marketCap ?? Number.POSITIVE_INFINITY) < 350_000 && token.liquidityUsd > 18_000) reasons.push("early liquid");
  if (countSocialLinks(token) > 0) reasons.push(`${countSocialLinks(token)} social`);
  if (token.sourceTags.some((tag) => tag.includes("grpc"))) reasons.push("live tx");
  return reasons.slice(0, 4);
}

function TokenAvatar({ token, size = 14 }: { token: TokenSignal; size?: 9 | 10 | 12 | 14 | 16 | 20 }) {
  const [failed, setFailed] = useState(false);
  const initials = token.symbol.slice(0, 3).toUpperCase();
  const dim = {
    9: "h-9 w-9",
    10: "h-10 w-10",
    12: "h-12 w-12",
    14: "h-14 w-14",
    16: "h-16 w-16",
    20: "h-20 w-20",
  }[size];
  // image_outline: pure black at 10% in light, pure white at 10% in dark — never a tinted neutral.
  const outline =
    "shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]";
  const radius = size <= 10 ? "rounded-md" : size <= 14 ? "rounded-lg" : "rounded-xl";
  if (!token.imageUrl || failed) {
    return (
      <div
        className={`grid ${dim} ${radius} ${outline} shrink-0 place-items-center bg-muted font-mono text-[10px] font-semibold uppercase`}
        data-testid={`avatar-fallback-${token.id}`}
      >
        {initials}
      </div>
    );
  }
  return (
    <img
      src={token.imageUrl}
      alt=""
      referrerPolicy="no-referrer"
      className={`${dim} ${radius} ${outline} shrink-0 bg-muted object-cover`}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      data-testid={`img-token-${token.id}`}
    />
  );
}

const VOTED_SCAMS_KEY = "mvr.votedScams";
function loadVotedScams(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(VOTED_SCAMS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}
function persistVotedScams(set: Set<string>) {
  try {
    window.localStorage.setItem(VOTED_SCAMS_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // ignore
  }
}

function ScamPrompt({
  token,
  voted,
  onVoted,
}: {
  token: TokenSignal;
  voted: boolean;
  onVoted: (mint: string) => void;
}) {
  const [pending, setPending] = useState(false);
  if (voted || !token.suspectedScam) return null;
  const submit = async (isScam: boolean, ev: React.MouseEvent) => {
    ev.stopPropagation();
    if (pending) return;
    setPending(true);
    try {
      await fetch("/api/scam-vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mint: token.tokenAddress,
          isScam,
          signals: token.scamSignals,
        }),
      });
    } catch {
      // best-effort — still mark voted so the prompt doesn't pester
    } finally {
      onVoted(token.tokenAddress);
      setPending(false);
    }
  };
  return (
    <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1 font-mono text-[10px]">
      <span className="truncate text-destructive">
        scam? {token.scamSignals.slice(0, 2).join(", ")}
      </span>
      <div className="ml-auto flex gap-1">
        <button
          type="button"
          disabled={pending}
          onClick={(e) => submit(true, e)}
          className="h-5 rounded border border-destructive/50 bg-destructive/10 px-2 text-destructive hover:bg-destructive/20 disabled:opacity-50"
          style={{ transitionProperty: "background-color", transitionDuration: "120ms" }}
          data-testid={`button-scam-yes-${token.id}`}
        >
          yes
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={(e) => submit(false, e)}
          className="h-5 rounded border border-border bg-card px-2 text-muted-foreground hover:bg-accent disabled:opacity-50"
          style={{ transitionProperty: "background-color, color", transitionDuration: "120ms" }}
          data-testid={`button-scam-no-${token.id}`}
        >
          no
        </button>
      </div>
    </div>
  );
}

function verdictDot(verdict: TokenVerdict) {
  if (verdict === "Investigate") return "bg-primary";
  if (verdict === "Pass") return "bg-destructive";
  return "bg-amber-500";
}

function TokenCard({
  token,
  active,
  onSelect,
  votedScam,
  onVotedScam,
}: {
  token: TokenSignal;
  active: boolean;
  index: number;
  onSelect: (token: TokenSignal) => void;
  votedScam: boolean;
  onVotedScam: (mint: string) => void;
}) {
  const accel = token.volumeAcceleration ?? 0;
  const verdict = tokenVerdict(token);
  const risk = token.riskFlags[0];
  const dimmed = token.suspectedScam && !votedScam;
  // concentric radius: outer rounded-xl (12px) = inner rounded (4px) + p-2 (8px).
  return (
    <div
      className={`group relative rounded-xl border bg-card ${
        active
          ? "border-primary shadow-[0_0_0_1px_hsl(var(--primary)/0.55)_inset]"
          : "border-border/70 hover:border-foreground/30"
      } ${dimmed ? "opacity-50" : ""}`}
      style={{ transitionProperty: "border-color, box-shadow, opacity", transitionDuration: "160ms" }}
      data-testid={`button-token-${token.id}`}
    >
      <button
        type="button"
        onClick={() => onSelect(token)}
        className="flex w-full items-center gap-2.5 rounded-xl p-2 text-left will-change-transform active:scale-[0.99]"
        style={{ transitionProperty: "transform", transitionDuration: "120ms" }}
      >
        <TokenAvatar token={token} size={10} />

        <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1">
          {/* Row 1: SYMBOL + verdict dot   |   score */}
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className="truncate font-mono text-sm font-semibold uppercase leading-none tracking-tight"
              data-testid={`text-token-symbol-${token.id}`}
            >
              {token.symbol}
            </span>
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${verdictDot(verdict)}`}
              title={verdict}
            />
          </div>
          <span
            className={`font-mono text-base font-semibold tabular-nums leading-none ${scoreTone(token.scores.final)}`}
            data-testid={`text-final-score-${token.id}`}
          >
            {token.scores.final}
          </span>

          {/* Row 2: meta stats   |   accel */}
          <div className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] leading-none text-muted-foreground tabular-nums">
            <span className="truncate text-foreground/75">{fmtMoney(token.marketCap)}</span>
            <span aria-hidden="true" className="opacity-40">·</span>
            <span className="truncate">{fmtMoney(token.liquidityUsd)}</span>
            <span aria-hidden="true" className="opacity-40">·</span>
            <span className="truncate">{fmtAge(token.pairAgeMinutes)}</span>
            {risk ? (
              <>
                <span aria-hidden="true" className="opacity-40">·</span>
                <span className="truncate text-destructive">{risk}</span>
              </>
            ) : null}
          </div>
          <span
            className={`shrink-0 font-mono text-[10px] leading-none tabular-nums ${
              accel >= 1.5 ? "text-primary" : "text-muted-foreground"
            }`}
            title={`vol ${fmtMult(accel)} · tx ${fmtMult(token.txnAcceleration)}`}
          >
            {fmtMult(accel)}↑
          </span>
        </div>
      </button>

      {token.suspectedScam && !votedScam ? (
        <div className="px-2 pb-2">
          <ScamPrompt token={token} voted={votedScam} onVoted={onVotedScam} />
        </div>
      ) : null}
    </div>
  );
}

function shortAddress(addr: string) {
  if (!addr) return "n/a";
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function relTime(blockTime: number | null) {
  if (!blockTime) return "n/a";
  const sec = Math.max(0, Math.floor(Date.now() / 1000 - blockTime));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function HoldersCard({ data, error, loading }: { data: HoldersResponse | undefined; error: unknown; loading: boolean }) {
  const concentrated = (data?.top10Pct ?? 0) > 50;
  return (
    <div className="rounded-xl border border-border/70 bg-background p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Top holders</p>
        {data ? (
          <span className={`font-mono text-[10px] tabular-nums uppercase tracking-wider ${concentrated ? "text-destructive" : "text-muted-foreground"}`}>
            top10 {data.top10Pct.toFixed(1)}%
          </span>
        ) : null}
      </div>
      {loading && !data ? (
        <div className="space-y-1.5">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-5 rounded" />)}</div>
      ) : error ? (
        <p className="font-mono text-[11px] text-muted-foreground">Holder data unavailable.</p>
      ) : !data?.top.length ? (
        <p className="font-mono text-[11px] text-muted-foreground">No holder data returned.</p>
      ) : (
        <div className="divide-y divide-border/40">
          {data.top.slice(0, 10).map((h, i) => (
            <div key={h.address} className="flex items-center gap-2 py-1.5 first:pt-0 last:pb-0" data-testid={`holder-${i}`}>
              <span className="w-5 font-mono text-[10px] tabular-nums text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
              <a
                href={`https://solscan.io/account/${h.address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[11px] tabular-nums text-foreground/80 hover:text-primary"
                style={{ transitionProperty: "color", transitionDuration: "120ms" }}
              >
                {shortAddress(h.address)}
              </a>
              <div className="ml-auto flex items-center gap-2">
                <div className="hidden h-1 w-20 overflow-hidden rounded-full bg-muted sm:block">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, h.pct)}%` }} />
                </div>
                <span className="w-12 text-right font-mono text-[11px] tabular-nums">{h.pct.toFixed(2)}%</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TradesCard({ data, error, loading }: { data: TradesResponse | undefined; error: unknown; loading: boolean }) {
  return (
    <div className="rounded-xl border border-border/70 bg-background p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Recent activity</p>
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">signatures</span>
      </div>
      {loading && !data ? (
        <div className="space-y-1.5">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-5 rounded" />)}</div>
      ) : error ? (
        <p className="font-mono text-[11px] text-muted-foreground">Trade data unavailable.</p>
      ) : !data?.signatures.length ? (
        <p className="font-mono text-[11px] text-muted-foreground">No recent signatures.</p>
      ) : (
        <div className="divide-y divide-border/40">
          {data.signatures.slice(0, 15).map((tx) => (
            <a
              key={tx.signature}
              href={`https://solscan.io/tx/${tx.signature}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 py-1.5 hover:text-primary"
              style={{ transitionProperty: "color", transitionDuration: "120ms" }}
              data-testid={`trade-${tx.signature.slice(0, 8)}`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tx.err ? "bg-destructive" : "bg-primary"}`} aria-hidden="true" />
              <span className="font-mono text-[11px] tabular-nums text-foreground/80">{shortAddress(tx.signature)}</span>
              <span className="ml-auto font-mono text-[10px] tabular-nums uppercase tracking-wider text-muted-foreground">
                {relTime(tx.blockTime)}
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function DetailPanel({
  token,
  holders,
  holdersError,
  holdersLoading,
  trades,
  tradesError,
  tradesLoading,
}: {
  token: TokenSignal | undefined;
  holders: HoldersResponse | undefined;
  holdersError: unknown;
  holdersLoading: boolean;
  trades: TradesResponse | undefined;
  tradesError: unknown;
  tradesLoading: boolean;
}) {
  if (!token) {
    return (
      <Card className="h-full border-dashed" data-testid="empty-detail-panel">
        <CardContent className="grid h-full min-h-[420px] place-items-center p-8 text-center">
          <div>
            <h2 className="font-semibold">No row selected</h2>
            <p className="mt-2 text-sm text-muted-foreground">Select a row to inspect score, holders, signatures, and chart.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const chartUrl = token.pairAddress
    ? `https://dexscreener.com/solana/${token.pairAddress}?embed=1&theme=dark&info=0`
    : null;
  const verdict = tokenVerdict(token);
  const reasons = actionReasons(token);
  const risk = token.riskFlags[0] ?? token.dangerNote;

  return (
    <section className="flex h-full min-h-0 flex-col rounded-xl border border-border/70 bg-card" data-testid={`detail-panel-${token.id}`}>
      <div className="border-b border-border/70 p-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <TokenAvatar token={token} size={12} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="font-mono text-xl font-semibold uppercase leading-none tracking-tight" data-testid="text-selected-token">
                  {token.symbol}
                </p>
                <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${verdictDot(verdict)}`} />
                <span className={`font-mono text-[10px] uppercase tracking-wider ${verdictClass(verdict)}`}>{verdict}</span>
              </div>
              <p className="mt-1 truncate font-mono text-[11px] tabular-nums text-muted-foreground">
                {token.tokenAddress}
              </p>
            </div>
          </div>
          <div className="text-right">
            <p
              className={`font-mono text-4xl font-semibold leading-none tabular-nums tracking-tight ${scoreTone(token.scores.final)}`}
              data-testid="text-selected-score"
            >
              {token.scores.final}
            </p>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">score</p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
        <div>
          {chartUrl ? (
            <div className="overflow-hidden rounded-xl border border-border/70 bg-background">
              <iframe
                src={chartUrl}
                title={`${token.symbol} chart`}
                className="block h-[420px] w-full border-0"
                loading="lazy"
                data-testid="iframe-chart"
              />
            </div>
          ) : (
            <div className="rounded-xl border border-border/70 bg-background p-6 text-center" data-testid="chart-no-pair">
              <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">pair not indexed</p>
              <p className="mt-1.5 font-body text-xs text-muted-foreground">Holders and signatures may still be available.</p>
            </div>
          )}
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-3">
          <div className="rounded-lg border border-border/70 bg-background p-2.5">
            <p className="truncate font-mono text-sm font-semibold tabular-nums">{reasons.length ? reasons.join(" / ") : "—"}</p>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">drivers</p>
          </div>
          <div className="rounded-lg border border-border/70 bg-background p-2.5">
            <p className="truncate font-mono text-sm font-semibold text-destructive">{risk || "—"}</p>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">risk</p>
          </div>
          <div className="rounded-lg border border-border/70 bg-background p-2.5">
            <p className="font-mono text-sm font-semibold tabular-nums">{fmtAge(token.pairAgeMinutes)}</p>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">age</p>
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          <ScorePill label="Velocity" value={token.scores.velocity} drivers={velocityDrivers(token)} />
          <ScorePill label="Virality" value={token.scores.virality} drivers={viralityDrivers(token)} />
          <ScorePill label="Upside" value={token.scores.upside} drivers={upsideDrivers(token)} />
          <ScorePill label="Risk" value={token.scores.risk} drivers={riskDrivers(token)} danger />
        </div>

        <div className="mt-3 grid gap-3 xl:grid-cols-2">
          <HoldersCard data={holders} error={holdersError} loading={holdersLoading} />
          <TradesCard data={trades} error={tradesError} loading={tradesLoading} />
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {token.url ? (
            <Button asChild variant="default" size="sm" data-testid="link-open-dexscreener">
              <a href={token.url} target="_blank" rel="noopener noreferrer">
                DexScreener <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
              </a>
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigator.clipboard?.writeText(token.tokenAddress)}
            data-testid="button-copy-address"
          >
            Copy mint <Copy className="ml-1.5 h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </section>
  );
}

function MetaRail({ snapshot }: { snapshot: RadarSnapshot | undefined }) {
  return (
    <aside className="rounded-lg border border-border/70 bg-card p-3" data-testid="meta-rail">
      <div className="mb-2 flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">metas</p>
      </div>
      <div className="divide-y divide-border/40">
        {snapshot?.metas?.length ? snapshot.metas.slice(0, 6).map((meta, i) => {
          const change = meta.marketCapChange.h1 ?? 0;
          const positive = change >= 0;
          return (
            <div key={meta.slug} className="py-2 first:pt-0 last:pb-0" data-testid={`card-meta-${meta.slug}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <p className="truncate text-xs font-medium">{meta.name}</p>
                </div>
                <span className={`flex items-center gap-0.5 font-mono text-[11px] tabular-nums ${positive ? "text-emerald-400" : "text-red-400"}`}>
                  {trendIcon(change)}
                  {fmtPct(change)}
                </span>
              </div>
            </div>
          );
        }) : Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="my-2 h-9 rounded-md" />)}
      </div>
    </aside>
  );
}

function BottomStatusBar({
  snapshot,
  live,
  setLive,
  onRefresh,
  refreshing,
  svsHealth,
  grpcStatus,
  visibleCount,
}: {
  snapshot: RadarSnapshot | undefined;
  live: boolean;
  setLive: (value: boolean) => void;
  onRefresh: () => void;
  refreshing: boolean;
  svsHealth: SvsHealthReport | undefined;
  grpcStatus: GrpcStatusReport | undefined;
  visibleCount: number;
}) {
  const generated = snapshot ? new Date(snapshot.generatedAt) : null;
  const okSources = snapshot?.sourceHealth.filter((source) => source.status === "ok").length ?? 0;
  const totalSources = snapshot?.sourceHealth.length ?? 4;
  const svsLabel =
    svsHealth?.overall === "ok" ? "SVS: connected"
    : svsHealth?.overall === "degraded" ? "SVS: degraded"
    : svsHealth?.overall === "error" ? "SVS: error"
    : svsHealth?.overall === "missing" ? "SVS: not configured"
    : "SVS: n/a";
  const grpcLabel = !grpcStatus
    ? "gRPC: n/a"
    : !grpcStatus.endpointConfigured
      ? "gRPC: not configured"
      : `gRPC: ${grpcStatus.status === "connected" ? "live" : grpcStatus.status} / ${grpcStatus.candidateCount} mints`;
  return (
    <div className="bottom-status-bar" data-testid="bottom-status-bar">
      <div className="flex min-w-0 flex-1 items-center gap-0 overflow-x-auto">
        <Button
          size="sm"
          variant={live ? "default" : "outline"}
          onClick={() => setLive(!live)}
          data-testid="button-toggle-live"
          className="h-5 rounded-none border-0 px-2 font-mono text-[9px] tracking-normal"
        >
          {live ? "Live" : "Paused"}
        </Button>
        <StatusCell testId="text-updated-at" label={`updated ${generated ? generated.toLocaleTimeString() : "n/a"}`} />
        <StatusCell testId="text-scanned-count" label={`${snapshot?.scannedTokens ?? "n/a"} candidates`} />
        <StatusCell label={`${visibleCount}/${snapshot?.tokens.length ?? 0} signals`} />
        <StatusCell testId="text-latency" label={`${snapshot ? snapshot.latencyMs : "n/a"}ms`} />
        <StatusCell label={`${okSources}/${totalSources} feeds`} />
        <StatusCell label={svsLabel} />
        <StatusCell label={grpcLabel} />
      </div>
      <div className="flex shrink-0 items-center">
        <Button
          size="sm"
          variant="outline"
          onClick={onRefresh}
          disabled={refreshing}
          data-testid="button-refresh"
          className="h-5 rounded-none border-0 border-l border-border px-2 font-mono text-[9px] tracking-normal"
        >
          <RefreshCcw className={`mr-1 h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
          refresh
        </Button>
      </div>
    </div>
  );
}

function StatusCell({ label, testId, hidden = false }: { label: string; testId?: string; hidden?: boolean }) {
  if (hidden) return null;
  return (
    <span
      className="shrink-0 border-l border-border px-2 font-mono text-[9px] leading-5 tracking-normal text-muted-foreground first:border-l-0"
      data-testid={testId}
    >
      {label}
    </span>
  );
}

function exportCsv(tokens: TokenSignal[]) {
  const headers = ["symbol", "mint", "score", "velocity", "virality", "upside", "risk", "market_cap", "liquidity", "volume_m5", "volume_h1", "buy_pressure_h1", "url"];
  const rows = tokens.map((token) => [
    token.symbol,
    token.tokenAddress,
    token.scores.final,
    token.scores.velocity,
    token.scores.virality,
    token.scores.upside,
    token.scores.risk,
    token.marketCap ?? "",
    token.liquidityUsd,
    token.volume.m5 ?? 0,
    token.volume.h1 ?? 0,
    token.buyPressureH1,
    token.url,
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `signals-${new Date().toISOString().slice(0, 19)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function BrokenScreen({
  snapshot,
  onRetry,
  retrying,
}: {
  snapshot: RadarSnapshot | undefined;
  onRetry: () => void;
  retrying: boolean;
}) {
  const sources = snapshot?.brokenSources ?? [];
  return (
    <div className="min-h-screen bg-background" data-testid="broken-screen">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <div className="mb-6 flex items-center gap-3">
          <div className="rounded-lg bg-destructive/10 p-2 text-destructive">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">feed unavailable</h1>
            <p className="text-sm text-muted-foreground">
              One or more required upstreams are not delivering.
            </p>
          </div>
        </div>
        <Card className="border-destructive/30">
          <CardContent className="p-5">
            <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Broken sources ({sources.length})
            </p>
            {sources.length ? (
              <ul className="space-y-2">
                {sources.map((line, i) => (
                  <li
                    key={`${i}-${line}`}
                    className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs"
                    data-testid={`broken-source-${i}`}
                  >
                    {line}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No source detail returned.</p>
            )}
            <div className="mt-5 flex flex-wrap gap-2">
              <Button onClick={onRetry} disabled={retrying} data-testid="button-broken-retry">
                <RefreshCcw className={`mr-2 h-4 w-4 ${retrying ? "animate-spin" : ""}`} />
                Retry
              </Button>
              <Button variant="outline" asChild data-testid="link-broken-raw">
                <a href="#/raw">raw</a>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function RadarHome() {
  const { theme, setTheme } = useTheme();
  const [live, setLive] = useState(true);
  const [sortMode, setSortMode] = useState<SortMode>("score");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [votedScams, setVotedScams] = useState<Set<string>>(() => loadVotedScams());
  const markScamVoted = (mint: string) => {
    setVotedScams((prev) => {
      if (prev.has(mint)) return prev;
      const next = new Set(prev);
      next.add(mint);
      persistVotedScams(next);
      return next;
    });
  };
  const [streamSnapshot, setStreamSnapshot] = useState<RadarSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const { data, isLoading, error, refetch } = useQuery<RadarSnapshot>({
    queryKey: ["/api/radar"],
    refetchInterval: live ? false : 30_000,
  });

  const { data: svsHealth } = useQuery<SvsHealthReport>({
    queryKey: ["/api/svs/health"],
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: grpcStatus } = useQuery<GrpcStatusReport>({
    queryKey: ["/api/grpc/status"],
    refetchInterval: 15_000,
    staleTime: 5_000,
  });

  const snapshot = streamSnapshot ?? data;

  const selectedMint = useMemo(() => {
    const tokens = (streamSnapshot ?? data)?.tokens ?? [];
    const sel = tokens.find((t) => t.id === selectedId) ?? tokens[0];
    return sel?.tokenAddress ?? null;
  }, [streamSnapshot, data, selectedId]);

  const {
    data: holders,
    error: holdersError,
    isLoading: holdersLoading,
  } = useQuery<HoldersResponse>({
    queryKey: ["/api/token", selectedMint, "holders"],
    enabled: !!selectedMint,
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  const {
    data: trades,
    error: tradesError,
    isLoading: tradesLoading,
  } = useQuery<TradesResponse>({
    queryKey: ["/api/token", selectedMint, "trades"],
    enabled: !!selectedMint,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  useEffect(() => {
    if (!live) return undefined;
    const source = new EventSource(`${EVENT_BASE}/api/radar/stream`);
    source.addEventListener("radar", (event) => {
      const next = JSON.parse((event as MessageEvent).data) as RadarSnapshot;
      setStreamSnapshot(next);
    });
    source.onerror = () => {
      source.close();
    };
    return () => source.close();
  }, [live]);

  const visibleTokens = useMemo(() => {
    const tokens = snapshot?.tokens ?? [];
    const searched = tokens.filter((token) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return `${token.symbol} ${token.tokenAddress}`.toLowerCase().includes(q);
    });
    const filtered = searched.filter((token) => {
      if (filterMode === "turbo") return token.volumeAcceleration >= 1.5 || token.scores.velocity >= 70;
      if (filterMode === "early") return (token.marketCap ?? 999_999_999) < 350_000 || (token.pairAgeMinutes ?? 9999) < 120;
      if (filterMode === "social") return token.links.some((link) => /x\.com|twitter|t\.me|telegram|discord/i.test(link.url));
      if (filterMode === "lower-risk") return token.scores.risk < 35 && token.liquidityUsd > 18_000;
      return true;
    });
    return filtered.sort((a, b) => {
      if (sortMode === "velocity") return b.scores.velocity - a.scores.velocity;
      if (sortMode === "virality") return b.scores.virality - a.scores.virality;
      if (sortMode === "upside") return b.scores.upside - a.scores.upside;
      if (sortMode === "risk") return a.scores.risk - b.scores.risk;
      return b.scores.final - a.scores.final;
    });
  }, [snapshot, search, filterMode, sortMode]);

  const selectedToken = useMemo(() => {
    if (!visibleTokens.length) return undefined;
    return visibleTokens.find((token) => token.id === selectedId) ?? visibleTokens[0];
  }, [visibleTokens, selectedId]);

  async function hardRefresh() {
    setRefreshing(true);
    try {
      const response = await apiRequest("GET", "/api/radar?force=1");
      const next = (await response.json()) as RadarSnapshot;
      setStreamSnapshot(next);
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }

  if (snapshot && snapshot.status === "broken") {
    return <BrokenScreen snapshot={snapshot} onRetry={hardRefresh} retrying={refreshing} />;
  }

  return (
    <div className="dashboard-shell">
      <aside className="sidebar-panel">
        <div className="mb-4 flex items-center justify-between border-b border-border pb-3">
          <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground" data-testid="brand-logo">queue</span>
          <a
            href="#/raw"
            className="font-mono text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
            data-testid="link-raw-feed"
          >
            raw
          </a>
        </div>

        <div className="space-y-1">
          <p className="px-2 pb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">filters</p>
          {[
            ["all", "All"],
            ["turbo", "Moving"],
            ["early", "Early"],
            ["social", "Social"],
            ["lower-risk", "Lower risk"],
          ].map(([key, label]) => (
            <button
              key={key as string}
              type="button"
              onClick={() => setFilterMode(key as FilterMode)}
              className={`flex min-h-[36px] w-full items-center rounded-md px-3 text-sm active:scale-[0.98] ${
                filterMode === key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
              style={{ transitionProperty: "background-color, color, transform", transitionDuration: "120ms" }}
              data-testid={`button-filter-${key}`}
            >
              {label as string}
            </button>
          ))}
        </div>

        <div className="mt-8">
          <MetaRail snapshot={snapshot} />
        </div>
      </aside>

      <main className="main-panel">
        <header className="sticky top-0 z-10 border-b border-border bg-background/92 px-4 py-2.5 backdrop-blur">
          <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="ticker or mint"
                  className="h-9 w-full rounded-md border border-input bg-card pl-8 pr-3 font-mono text-xs outline-none focus:ring-2 focus:ring-ring sm:w-72"
                  data-testid="input-search"
                />
              </div>
              <Button variant="outline" size="sm" onClick={() => exportCsv(visibleTokens)} data-testid="button-export-csv">
                <Download className="mr-1.5 h-3.5 w-3.5" /> CSV
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-9 w-9 p-0"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                aria-label="Toggle theme"
                data-testid="button-toggle-theme"
              >
                {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>
        </header>

        <div className="space-y-3 p-4">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <Tabs value={sortMode} onValueChange={(value) => setSortMode(value as SortMode)} data-testid="tabs-sort-mode">
              <TabsList className="flex h-auto flex-wrap justify-start">
                <TabsTrigger value="score" data-testid="tab-sort-score">Score</TabsTrigger>
                <TabsTrigger value="velocity" data-testid="tab-sort-velocity">Velocity</TabsTrigger>
                <TabsTrigger value="virality" data-testid="tab-sort-virality">Virality</TabsTrigger>
                <TabsTrigger value="upside" data-testid="tab-sort-upside">Upside</TabsTrigger>
                <TabsTrigger value="risk" data-testid="tab-sort-risk">Low risk</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {error ? (
            <Card className="border-destructive/40" data-testid="error-state">
              <CardContent className="flex items-center gap-3 p-5">
                <AlertTriangle className="h-5 w-5 text-destructive" />
                <div>
                  <p className="font-medium">feed failed</p>
                  <p className="text-sm text-muted-foreground">{error instanceof Error ? error.message : "Unknown error"}</p>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {isLoading && !snapshot ? (
            <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
              <div className="space-y-1.5">{Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-[58px] rounded-xl" />)}</div>
              <Skeleton className="min-h-[560px] rounded-xl" />
            </div>
          ) : (
            <div className="grid min-h-[640px] gap-4 xl:grid-cols-[360px_1fr]">
              <section className="min-h-0 space-y-1.5 xl:max-h-[calc(100dvh-200px)] xl:overflow-y-auto xl:pr-1" data-testid="token-list">
                {visibleTokens.length ? visibleTokens.map((token, idx) => (
                  <TokenCard
                    key={token.id}
                    token={token}
                    index={idx}
                    active={selectedToken?.id === token.id}
                    onSelect={(next) => setSelectedId(next.id)}
                    votedScam={votedScams.has(token.tokenAddress)}
                    onVotedScam={markScamVoted}
                  />
                )) : (
                  <Card className="border-dashed" data-testid="empty-token-list">
                    <CardContent className="p-8 text-center">
                      <p className="font-medium">no matches</p>
                      <p className="mt-1 text-sm text-muted-foreground">Broaden filters or refresh.</p>
                    </CardContent>
                  </Card>
                )}
              </section>
              <DetailPanel
                token={selectedToken}
                holders={holders}
                holdersError={holdersError}
                holdersLoading={holdersLoading}
                trades={trades}
                tradesError={tradesError}
                tradesLoading={tradesLoading}
              />
            </div>
          )}
        </div>
      </main>

      <BottomStatusBar
        snapshot={snapshot}
        live={live}
        setLive={setLive}
        onRefresh={hardRefresh}
        refreshing={refreshing}
        svsHealth={svsHealth}
        grpcStatus={grpcStatus}
        visibleCount={visibleTokens.length}
      />
    </div>
  );
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={RadarHome} />
      <Route path="/raw" component={RawFeedPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router hook={useHashLocation}>
          <AppRouter />
        </Router>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
