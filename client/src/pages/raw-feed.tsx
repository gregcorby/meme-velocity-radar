import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronRight, Pause, Play, Trash2, ArrowLeft } from "lucide-react";

const EVENT_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

type RawFeedEvent = {
  id: string;
  ts: string;
  stage: string;
  summary: string;
  [key: string]: unknown;
};

const STAGE_GROUPS: Array<{ key: string; label: string; match: (stage: string) => boolean }> = [
  { key: "all", label: "All", match: () => true },
  { key: "grpc.tx", label: "grpc tx", match: (s) => s === "grpc.tx.received" || s === "grpc.tx.ignored" },
  { key: "decode", label: "decode", match: (s) => s === "grpc.decode.matched" },
  { key: "candidate", label: "candidate", match: (s) => s === "grpc.candidate.upserted" },
  { key: "dex", label: "dex", match: (s) => s === "dex.fetch" },
  { key: "svs", label: "svs", match: (s) => s === "svs.fetch" },
  { key: "radar", label: "radar", match: (s) => s === "radar.snapshot" },
];

const STAGE_TONE: Record<string, string> = {
  "grpc.tx.received": "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30",
  "grpc.tx.ignored": "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/20",
  "grpc.decode.matched": "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30",
  "grpc.candidate.upserted": "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  "dex.fetch": "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  "svs.fetch": "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/30",
  "radar.snapshot": "bg-primary/15 text-primary border-primary/30",
};

const MAX_EVENTS = 1000;

function formatTime(ts: string) {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString("en-US", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
  } catch {
    return ts;
  }
}

function FeedRow({ event }: { event: RawFeedEvent }) {
  const [open, setOpen] = useState(false);
  const tone = STAGE_TONE[event.stage] ?? "bg-muted text-muted-foreground border-border";
  return (
    <div
      className="rounded-md border border-border/60 bg-card transition hover:bg-accent/30"
      data-testid={`feed-row-${event.id}`}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums shrink-0">
          {formatTime(event.ts)}
        </span>
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${tone}`}
        >
          {event.stage}
        </span>
        <span className="truncate text-sm">{event.summary}</span>
      </button>
      {open ? (
        <pre className="max-h-72 overflow-auto border-t border-border/60 bg-muted/40 p-3 font-mono text-[11px] leading-5">
          {JSON.stringify(event, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

function StageRate({
  events,
  stage,
  label,
}: {
  events: RawFeedEvent[];
  stage: string | "all";
  label: string;
}) {
  const count = useMemo(() => {
    const cutoff = Date.now() - 60_000;
    return events.filter((event) => {
      if (Date.parse(event.ts) < cutoff) return false;
      if (stage === "all") return true;
      return event.stage === stage;
    }).length;
  }, [events, stage]);
  return (
    <div className="rounded-md border border-border/60 bg-card px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="font-mono text-base font-semibold tabular-nums">{count}/min</p>
    </div>
  );
}

export default function RawFeedPage() {
  const [events, setEvents] = useState<RawFeedEvent[]>([]);
  const [live, setLive] = useState(true);
  const [groupKey, setGroupKey] = useState("all");
  const [search, setSearch] = useState("");
  const liveRef = useRef(live);
  liveRef.current = live;

  useEffect(() => {
    if (!live) return undefined;
    const source = new EventSource(`${EVENT_BASE}/api/raw/stream`);
    source.addEventListener("feed", (event) => {
      if (!liveRef.current) return;
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as RawFeedEvent;
        setEvents((prev) => {
          // Dedupe by id (replay overlap with live).
          if (prev.length && prev[0]?.id === parsed.id) return prev;
          const next = [parsed, ...prev];
          if (next.length > MAX_EVENTS) next.length = MAX_EVENTS;
          return next;
        });
      } catch {
        // ignore malformed payload
      }
    });
    source.onerror = () => {
      source.close();
    };
    return () => source.close();
  }, [live]);

  const group = STAGE_GROUPS.find((entry) => entry.key === groupKey) ?? STAGE_GROUPS[0];

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return events.filter((event) => {
      if (!group.match(event.stage)) return false;
      if (!q) return true;
      return (
        event.stage.toLowerCase().includes(q) ||
        event.summary.toLowerCase().includes(q) ||
        JSON.stringify(event).toLowerCase().includes(q)
      );
    });
  }, [events, group, search]);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-background/92 px-5 py-4 backdrop-blur">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <a
                href="#/"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                data-testid="link-back-radar"
              >
                <ArrowLeft className="h-3 w-3" /> radar
              </a>
              <Badge variant={live ? "default" : "secondary"} data-testid="badge-feed-live">
                {live ? "live" : "paused"}
              </Badge>
              <Badge variant="outline">in-process ring buffer · cap 500</Badge>
            </div>
            <h1 className="text-xl font-semibold tracking-tight">Raw event feed</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Every gRPC tx, decode hit, candidate upsert, and upstream fetch the radar pipeline performs — in real time. Click a row to expand the JSON payload.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="filter…"
              className="h-9 w-56 rounded-md border border-input bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              data-testid="input-feed-filter"
            />
            <Button
              variant={live ? "default" : "outline"}
              size="sm"
              onClick={() => setLive((value) => !value)}
              data-testid="button-toggle-feed-live"
            >
              {live ? <Pause className="mr-2 h-4 w-4" /> : <Play className="mr-2 h-4 w-4" />}
              {live ? "Pause" : "Resume"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEvents([])}
              data-testid="button-clear-feed"
            >
              <Trash2 className="mr-2 h-4 w-4" /> Clear
            </Button>
          </div>
        </div>
      </header>

      <div className="space-y-4 p-5">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-7" data-testid="rate-grid">
          <StageRate events={events} stage="all" label="all" />
          <StageRate events={events} stage="grpc.tx.received" label="tx in" />
          <StageRate events={events} stage="grpc.tx.ignored" label="tx ignored" />
          <StageRate events={events} stage="grpc.decode.matched" label="decode hit" />
          <StageRate events={events} stage="grpc.candidate.upserted" label="candidate" />
          <StageRate events={events} stage="dex.fetch" label="dex fetch" />
          <StageRate events={events} stage="svs.fetch" label="svs fetch" />
        </div>

        <div className="flex flex-wrap items-center gap-2" data-testid="stage-chips">
          {STAGE_GROUPS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => setGroupKey(entry.key)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                groupKey === entry.key
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
              data-testid={`chip-stage-${entry.key}`}
            >
              {entry.label}
            </button>
          ))}
          <span className="ml-auto text-xs text-muted-foreground" data-testid="text-feed-count">
            showing {visible.length} of {events.length}
          </span>
        </div>

        {visible.length ? (
          <div className="space-y-1.5" data-testid="feed-list">
            {visible.map((event) => (
              <FeedRow key={event.id} event={event} />
            ))}
          </div>
        ) : (
          <Card className="border-dashed" data-testid="empty-feed">
            <CardContent className="p-8 text-center text-sm text-muted-foreground">
              {events.length === 0
                ? "Waiting for events — make sure the server is running. With SVS_GRPC_ENDPOINT set, gRPC events flow within seconds. Without it, dex/svs/radar events still appear every ~20s."
                : "No events match the current filter."}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
