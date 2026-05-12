import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
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
  { key: "all", label: "all", match: () => true },
  { key: "grpc.tx", label: "grpc tx", match: (s) => s === "grpc.tx.received" || s === "grpc.tx.ignored" },
  { key: "decode", label: "decode", match: (s) => s === "grpc.decode.matched" },
  { key: "candidate", label: "candidate", match: (s) => s === "grpc.candidate.upserted" },
  { key: "dex", label: "dex", match: (s) => s === "dex.fetch" },
  { key: "svs", label: "svs", match: (s) => s === "svs.fetch" },
  { key: "radar", label: "radar", match: (s) => s === "radar.snapshot" },
];

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
  return (
    <div
      className="border-b border-border/60 bg-background transition hover:bg-accent/30"
      data-testid={`feed-row-${event.id}`}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="grid w-full grid-cols-[18px_96px_180px_minmax(0,1fr)] items-center gap-2 px-3 py-1.5 text-left"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {formatTime(event.ts)}
        </span>
        <span className="truncate font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {event.stage}
        </span>
        <span className="truncate font-mono text-[11px] text-foreground">{event.summary}</span>
      </button>
      {open ? (
        <pre className="max-h-72 overflow-auto border-t border-border/60 bg-muted/30 p-3 font-mono text-[11px] leading-5">
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
    <div className="flex items-baseline gap-2 border-r border-border/70 pr-3 last:border-r-0" data-testid={`rate-${stage}`}>
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="font-mono text-xs font-semibold tabular-nums">{count}/m</span>
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
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 px-3 py-2 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href="#/"
            className="inline-flex h-8 items-center gap-1 border border-border px-2 font-mono text-xs text-muted-foreground hover:text-foreground"
            data-testid="link-back-radar"
          >
            <ArrowLeft className="h-3 w-3" /> queue
          </a>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="filter"
            className="h-8 w-64 border border-input bg-card px-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
            data-testid="input-feed-filter"
          />
          <Button
            variant={live ? "default" : "outline"}
            size="sm"
            onClick={() => setLive((value) => !value)}
            data-testid="button-toggle-feed-live"
            className="h-8"
          >
            {live ? <Pause className="mr-2 h-3.5 w-3.5" /> : <Play className="mr-2 h-3.5 w-3.5" />}
            {live ? "pause" : "resume"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEvents([])}
            data-testid="button-clear-feed"
            className="h-8"
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" /> clear
          </Button>
          <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-muted-foreground" data-testid="text-feed-status">
            {live ? "live" : "paused"} / {events.length}/{MAX_EVENTS}
          </span>
        </div>
      </header>

      <div className="space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border pb-2" data-testid="rate-grid">
          <StageRate events={events} stage="all" label="all" />
          <StageRate events={events} stage="grpc.tx.received" label="tx in" />
          <StageRate events={events} stage="grpc.tx.ignored" label="tx ignored" />
          <StageRate events={events} stage="grpc.decode.matched" label="decode hit" />
          <StageRate events={events} stage="grpc.candidate.upserted" label="candidate" />
          <StageRate events={events} stage="dex.fetch" label="dex fetch" />
          <StageRate events={events} stage="svs.fetch" label="svs fetch" />
        </div>

        <div className="flex flex-wrap items-center gap-1 border-b border-border pb-2" data-testid="stage-chips">
          {STAGE_GROUPS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => setGroupKey(entry.key)}
              className={`border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition ${
                groupKey === entry.key
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
              data-testid={`chip-stage-${entry.key}`}
            >
              {entry.label}
            </button>
          ))}
          <span className="ml-auto font-mono text-[10px] text-muted-foreground" data-testid="text-feed-count">
            showing {visible.length} of {events.length}
          </span>
        </div>

        {visible.length ? (
          <div className="border border-border" data-testid="feed-list">
            {visible.map((event) => (
              <FeedRow key={event.id} event={event} />
            ))}
          </div>
        ) : (
          <div className="border border-dashed border-border p-8 text-center font-mono text-xs text-muted-foreground" data-testid="empty-feed">
            {events.length === 0 ? "waiting" : "no matches"}
          </div>
        )}
      </div>
    </div>
  );
}
