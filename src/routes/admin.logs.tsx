import { createFileRoute } from "@tanstack/react-router";
import {
  AlertTriangle,
  Inbox,
  Loader2,
  MessagesSquare,
  Package,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * A live-updating view over what wa-admin.server.ts already exposes via
 * curl — built because "hit curl again and again" does not scale past one
 * developer checking one session by hand, and with 100+ concurrent
 * customers a raw event feed makes "which one hit an error" a manual scan.
 *
 * Polls GET /api/admin/wa-sessions (grouped, error-flagged, newest-first)
 * on an interval, and GET /api/admin/wa-status?session_key=... on demand
 * for one session's full timeline. Both are bearer-checked against
 * CRON_SECRET server-side (wa-admin.server.ts) — this page only adds a
 * client-side password gate in front of the same secret, stored in
 * localStorage the way a developer would otherwise keep it in a curl
 * command's history. Not linked from anywhere in the app; reachable only
 * by typing the URL.
 *
 * A two-pane layout on purpose, not a modal/drawer over the list: an
 * overlay's close button turned out to be an easy way to introduce a bug
 * (a stacking-context conflict with the sticky header ate the click), and
 * a persistent pane sidesteps the whole class of problem — there is no
 * "doesn't close" state, since picking a different session just replaces
 * the pane's content, the same way any inbox works.
 *
 * The workspace wears the same warm, light tokens as the customer app, so
 * a product photo or a WhatsApp preview looks here the way it looks there.
 * Three views — conversations, the requests inbox, products — share one
 * shell and switch as tabs; switching away from an unsaved product draft
 * asks first, through the same confirm dialog every destructive action in
 * the workspace uses.
 */

export const Route = createFileRoute("/admin/logs")({
  head: () => ({
    meta: [{ title: "Logs — Comfortel Assistant" }, { name: "robots", content: "noindex" }],
  }),
  component: AdminLogs,
});

import { RequestsInbox } from "@/components/wa-requests-inbox";
import { ProductManager } from "@/components/product-manager";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type View = "conversations" | "inbox" | "products";

const TOKEN_KEY = "comfortel-admin-token";
const POLL_MS = 4000;

type LatestJob = {
  status: string;
  mode: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type SessionSummary = {
  sessionKey: string;
  lastActivity: string;
  messageCount: number;
  lastMessagePreview: string;
  hasError: boolean;
  latestJob: LatestJob | null;
  customerName: string | null;
  phoneLast4: string | null;
};

type JobRow = {
  id: string;
  session_key: string;
  status: string;
  mode: string;
  product_ids: string[];
  attempt: number;
  kie_task_id: string | null;
  result_url: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  wa_message_id: string;
  direction: "inbound" | "outbound";
  session_key: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
};

type DeliveryStatusRow = {
  wa_message_id: string;
  session_key: string | null;
  status: string;
  event_at: string;
  details: Record<string, unknown>;
};

/** One entry in the merged timeline — a message or a render job's current
 * status, sorted together by when it happened. A job contributes up to two
 * entries (started, then its current status once that differs), so
 * "what's happening in the background" reads as part of the same
 * continuous story as the conversation, not a separate disconnected list. */
type TimelineEntry =
  | {
      at: string;
      kind: "message";
      message: MessageRow;
      deliveryStatus?: DeliveryStatusRow | undefined;
    }
  | { at: string; kind: "job-started"; job: JobRow }
  | { at: string; kind: "job-status"; job: JobRow };

function buildTimeline(
  messages: MessageRow[],
  jobs: JobRow[],
  deliveryStatuses: DeliveryStatusRow[],
): TimelineEntry[] {
  const deliveryRank: Record<string, number> = {
    sent: 1,
    delivered: 2,
    read: 3,
    failed: 4,
  };
  const latestStatus = new Map<string, DeliveryStatusRow>();
  for (const status of deliveryStatuses) {
    const previous = latestStatus.get(status.wa_message_id);
    if (
      !previous ||
      previous.event_at < status.event_at ||
      (previous.event_at === status.event_at &&
        (deliveryRank[previous.status] ?? 0) < (deliveryRank[status.status] ?? 0))
    ) {
      latestStatus.set(status.wa_message_id, status);
    }
  }
  const entries: TimelineEntry[] = messages.map((message) => ({
    at: message.created_at,
    kind: "message",
    message,
    ...(latestStatus.get(message.wa_message_id)
      ? { deliveryStatus: latestStatus.get(message.wa_message_id) }
      : {}),
  }));
  for (const job of jobs) {
    entries.push({ at: job.created_at, kind: "job-started", job });
    if (job.updated_at !== job.created_at) {
      entries.push({ at: job.updated_at, kind: "job-status", job });
    }
  }
  return entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function shortKey(sessionKey: string): string {
  const hex = sessionKey.replace(/^wa:/, "");
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

/** The best available label for a customer — their WhatsApp display name,
 * falling back to a masked phone number, falling back to the session hash
 * only when neither is known yet (their very first message, before Meta's
 * contact payload has been seen). */
function identityOf(s: {
  customerName: string | null;
  phoneLast4: string | null;
  sessionKey: string;
}): {
  primary: string;
  secondary: string | null;
} {
  if (s.customerName)
    return { primary: s.customerName, secondary: s.phoneLast4 ? `•••• ${s.phoneLast4}` : null };
  if (s.phoneLast4) return { primary: `•••• ${s.phoneLast4}`, secondary: shortKey(s.sessionKey) };
  return { primary: shortKey(s.sessionKey), secondary: null };
}

function initialsOf(label: string): string {
  const parts = label.replace(/[•]/g, "").trim().split(/\s+/);
  const initials = parts
    .slice(0, 2)
    .map((p) => p[0])
    .join("");
  return (initials || label.slice(0, 2)).toUpperCase();
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-secondary/60 text-foreground ring-1 ring-border",
  generating: "bg-amber-400/10 text-amber-800 ring-1 ring-amber-400/20",
  done: "bg-emerald-400/10 text-emerald-800 ring-1 ring-emerald-400/20",
  failed: "bg-rose-400/10 text-rose-700 ring-1 ring-rose-400/20",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Queued",
  generating: "Generating",
  done: "Done",
  failed: "Failed",
};

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLE[status] ?? STATUS_STYLE["pending"]}`}
    >
      {status === "generating" && <Loader2 className="h-3 w-3 animate-spin" />}
      {status === "pending" && <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />}
      {status === "done" && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
      {status === "failed" && <span className="h-1.5 w-1.5 rounded-full bg-rose-400" />}
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

async function callAdmin<T>(path: string, token: string): Promise<T> {
  const res = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new Error("UNAUTHORIZED");
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
  return body;
}

function TokenGate({
  onSubmit,
  error,
}: {
  onSubmit: (token: string) => void;
  error: string | null;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <form
        className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 shadow-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
            <Sparkles className="h-4 w-4 text-primary-foreground" />
          </div>
          <h1 className="text-sm font-semibold">Comfortel workspace</h1>
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          Paste your admin password to connect. It stays in this browser only.
        </p>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Admin password"
          aria-label="Admin password"
          className="mt-4 w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none transition-shadow placeholder:text-muted-foreground focus:border-primary-strong focus:ring-2 focus:ring-primary-strong/20"
        />
        {error && (
          <p role="alert" className="mt-2 flex items-center gap-1.5 text-xs text-rose-700">
            <AlertTriangle className="h-3.5 w-3.5" />
            {error}
          </p>
        )}
        <Button type="submit" className="mt-4 w-full" disabled={!value.trim()}>
          Connect
        </Button>
      </form>
    </div>
  );
}

function messageText(m: MessageRow): { label: string; body: string } {
  const isIn = m.direction === "inbound";
  if (
    typeof m.payload["buttonReplyId"] === "string" ||
    typeof m.payload["buttonReplyTitle"] === "string"
  ) {
    const title = m.payload["buttonReplyTitle"];
    const id = m.payload["buttonReplyId"];
    return {
      label: isIn ? "customer tapped" : "bot",
      body: `“${typeof title === "string" ? title : id}”`,
    };
  }
  if (typeof m.payload["text"] === "string" && m.payload["text"]) {
    return { label: isIn ? "customer" : "bot", body: m.payload["text"] as string };
  }
  if (typeof m.payload["caption"] === "string") {
    return {
      label: isIn ? "customer" : "bot",
      body: (m.payload["caption"] as string).split("\n")[0] ?? "",
    };
  }
  return { label: isIn ? "customer" : "bot", body: `[${m.kind}]` };
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  const time = new Date(entry.at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  if (entry.kind === "message") {
    const { label, body } = messageText(entry.message);
    const isCustomer = label.startsWith("customer");
    return (
      <div className="flex gap-3 py-2">
        <span className="w-20 shrink-0 pt-0.5 font-mono text-[11px] text-muted-foreground">
          {time}
        </span>
        <span
          className={`w-20 shrink-0 pt-0.5 text-xs font-medium ${isCustomer ? "text-sky-400" : "text-muted-foreground"}`}
        >
          {label}
        </span>
        {entry.message.kind === "image" && typeof entry.message.payload["imageUrl"] === "string" ? (
          <div className="min-w-0 flex-1">
            <img
              src={entry.message.payload["imageUrl"] as string}
              alt=""
              className="mb-1 h-20 w-20 rounded-lg border border-border object-cover"
            />
            <p className="break-words text-sm text-foreground">{body}</p>
            {entry.deliveryStatus && (
              <p
                className={`mt-1 text-[11px] ${entry.deliveryStatus.status === "failed" ? "text-rose-700" : "text-muted-foreground"}`}
              >
                {entry.deliveryStatus.status}
              </p>
            )}
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            <p className="whitespace-pre-wrap break-words text-sm text-foreground">{body}</p>
            {entry.deliveryStatus && (
              <p
                className={`mt-1 text-[11px] ${entry.deliveryStatus.status === "failed" ? "text-rose-700" : "text-muted-foreground"}`}
              >
                {entry.deliveryStatus.status}
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  const job = entry.job;
  const isStart = entry.kind === "job-started";
  return (
    <div className="flex gap-3 rounded-lg bg-card py-2 pl-0 pr-2 ring-1 ring-border/60">
      <span className="w-20 shrink-0 pt-0.5 font-mono text-[11px] text-muted-foreground">
        {time}
      </span>
      <span className="w-20 shrink-0 pt-0.5 text-xs font-medium text-foreground">render</span>
      <div className="min-w-0 flex-1">
        {isStart ? (
          <p className="text-sm text-foreground">
            Started <span className="font-medium text-foreground">{job.mode}</span>
            {job.product_ids.length ? ` — ${job.product_ids.join(", ")}` : ""}
            {job.attempt > 0 ? ` (retry ${job.attempt})` : ""}
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <StatusPill status={job.status} />
            {job.error && <span className="text-sm text-rose-700">{job.error}</span>}
            {job.result_url && (
              <a
                href={job.result_url}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-foreground underline underline-offset-2 hover:text-foreground"
              >
                view image
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionPane({ sessionKey, token }: { sessionKey: string; token: string }) {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [deliveryStatuses, setDeliveryStatuses] = useState<DeliveryStatusRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await callAdmin<{
        jobs: JobRow[];
        messages: MessageRow[];
        deliveryStatuses: DeliveryStatusRow[];
      }>(`/api/admin/wa-status?limit=80&session_key=${encodeURIComponent(sessionKey)}`, token);
      setJobs(data.jobs ?? []);
      setMessages(data.messages ?? []);
      setDeliveryStatuses(data.deliveryStatuses ?? []);
    } finally {
      setLoading(false);
    }
  }, [sessionKey, token]);

  useEffect(() => {
    setLoading(true);
    void load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const timeline = useMemo(
    () => buildTimeline(messages, jobs, deliveryStatuses),
    [messages, jobs, deliveryStatuses],
  );
  const activeJob = jobs.find((j) => j.status === "pending" || j.status === "generating");

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h2 className="font-mono text-xs text-muted-foreground">{shortKey(sessionKey)}</h2>
          {activeJob && (
            <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-amber-800">
              <Loader2 className="h-3 w-3 animate-spin" />A render is in progress
            </div>
          )}
        </div>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {timeline.length === 0 && !loading && (
          <p className="mt-8 text-center text-sm text-muted-foreground">
            No activity in this session yet.
          </p>
        )}
        <div className="divide-y divide-border">
          {timeline.map((entry, i) => (
            <TimelineRow key={`${entry.kind}-${entry.at}-${i}`} entry={entry} />
          ))}
        </div>
      </div>
    </div>
  );
}

function SessionCard({
  session,
  active,
  onClick,
}: {
  session: SessionSummary;
  active: boolean;
  onClick: () => void;
}) {
  const identity = identityOf(session);
  return (
    <button
      onClick={onClick}
      className={`block w-full rounded-xl border px-3 py-3 text-left transition-colors ${
        active
          ? "border-border-strong bg-secondary shadow-sm"
          : session.hasError
            ? "border-rose-400/20 bg-rose-400/[0.06] hover:bg-rose-400/10"
            : "border-transparent hover:bg-secondary/70"
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
            session.hasError ? "bg-rose-400/15 text-rose-700" : "bg-secondary text-foreground"
          }`}
        >
          {initialsOf(identity.primary)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium text-foreground">{identity.primary}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {timeAgo(session.lastActivity)}
            </span>
          </div>
          {identity.secondary && (
            <span className="text-[11px] text-muted-foreground">{identity.secondary}</span>
          )}
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {session.lastMessagePreview ||
              (session.latestJob ? `${session.latestJob.mode} render` : "—")}
          </p>
          <div className="mt-1.5 flex items-center gap-1.5">
            {session.latestJob && <StatusPill status={session.latestJob.status} />}
            {session.hasError && session.latestJob?.error && (
              <span className="truncate text-[11px] text-rose-700">{session.latestJob.error}</span>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}

function AdminLogs() {
  const [token, setToken] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>("conversations");
  const [editingProduct, setEditingProduct] = useState(false);
  const [pendingView, setPendingView] = useState<View | null>(null);

  useEffect(() => {
    const stored = typeof window !== "undefined" ? window.localStorage.getItem(TOKEN_KEY) : null;
    if (stored) setToken(stored);
  }, []);

  const load = useCallback(
    async (activeToken: string, showSpinner: boolean) => {
      if (showSpinner) setLoading(true);
      try {
        const data = await callAdmin<{ sessions: SessionSummary[] }>(
          `/api/admin/wa-sessions?limit=100${errorsOnly ? "&errors=1" : ""}`,
          activeToken,
        );
        setSessions(data.sessions ?? []);
        setLoadError(null);
        setLoaded(true);
      } catch (err) {
        if (err instanceof Error && err.message === "UNAUTHORIZED") {
          window.localStorage.removeItem(TOKEN_KEY);
          setToken(null);
          setAuthError("That password was rejected. Check it and try again.");
          return;
        }
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [errorsOnly],
  );

  useEffect(() => {
    if (!token) return;
    void load(token, true);
    const id = setInterval(() => void load(token, false), POLL_MS);
    return () => clearInterval(id);
  }, [token, load]);

  /** Leaving the products tab mid-edit asks first; every other switch is instant. */
  function switchView(next: View) {
    if (next === view) return;
    if (view === "products" && editingProduct) {
      setPendingView(next);
      return;
    }
    setView(next);
  }

  if (!token) {
    return (
      <TokenGate
        error={authError}
        onSubmit={(t) => {
          window.localStorage.setItem(TOKEN_KEY, t);
          setAuthError(null);
          setToken(t);
        }}
      />
    );
  }

  const errorCount = sessions.filter((s) => s.hasError).length;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 border-b border-border bg-card px-6 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary">
            <Sparkles className="h-3.5 w-3.5 text-primary-foreground" />
          </div>
          <h1 className="text-sm font-semibold">Comfortel workspace</h1>
          <span className="hidden items-center gap-1.5 rounded-full bg-emerald-400/10 px-2 py-0.5 text-[11px] font-medium text-emerald-800 ring-1 ring-emerald-400/20 sm:flex">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
            Live
          </span>
        </div>

        <Tabs value={view} onValueChange={(v) => switchView(v as View)}>
          <TabsList className="h-9 rounded-lg bg-secondary/70 p-1">
            <TabsTrigger
              value="conversations"
              className="gap-1.5 rounded-md px-3 text-xs data-[state=active]:shadow-sm"
            >
              <MessagesSquare className="h-3.5 w-3.5" />
              Conversations
              {errorCount > 0 && (
                <span className="ml-0.5 rounded-full bg-rose-500/15 px-1.5 text-[10px] font-semibold tabular-nums text-rose-700">
                  {errorCount}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger
              value="inbox"
              className="gap-1.5 rounded-md px-3 text-xs data-[state=active]:shadow-sm"
            >
              <Inbox className="h-3.5 w-3.5" />
              Inbox
            </TabsTrigger>
            <TabsTrigger
              value="products"
              className="gap-1.5 rounded-md px-3 text-xs data-[state=active]:shadow-sm"
            >
              <Package className="h-3.5 w-3.5" />
              Products
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex items-center justify-end gap-3">
          {view === "conversations" && (
            <>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={errorsOnly}
                  onChange={(e) => setErrorsOnly(e.target.checked)}
                  className="h-3.5 w-3.5 accent-rose-500"
                />
                Errors only
              </label>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => void load(token, true)}
                aria-label="Refresh now"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              </Button>
            </>
          )}
        </div>
      </header>

      {loadError && (
        <div className="flex shrink-0 items-center gap-2 border-b border-rose-200 bg-rose-50 px-6 py-2 text-xs text-rose-800">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {loadError}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {view === "conversations" && (
          <aside className="flex w-96 shrink-0 flex-col border-r border-border bg-card">
            <div className="shrink-0 px-4 py-3 text-xs text-muted-foreground">
              {loaded ? (
                <>
                  {sessions.length} session{sessions.length === 1 ? "" : "s"}
                  {errorCount > 0 && (
                    <span className="font-medium text-rose-700"> · {errorCount} with errors</span>
                  )}
                </>
              ) : (
                "Loading sessions…"
              )}
            </div>
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-4">
              {!loaded &&
                Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className="flex items-start gap-3 rounded-xl px-3 py-3">
                    <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
                    <div className="flex-1 space-y-2 pt-1">
                      <Skeleton className="h-3 w-2/3" />
                      <Skeleton className="h-3 w-full" />
                    </div>
                  </div>
                ))}
              {loaded && sessions.length === 0 && (
                <div className="mt-10 px-4 text-center">
                  <p className="text-sm font-medium">
                    {errorsOnly ? "No sessions with errors" : "No conversations yet"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {errorsOnly
                      ? "Everything is running clean right now."
                      : "Each customer who messages the WhatsApp number shows up here, newest first."}
                  </p>
                </div>
              )}
              {sessions.map((s) => (
                <SessionCard
                  key={s.sessionKey}
                  session={s}
                  active={selected === s.sessionKey}
                  onClick={() => setSelected(s.sessionKey)}
                />
              ))}
            </div>
          </aside>
        )}

        <main className="min-h-0 min-w-0 flex-1 bg-background">
          {view === "products" ? (
            <ProductManager token={token} onEditingChange={setEditingProduct} />
          ) : view === "inbox" ? (
            <RequestsInbox
              token={token}
              onSession={(key) => {
                setSelected(key);
                setView("conversations");
              }}
            />
          ) : selected ? (
            <SessionPane sessionKey={selected} token={token} />
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <p className="text-sm font-medium">Pick a conversation</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  The full timeline — messages, renders and delivery status — appears here.
                </p>
              </div>
            </div>
          )}
        </main>
      </div>

      <ConfirmDialog
        open={pendingView !== null}
        onOpenChange={(open) => !open && setPendingView(null)}
        title="Leave without saving?"
        description="You have an unsaved product draft. Switching views discards it; the saved version isn't affected."
        confirmLabel="Discard and switch"
        destructive
        onConfirm={() => {
          if (pendingView) setView(pendingView);
          setPendingView(null);
        }}
      />
    </div>
  );
}
