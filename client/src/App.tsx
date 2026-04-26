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

function ScorePill({ label, value, danger = false }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="rounded-lg border border-border/70 bg-card/70 p-3" data-testid={`score-${label.toLowerCase()}`}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className={`font-mono text-sm font-semibold ${danger ? riskTone(value) : scoreTone(value)}`}>{value}</span>
      </div>
      <Progress value={value} className="h-1.5" />
    </div>
  );
}

function TokenAvatar({ token }: { token: TokenSignal }) {
  const [failed, setFailed] = useState(false);
  const initials = token.symbol.slice(0, 3).toUpperCase();
  if (!token.imageUrl || failed) {
    return (
      <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-border bg-muted font-mono text-xs font-semibold" data-testid={`avatar-fallback-${token.id}`}>
        {initials}
      </div>
    );
  }
  return (
    <img
      src={token.imageUrl}
      alt={`${token.name} token artwork`}
      className="h-12 w-12 shrink-0 rounded-xl border border-border object-cover"
      crossOrigin="anonymous"
      onError={() => setFailed(true)}
      data-testid={`img-token-${token.id}`}
    />
  );
}

function TokenCard({
  token,
  active,
  onSelect,
}: {
  token: TokenSignal;
  active: boolean;
  onSelect: (token: TokenSignal) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(token)}
      className={`group w-full rounded-xl border p-4 text-left transition hover:bg-accent/50 ${
        active ? "border-primary bg-primary/7 shadow-sm" : "border-border bg-card"
      }`}
      data-testid={`button-token-${token.id}`}
    >
      <div className="flex items-start gap-3">
        <TokenAvatar token={token} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-semibold leading-tight" data-testid={`text-token-name-${token.id}`}>
                {token.name}
              </p>
              <p className="font-mono text-xs text-muted-foreground">{token.symbol}</p>
            </div>
            <div className={`font-mono text-xl font-semibold leading-none ${scoreTone(token.scores.final)}`} data-testid={`text-final-score-${token.id}`}>
              {token.scores.final}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {token.opportunityFlags.slice(0, 2).map((flag) => (
              <Badge key={flag} variant="secondary" className="max-w-full truncate text-[11px]" data-testid={`badge-opportunity-${token.id}-${flag}`}>
                {flag}
              </Badge>
            ))}
            {token.riskFlags.slice(0, 1).map((flag) => (
              <Badge key={flag} variant="outline" className="border-amber-500/40 text-[11px] text-amber-700 dark:text-amber-200" data-testid={`badge-risk-${token.id}-${flag}`}>
                {flag}
              </Badge>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
            <div>
              <p className="text-muted-foreground">5m pace</p>
              <p className="font-mono font-medium">{token.volumeAcceleration.toFixed(1)}x</p>
            </div>
            <div>
              <p className="text-muted-foreground">H1 buy</p>
              <p className="font-mono font-medium">{(token.buyPressureH1 * 100).toFixed(0)}%</p>
            </div>
            <div>
              <p className="text-muted-foreground">Cap</p>
              <p className="font-mono font-medium">{fmtMoney(token.marketCap)}</p>
            </div>
          </div>
        </div>
      </div>
    </button>
  );
}

function DetailPanel({ token, onOpenSheet }: { token: TokenSignal | undefined; onOpenSheet: () => void }) {
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

  const chartData = normalizeChart(token);

  return (
    <section className="flex h-full min-h-0 flex-col rounded-xl border border-border bg-card" data-testid={`detail-panel-${token.id}`}>
      <div className="border-b border-border p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4">
            <TokenAvatar token={token} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-xl font-semibold leading-tight" data-testid="text-selected-token">
                  {token.name}
                </h1>
                <Badge variant="secondary" data-testid="badge-meme-type">
                  {token.memeType}
                </Badge>
              </div>
              <p className="mt-1 font-mono text-xs text-muted-foreground">{token.tokenAddress}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Radar score</p>
            <p className={`font-mono text-3xl font-semibold leading-none ${scoreTone(token.scores.final)}`} data-testid="text-selected-score">
              {token.scores.final}
            </p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="grid gap-3 md:grid-cols-4">
          <ScorePill label="Velocity" value={token.scores.velocity} />
          <ScorePill label="Virality" value={token.scores.virality} />
          <ScorePill label="Upside" value={token.scores.upside} />
          <ScorePill label="Risk" value={token.scores.risk} danger />
        </div>

        <div className="mt-5 grid gap-4 xl:grid-cols-[1fr_280px]">
          <Card className="border-border bg-background/50">
            <CardContent className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold">Volume pace</h2>
                <span className="text-xs text-muted-foreground">5m annualized to hour</span>
              </div>
              <div className="h-56" data-testid="chart-volume-pace">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickFormatter={(value) => fmtMoney(Number(value)).replace("$", "")} width={48} />
                    <ChartTooltip
                      contentStyle={{
                        background: "hsl(var(--popover))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: 10,
                        color: "hsl(var(--foreground))",
                      }}
                      formatter={(value: number) => fmtMoney(value)}
                    />
                    <Area type="monotone" dataKey="volume" stroke="hsl(var(--primary))" fill="hsl(var(--primary) / 0.18)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border bg-background/50">
            <CardContent className="space-y-3 p-4">
              <h2 className="text-sm font-semibold">Live tape</h2>
              {[
                ["5m volume", fmtMoney(token.volume.m5)],
                ["1h volume", fmtMoney(token.volume.h1)],
                ["Liquidity", fmtMoney(token.liquidityUsd)],
                ["Age", fmtAge(token.pairAgeMinutes)],
                ["Boost", token.boostAmount ? `${token.boostAmount} units` : "none"],
                ["DEX", token.dexId],
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between border-b border-border/60 pb-2 last:border-b-0" data-testid={`metric-${label.toLowerCase().replace(/\s/g, "-")}`}>
                  <span className="text-xs text-muted-foreground">{label}</span>
                  <span className="font-mono text-sm">{value}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        <div className="mt-5 grid gap-4 xl:grid-cols-3">
          <Card className="border-border bg-background/50 xl:col-span-2">
            <CardContent className="p-4">
              <div className="mb-2 flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold">What is the meme?</h2>
              </div>
              <p className="text-sm leading-6 text-muted-foreground" data-testid="text-meme-decode">
                {token.memeDecode}
              </p>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div className="rounded-lg bg-muted/60 p-3">
                  <p className="mb-1 text-xs font-medium">Virality read</p>
                  <p className="text-xs leading-5 text-muted-foreground">{token.viralityThesis}</p>
                </div>
                <div className="rounded-lg bg-muted/60 p-3">
                  <p className="mb-1 text-xs font-medium">Upside read</p>
                  <p className="text-xs leading-5 text-muted-foreground">{token.upsideThesis}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border bg-background/50">
            <CardContent className="p-4">
              <div className="mb-2 flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-300" />
                <h2 className="text-sm font-semibold">Risk note</h2>
              </div>
              <p className="text-sm leading-6 text-muted-foreground" data-testid="text-danger-note">
                {token.dangerNote}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {token.riskFlags.length ? token.riskFlags.map((flag) => (
                  <Badge key={flag} variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-200">
                    {flag}
                  </Badge>
                )) : <Badge variant="outline">scanner clean</Badge>}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button asChild variant="default" size="sm" data-testid="link-open-dexscreener">
            <a href={token.url} target="_blank" rel="noopener noreferrer">
              Open DexScreener <ExternalLink className="ml-2 h-3.5 w-3.5" />
            </a>
          </Button>
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
    <aside className="rounded-xl border border-border bg-card p-4" data-testid="meta-rail">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Hot metas</h2>
        <Badge variant="outline">DexScreener</Badge>
      </div>
      <div className="space-y-3">
        {snapshot?.metas?.length ? snapshot.metas.slice(0, 6).map((meta) => (
          <div key={meta.slug} className="rounded-lg bg-background/60 p-3" data-testid={`card-meta-${meta.slug}`}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span aria-hidden="true">{meta.icon}</span>
                <p className="truncate text-sm font-medium">{meta.name}</p>
              </div>
              <span className={`flex items-center gap-0.5 font-mono text-xs ${scoreTone(meta.marketCapChange.h1 ?? 0)}`}>
                {trendIcon(meta.marketCapChange.h1)}
                {fmtPct(meta.marketCapChange.h1)}
              </span>
            </div>
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{meta.description}</p>
          </div>
        )) : Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
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
  return (
    <div className="grid gap-3 md:grid-cols-4" data-testid="snapshot-bar">
      <Card className="border-border bg-card">
        <CardContent className="flex items-center gap-3 p-4">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <SignalHigh className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Mode</p>
            <p className="text-sm font-medium" data-testid="text-data-mode">{snapshot?.dataMode ?? "warming scanner"}</p>
          </div>
        </CardContent>
      </Card>
      <Card className="border-border bg-card">
        <CardContent className="flex items-center gap-3 p-4">
          <div className="rounded-lg bg-emerald-500/10 p-2 text-emerald-600 dark:text-emerald-300">
            <Gauge className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Scanned</p>
            <p className="font-mono text-sm font-medium" data-testid="text-scanned-count">{snapshot?.scannedTokens ?? "…" } candidates</p>
          </div>
        </CardContent>
      </Card>
      <Card className="border-border bg-card">
        <CardContent className="flex items-center gap-3 p-4">
          <div className="rounded-lg bg-amber-500/10 p-2 text-amber-600 dark:text-amber-300">
            <Activity className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Latency</p>
            <p className="font-mono text-sm font-medium" data-testid="text-latency">{snapshot ? `${snapshot.latencyMs}ms` : "…"}</p>
          </div>
        </CardContent>
      </Card>
      <Card className="border-border bg-card">
        <CardContent className="flex items-center justify-between gap-3 p-4">
          <div>
            <p className="text-xs text-muted-foreground">Updated</p>
            <p className="font-mono text-sm font-medium" data-testid="text-updated-at">{generated ? generated.toLocaleTimeString() : "…"}</p>
            <p className="text-xs text-muted-foreground">{okSources}/{snapshot?.sourceHealth.length ?? 4} feeds ok</p>
          </div>
          <div className="flex gap-2">
            <Button
              size="icon"
              variant={live ? "default" : "outline"}
              onClick={() => setLive(!live)}
              aria-label={live ? "Disable live stream" : "Enable live stream"}
              data-testid="button-toggle-live"
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
            >
              <RefreshCcw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </CardContent>
      </Card>
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
              <h1 className="text-xl font-semibold tracking-tight">Fast memecoin velocity radar</h1>
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
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
                {visibleTokens.length ? visibleTokens.map((token) => (
                  <TokenCard
                    key={token.id}
                    token={token}
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
              <DetailPanel token={selectedToken} onOpenSheet={() => setSheetOpen(true)} />
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
                <ScorePill label="Velocity" value={selectedToken.scores.velocity} />
                <ScorePill label="Virality" value={selectedToken.scores.virality} />
                <ScorePill label="Upside" value={selectedToken.scores.upside} />
                <ScorePill label="Risk" value={selectedToken.scores.risk} danger />
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
