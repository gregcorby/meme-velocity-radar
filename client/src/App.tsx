import { useEffect, useMemo, useState } from "react";
import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import NotFound from "@/pages/not-found";
import RawFeedPage from "@/pages/raw-feed";
import type { RadarSnapshot, TokenSignal } from "@shared/schema";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  Flame,
  Gauge,
  Moon,
  Radar,
  RefreshCcw,
  Search,
  ShieldAlert,
  SignalHigh,
  Sparkles,
  Sun,
  Zap,
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

function Logo() {
  return (
    <div className="flex items-center gap-3" data-testid="brand-logo">
      <svg aria-label="Velocity meme radar logo" viewBox="0 0 44 44" className="h-9 w-9 text-primary">
        <path d="M22 5.5 37.5 14v16L22 38.5 6.5 30V14L22 5.5Z" fill="none" stroke="currentColor" strokeWidth="2.4" />
        <path d="M14 25.5c4.4-8.9 10.8-10.2 19-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M15.5 17.5h.01M28.5 29h.01" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
        <path d="M21.8 12.5v7.8l6.2-3.2" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div>
        <p className="font-semibold leading-none tracking-tight">Meme Velocity</p>
        <p className="text-xs text-muted-foreground">Solana fast feed</p>
      </div>
    </div>
  );
}

function SvsBadge({ health }: { health: SvsHealthReport | undefined }) {
  if (!health) {
    return (
      <Badge variant="outline" data-testid="badge-svs-status" title="Solana Vibe Station status loading">
        SVS: …
      </Badge>
    );
  }
  const variant: "default" | "secondary" | "destructive" | "outline" =
    health.overall === "ok" ? "default"
    : health.overall === "degraded" ? "secondary"
    : health.overall === "error" ? "destructive"
    : "outline";
  const label =
    health.overall === "ok" ? "connected"
    : health.overall === "degraded" ? "degraded"
    : health.overall === "error" ? "error"
    : "not configured";
  const tooltip = [
    `API: ${health.api.status}${health.api.detail ? ` (${health.api.detail})` : ""}`,
    `RPC: ${health.rpc.status}${health.rpc.detail ? ` (${health.rpc.detail})` : ""}`,
    `gRPC: ${health.grpc.status}${health.grpc.detail ? ` (${health.grpc.detail})` : ""}`,
  ].join(" · ");
  return (
    <Badge variant={variant} data-testid="badge-svs-status" title={tooltip}>
      SVS: {label}
    </Badge>
  );
}

function GrpcBadge({ status }: { status: GrpcStatusReport | undefined }) {
  if (!status) {
    return (
      <Badge variant="outline" data-testid="badge-grpc-status" title="Live gRPC status loading">
        gRPC: …
      </Badge>
    );
  }
  if (!status.endpointConfigured) {
    return (
      <Badge variant="outline" data-testid="badge-grpc-status" title="SVS_GRPC_ENDPOINT not set">
        gRPC: not configured
      </Badge>
    );
  }
  const variant: "default" | "secondary" | "destructive" | "outline" =
    status.status === "connected" ? "default"
    : status.status === "reconnecting" || status.status === "connecting" || status.status === "configured" ? "secondary"
    : status.status === "error" ? "destructive"
    : "outline";
  const label = status.status === "connected" ? "live" : status.status;
  const ageBit = status.lastEventAgeSec != null
    ? `, ${status.lastEventAgeSec < 90 ? `${status.lastEventAgeSec}s` : `${Math.floor(status.lastEventAgeSec / 60)}m`} since last event`
    : "";
  const tooltip = `Status: ${status.status}${ageBit} · ${status.candidateCount} live mints · ${status.eventsPerMinute}/min · filters: ${status.filters.join(", ") || "—"}${status.lastError ? ` · last error: ${status.lastError}` : ""}`;
  return (
    <Badge variant={variant} data-testid="badge-grpc-status" title={tooltip}>
      gRPC: {label} · {status.candidateCount} mints
    </Badge>
  );
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
  return (
    <div className="rounded-2xl border border-border bg-card p-4" data-testid={`score-${label.toLowerCase()}`}>
      <div className="flex items-baseline justify-between">
        <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
        <span className={`font-mono text-2xl font-semibold leading-none tracking-tight ${danger ? riskTone(value) : scoreTone(value)}`}>
          {value}
        </span>
      </div>
      <div className="mt-3 divide-y divide-border/50">
        {drivers.map((d) => (
          <div key={d.label} className="flex items-center justify-between py-1.5 first:pt-0 last:pb-0">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{d.label}</span>
            <span className="font-mono text-xs text-foreground/85">{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function fmtMult(value: number) {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(value >= 10 ? 0 : 1)}×`;
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
    { label: "Desc len", value: String(token.description?.length ?? 0) },
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

function TokenAvatar({ token, size = 14 }: { token: TokenSignal; size?: 12 | 14 | 16 | 20 }) {
  const [failed, setFailed] = useState(false);
  const initials = token.symbol.slice(0, 3).toUpperCase();
  const dim = { 12: "h-12 w-12", 14: "h-14 w-14", 16: "h-16 w-16", 20: "h-20 w-20" }[size];
  if (!token.imageUrl || failed) {
    return (
      <div
        className={`grid ${dim} shrink-0 place-items-center rounded-xl border border-border bg-muted font-mono text-xs font-semibold`}
        data-testid={`avatar-fallback-${token.id}`}
      >
        {initials}
      </div>
    );
  }
  return (
    <img
      src={token.imageUrl}
      alt={`${token.name} token artwork`}
      className={`${dim} shrink-0 rounded-xl border border-border object-cover`}
      crossOrigin="anonymous"
      onError={() => setFailed(true)}
      data-testid={`img-token-${token.id}`}
    />
  );
}

function TokenCard({
  token,
  active,
  index,
  onSelect,
}: {
  token: TokenSignal;
  active: boolean;
  index: number;
  onSelect: (token: TokenSignal) => void;
}) {
  const accel = token.volumeAcceleration ?? 0;
  const accelHot = accel >= 1.5;
  return (
    <button
      type="button"
      onClick={() => onSelect(token)}
      className={`group relative w-full rounded-2xl border bg-card p-4 text-left transition hover:border-primary/60 ${
        active ? "border-primary" : "border-border"
      }`}
      data-testid={`button-token-${token.id}`}
    >
      <div className="flex items-start gap-4">
        <TokenAvatar token={token} size={14} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] font-medium tracking-[0.2em] text-muted-foreground">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <p className="truncate font-mono text-xs uppercase tracking-wider text-muted-foreground">
                  {token.symbol}
                </p>
              </div>
              <p className="mt-1 truncate text-base font-semibold leading-tight tracking-tight" data-testid={`text-token-name-${token.id}`}>
                {token.name}
              </p>
            </div>
            <div className="text-right">
              <p className={`font-mono text-3xl font-semibold leading-none tracking-tight ${scoreTone(token.scores.final)}`} data-testid={`text-final-score-${token.id}`}>
                {token.scores.final}
              </p>
              <p className="mt-1 font-mono text-sm text-foreground/80">{fmtMoney(token.marketCap)}</p>
              <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                liq {fmtMoney(token.liquidityUsd)}
              </p>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span
              className={`rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider ${
                accelHot
                  ? "border-primary/60 bg-primary/10 text-primary"
                  : "border-border bg-muted/60 text-muted-foreground"
              }`}
            >
              vol {fmtMult(accel)}
            </span>
            {token.opportunityFlags.slice(0, 1).map((flag) => (
              <span
                key={flag}
                className="rounded-full border border-border bg-muted/60 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
                data-testid={`badge-opportunity-${token.id}-${flag}`}
              >
                {flag}
              </span>
            ))}
            {token.riskFlags.slice(0, 1).map((flag) => (
              <span
                key={flag}
                className="rounded-full border border-destructive/40 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-destructive"
                data-testid={`badge-risk-${token.id}-${flag}`}
              >
                {flag}
              </span>
            ))}
          </div>
        </div>
      </div>
    </button>
  );
}

function shortAddress(addr: string) {
  if (!addr) return "—";
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function relTime(blockTime: number | null) {
  if (!blockTime) return "—";
  const sec = Math.max(0, Math.floor(Date.now() / 1000 - blockTime));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function HoldersCard({ data, error, loading }: { data: HoldersResponse | undefined; error: unknown; loading: boolean }) {
  const concentrated = (data?.top10Pct ?? 0) > 50;
  return (
    <div className="rounded-2xl border border-border bg-background p-5">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">Top holders</p>
        {data ? (
          <span className={`font-mono text-[10px] uppercase tracking-wider ${concentrated ? "text-destructive" : "text-muted-foreground"}`}>
            top10 {data.top10Pct.toFixed(1)}%
          </span>
        ) : null}
      </div>
      {loading && !data ? (
        <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-6 rounded" />)}</div>
      ) : error ? (
        <p className="font-body text-xs text-muted-foreground">Holder data unavailable.</p>
      ) : !data?.top.length ? (
        <p className="font-body text-xs text-muted-foreground">No holder data returned.</p>
      ) : (
        <div className="divide-y divide-border/50">
          {data.top.slice(0, 10).map((h, i) => (
            <div key={h.address} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0" data-testid={`holder-${i}`}>
              <span className="w-6 font-mono text-[10px] tracking-[0.18em] text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
              <a
                href={`https://solscan.io/account/${h.address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-xs text-foreground/80 hover:text-primary"
              >
                {shortAddress(h.address)}
              </a>
              <div className="ml-auto flex items-center gap-2">
                <div className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-muted sm:block">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, h.pct)}%` }} />
                </div>
                <span className="font-mono text-xs tabular-nums">{h.pct.toFixed(2)}%</span>
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
    <div className="rounded-2xl border border-border bg-background p-5">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">Recent activity</p>
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">signatures</span>
      </div>
      {loading && !data ? (
        <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-6 rounded" />)}</div>
      ) : error ? (
        <p className="font-body text-xs text-muted-foreground">Trade data unavailable.</p>
      ) : !data?.signatures.length ? (
        <p className="font-body text-xs text-muted-foreground">No recent signatures.</p>
      ) : (
        <div className="divide-y divide-border/50">
          {data.signatures.slice(0, 15).map((tx) => (
            <a
              key={tx.signature}
              href={`https://solscan.io/tx/${tx.signature}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 py-2 hover:text-primary"
              data-testid={`trade-${tx.signature.slice(0, 8)}`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tx.err ? "bg-destructive" : "bg-primary"}`} aria-hidden="true" />
              <span className="font-mono text-xs text-foreground/80">{shortAddress(tx.signature)}</span>
              <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
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
  onOpenSheet,
  holders,
  holdersError,
  holdersLoading,
  trades,
  tradesError,
  tradesLoading,
}: {
  token: TokenSignal | undefined;
  onOpenSheet: () => void;
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
            <Radar className="mx-auto mb-4 h-10 w-10 text-muted-foreground" />
            <h2 className="font-semibold">No token selected</h2>
            <p className="mt-2 text-sm text-muted-foreground">Choose a signal from the radar to decode the meme and inspect its score.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const chartUrl = token.pairAddress
    ? `https://dexscreener.com/solana/${token.pairAddress}?embed=1&theme=dark&info=0`
    : null;

  return (
    <section className="flex h-full min-h-0 flex-col rounded-2xl border border-border bg-card" data-testid={`detail-panel-${token.id}`}>
      <div className="border-b border-border p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4">
            <TokenAvatar token={token} size={16} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  {token.symbol}
                </span>
                <span className="rounded-full border border-border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground" data-testid="badge-meme-type">
                  {token.memeType}
                </span>
              </div>
              <h1 className="mt-1 truncate text-2xl font-semibold leading-tight tracking-tight" data-testid="text-selected-token">
                {token.name}
              </h1>
              <p className="mt-2 truncate font-mono text-[11px] text-muted-foreground">{token.tokenAddress}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">Radar score</p>
            <p className={`mt-1 font-mono text-5xl font-semibold leading-none tracking-tight ${scoreTone(token.scores.final)}`} data-testid="text-selected-score">
              {token.scores.final}
            </p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <ScorePill label="Velocity" value={token.scores.velocity} drivers={velocityDrivers(token)} />
          <ScorePill label="Virality" value={token.scores.virality} drivers={viralityDrivers(token)} />
          <ScorePill label="Upside" value={token.scores.upside} drivers={upsideDrivers(token)} />
          <ScorePill label="Risk" value={token.scores.risk} drivers={riskDrivers(token)} danger />
        </div>

        <div className="mt-5">
          {chartUrl ? (
            <div className="overflow-hidden rounded-2xl border border-border bg-background">
              <iframe
                src={chartUrl}
                title={`${token.symbol} chart`}
                className="block h-[420px] w-full border-0"
                loading="lazy"
                data-testid="iframe-chart"
              />
            </div>
          ) : (
            <div className="rounded-2xl border border-border bg-background p-8 text-center" data-testid="chart-no-pair">
              <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">No pair indexed yet</p>
              <p className="mt-2 font-body text-sm text-muted-foreground">
                This mint is fresh from the gRPC stream — DexScreener has not picked up a pool yet. Holders + signatures still load below.
              </p>
            </div>
          )}
        </div>

        <div className="mt-5 grid gap-4 xl:grid-cols-2">
          <HoldersCard data={holders} error={holdersError} loading={holdersLoading} />
          <TradesCard data={trades} error={tradesError} loading={tradesLoading} />
        </div>

        <div className="mt-5 grid gap-4 xl:grid-cols-3">
          <div className="rounded-2xl border border-border bg-background p-5 xl:col-span-2">
            <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">What is the meme?</p>
            <p className="mt-3 font-body text-sm leading-relaxed text-foreground/80" data-testid="text-meme-decode">
              {token.memeDecode}
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-background p-5">
            <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">Risk note</p>
            <p className="mt-3 font-body text-xs leading-relaxed text-foreground/80" data-testid="text-danger-note">
              {token.dangerNote}
            </p>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {token.riskFlags.length ? token.riskFlags.map((flag) => (
                <span key={flag} className="rounded-full border border-destructive/40 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-destructive">
                  {flag}
                </span>
              )) : <span className="rounded-full border border-border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">scanner clean</span>}
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {token.url ? (
            <Button asChild variant="default" size="sm" data-testid="link-open-dexscreener">
              <a href={token.url} target="_blank" rel="noopener noreferrer">
                Open DexScreener <ExternalLink className="ml-2 h-3.5 w-3.5" />
              </a>
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={onOpenSheet} data-testid="button-open-meme-sheet">
            Full thesis <ChevronDown className="ml-2 h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigator.clipboard?.writeText(token.tokenAddress)}
            data-testid="button-copy-address"
          >
            Copy mint <Copy className="ml-2 h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </section>
  );
}

function MetaRail({ snapshot }: { snapshot: RadarSnapshot | undefined }) {
  return (
    <aside className="rounded-2xl border border-border bg-card p-5" data-testid="meta-rail">
      <div className="mb-5 flex items-center justify-between">
        <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">Hot metas</p>
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">dexscreener</span>
      </div>
      <div className="divide-y divide-border/60">
        {snapshot?.metas?.length ? snapshot.metas.slice(0, 6).map((meta, i) => {
          const change = meta.marketCapChange.h1 ?? 0;
          const positive = change >= 0;
          return (
            <div key={meta.slug} className="py-3 first:pt-0 last:pb-0" data-testid={`card-meta-${meta.slug}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="h-1 w-1 rounded-full bg-primary" aria-hidden="true" />
                  <p className="truncate text-sm font-medium">{meta.name}</p>
                </div>
                <span className={`flex items-center gap-0.5 font-mono text-xs ${positive ? "text-emerald-400" : "text-red-400"}`}>
                  {trendIcon(change)}
                  {fmtPct(change)}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 pl-9 font-body text-xs leading-relaxed text-muted-foreground">{meta.description}</p>
            </div>
          );
        }) : Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="my-3 h-12 rounded-lg" />)}
      </div>
    </aside>
  );
}

function SnapshotBar({
  snapshot,
  live,
  setLive,
  onRefresh,
  refreshing,
}: {
  snapshot: RadarSnapshot | undefined;
  live: boolean;
  setLive: (value: boolean) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const generated = snapshot ? new Date(snapshot.generatedAt) : null;
  const okSources = snapshot?.sourceHealth.filter((source) => source.status === "ok").length ?? 0;
  const totalSources = snapshot?.sourceHealth.length ?? 4;
  const tile = "rounded-2xl border border-border bg-card p-5";
  const labelClass = "text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground";
  return (
    <div className="grid gap-3 md:grid-cols-4" data-testid="snapshot-bar">
      <div className={tile}>
        <p className={labelClass}>Mode</p>
        <p className="mt-2 truncate text-lg font-semibold tracking-tight" data-testid="text-data-mode">
          {snapshot?.dataMode ?? "warming"}
        </p>
      </div>
      <div className={tile}>
        <p className={labelClass}>Scanned</p>
        <p className="mt-2 font-mono text-3xl font-semibold leading-none tracking-tight" data-testid="text-scanned-count">
          {snapshot?.scannedTokens ?? "—"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">candidates</p>
      </div>
      <div className={tile}>
        <p className={labelClass}>Latency</p>
        <p className="mt-2 font-mono text-3xl font-semibold leading-none tracking-tight" data-testid="text-latency">
          {snapshot ? snapshot.latencyMs : "—"}
          <span className="ml-1 text-xs font-normal text-muted-foreground">ms</span>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{okSources}/{totalSources} feeds ok</p>
      </div>
      <div className={`${tile} flex items-center justify-between`}>
        <div className="min-w-0">
          <p className={labelClass}>Updated</p>
          <p className="mt-2 font-mono text-base font-semibold tracking-tight" data-testid="text-updated-at">
            {generated ? generated.toLocaleTimeString() : "—"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="icon"
            variant={live ? "default" : "outline"}
            onClick={() => setLive(!live)}
            aria-label={live ? "Disable live stream" : "Enable live stream"}
            data-testid="button-toggle-live"
            className="rounded-full"
          >
            <Zap className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="outline"
            onClick={onRefresh}
            aria-label="Refresh radar"
            disabled={refreshing}
            data-testid="button-refresh"
            className="rounded-full"
          >
            <RefreshCcw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>
    </div>
  );
}

function exportCsv(tokens: TokenSignal[]) {
  const headers = ["symbol", "name", "score", "velocity", "virality", "upside", "risk", "market_cap", "liquidity", "volume_m5", "volume_h1", "buy_pressure_h1", "meme_type", "risk_flags", "url"];
  const rows = tokens.map((token) => [
    token.symbol,
    token.name,
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
    token.memeType,
    token.riskFlags.join("; "),
    token.url,
  ]);
  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `meme-velocity-${new Date().toISOString().slice(0, 19)}.csv`;
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
            <h1 className="text-xl font-semibold tracking-tight">Radar is broken</h1>
            <p className="text-sm text-muted-foreground">
              At least one required upstream is not delivering. We never serve a degraded radar — fix the source(s) below to restore.
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
                <a href="#/raw">Open raw feed</a>
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
  const [sheetOpen, setSheetOpen] = useState(false);
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
      return `${token.name} ${token.symbol} ${token.memeType} ${token.description}`.toLowerCase().includes(q);
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
        <div className="mb-8 flex items-center justify-between">
          <Logo />
          <Button
            variant="outline"
            size="icon"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label="Toggle theme"
            data-testid="button-toggle-theme"
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </div>

        <div className="space-y-2">
          <p className="px-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Views</p>
          {[
            ["all", "All signals", Radar],
            ["turbo", "Velocity", Flame],
            ["early", "Early caps", Bot],
            ["social", "Social proof", Sparkles],
            ["lower-risk", "Lower risk", ShieldAlert],
          ].map(([key, label, Icon]) => (
            <button
              key={key as string}
              type="button"
              onClick={() => setFilterMode(key as FilterMode)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                filterMode === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
              data-testid={`button-filter-${key}`}
            >
              <Icon className="h-4 w-4" />
              {label as string}
            </button>
          ))}
        </div>

        <div className="mt-6">
          <a
            href="#/raw"
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
            data-testid="link-raw-feed"
          >
            <Activity className="h-4 w-4" />
            Raw feed
          </a>
        </div>

        <div className="mt-8">
          <MetaRail snapshot={snapshot} />
        </div>
      </aside>

      <main className="main-panel">
        <header className="sticky top-0 z-10 border-b border-border bg-background/92 px-5 py-4 backdrop-blur">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge variant={live ? "default" : "secondary"} data-testid="badge-live-status">
                  {live ? "live stream" : "polling"}
                </Badge>
                <Badge variant="outline">Not financial advice</Badge>
                <SvsBadge health={svsHealth} />
                <GrpcBadge status={grpcStatus} />
              </div>
              <h1 className="text-3xl font-semibold leading-tight tracking-tight">Velocity radar</h1>
              <p className="mt-2 max-w-2xl font-body text-sm leading-relaxed text-muted-foreground">
                Tracks Solana tokens that are starting to move, decodes the meme, then scores velocity, virality, upside, and risk from live indexed DEX data.
              </p>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search meme, ticker, meta"
                  className="h-10 w-full rounded-lg border border-input bg-card pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring sm:w-64"
                  data-testid="input-search"
                />
              </div>
              <Button variant="outline" onClick={() => exportCsv(visibleTokens)} data-testid="button-export-csv">
                <Download className="mr-2 h-4 w-4" /> Export CSV
              </Button>
            </div>
          </div>
        </header>

        <div className="space-y-5 p-5">
          <SnapshotBar snapshot={snapshot} live={live} setLive={setLive} onRefresh={hardRefresh} refreshing={refreshing} />

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <Tabs value={sortMode} onValueChange={(value) => setSortMode(value as SortMode)} data-testid="tabs-sort-mode">
              <TabsList className="flex h-auto flex-wrap justify-start">
                <TabsTrigger value="score" data-testid="tab-sort-score">Score</TabsTrigger>
                <TabsTrigger value="velocity" data-testid="tab-sort-velocity">Velocity</TabsTrigger>
                <TabsTrigger value="virality" data-testid="tab-sort-virality">Virality</TabsTrigger>
                <TabsTrigger value="upside" data-testid="tab-sort-upside">Upside</TabsTrigger>
                <TabsTrigger value="risk" data-testid="tab-sort-risk">Low risk</TabsTrigger>
              </TabsList>
            </Tabs>
            <p className="text-sm text-muted-foreground" data-testid="text-visible-count">
              Showing {visibleTokens.length} of {snapshot?.tokens.length ?? 0} scored signals
            </p>
          </div>

          {error ? (
            <Card className="border-destructive/40" data-testid="error-state">
              <CardContent className="flex items-center gap-3 p-5">
                <AlertTriangle className="h-5 w-5 text-destructive" />
                <div>
                  <p className="font-medium">Scanner feed failed</p>
                  <p className="text-sm text-muted-foreground">{error instanceof Error ? error.message : "Unknown error"}</p>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {isLoading && !snapshot ? (
            <div className="grid gap-5 xl:grid-cols-[420px_1fr]">
              <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-36 rounded-xl" />)}</div>
              <Skeleton className="min-h-[560px] rounded-xl" />
            </div>
          ) : (
            <div className="grid min-h-[640px] gap-5 xl:grid-cols-[420px_1fr]">
              <section className="min-h-0 space-y-3 xl:max-h-[calc(100dvh-285px)] xl:overflow-y-auto xl:pr-1" data-testid="token-list">
                {visibleTokens.length ? visibleTokens.map((token, idx) => (
                  <TokenCard
                    key={token.id}
                    token={token}
                    index={idx}
                    active={selectedToken?.id === token.id}
                    onSelect={(next) => setSelectedId(next.id)}
                  />
                )) : (
                  <Card className="border-dashed" data-testid="empty-token-list">
                    <CardContent className="p-8 text-center">
                      <Radar className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
                      <p className="font-medium">No signals match</p>
                      <p className="mt-1 text-sm text-muted-foreground">Try a broader filter or refresh the feed.</p>
                    </CardContent>
                  </Card>
                )}
              </section>
              <DetailPanel
                token={selectedToken}
                onOpenSheet={() => setSheetOpen(true)}
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

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl" data-testid="sheet-full-thesis">
          <SheetHeader>
            <SheetTitle>{selectedToken?.name ?? "Token"} thesis</SheetTitle>
          </SheetHeader>
          {selectedToken ? (
            <div className="mt-6 space-y-5">
              <div>
                <p className="mb-2 text-sm font-semibold">Meme decode</p>
                <p className="text-sm leading-6 text-muted-foreground">{selectedToken.memeDecode}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <ScorePill label="Velocity" value={selectedToken.scores.velocity} drivers={velocityDrivers(selectedToken)} />
                <ScorePill label="Virality" value={selectedToken.scores.virality} drivers={viralityDrivers(selectedToken)} />
                <ScorePill label="Upside" value={selectedToken.scores.upside} drivers={upsideDrivers(selectedToken)} />
                <ScorePill label="Risk" value={selectedToken.scores.risk} drivers={riskDrivers(selectedToken)} danger />
              </div>
              <div>
                <p className="mb-2 text-sm font-semibold">Opportunity flags</p>
                <div className="flex flex-wrap gap-2">
                  {selectedToken.opportunityFlags.map((flag) => <Badge key={flag}>{flag}</Badge>)}
                </div>
              </div>
              <div>
                <p className="mb-2 text-sm font-semibold">Links</p>
                <div className="space-y-2">
                  {selectedToken.links.map((link) => (
                    <a
                      key={link.url}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-between rounded-lg border border-border p-3 text-sm hover:bg-accent"
                      data-testid={`link-token-${link.type}`}
                    >
                      <span>{link.label ?? link.type}</span>
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
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
