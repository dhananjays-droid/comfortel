import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Loader2, RefreshCw, Sparkles } from "lucide-react";
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
 */

export const Route = createFileRoute("/admin/logs")({
  head: () => ({
    meta: [{ title: "Logs — Comfortel Assistant" }, { name: "robots", content: "noindex" }],
  }),
  component: AdminLogs,
});

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

/** One entry in the merged timeline — a message or a render job's current
 * status, sorted together by when it happened. A job contributes up to two
 * entries (started, then its current status once that differs), so
 * "what's happening in the background" reads as part of the same
 * continuous story as the conversation, not a separate disconnected list. */
type TimelineEntry =
  | { at: string; kind: "message"; message: MessageRow }
  | { at: string; kind: "job-started"; job: JobRow }
  | { at: string; kind: "job-status"; job: JobRow };

function buildTimeline(messages: MessageRow[], jobs: JobRow[]): TimelineEntry[] {
  const entries: TimelineEntry[] = messages.map((message) => ({
    at: message.created_at,
    kind: "message",
    message,
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
  pending: "bg-slate-100 text-slate-600 ring-1 ring-slate-200",
  generating: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
  done: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  failed: "bg-rose-50 text-rose-700 ring-1 ring-rose-200",
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
      {status === "done" && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
      {status === "failed" && <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />}
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
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <form
        className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900">
            <Sparkles className="h-4 w-4 text-white" />
          </div>
          <h1 className="text-sm font-semibold text-slate-900">Comfortel logs</h1>
        </div>
        <p className="mt-3 text-sm text-slate-500">
          Enter the <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">CRON_SECRET</code>{" "}
          value to connect.
        </p>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Bearer token"
          className="mt-4 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition-shadow focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
        />
        {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
        <button
          type="submit"
          className="mt-4 w-full rounded-lg bg-slate-900 px-3 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-800"
        >
          Connect
        </button>
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
        <span className="w-20 shrink-0 pt-0.5 font-mono text-[11px] text-slate-400">{time}</span>
        <span
          className={`w-20 shrink-0 pt-0.5 text-xs font-medium ${isCustomer ? "text-sky-600" : "text-slate-500"}`}
        >
          {label}
        </span>
        {entry.message.kind === "image" && typeof entry.message.payload["imageUrl"] === "string" ? (
          <div className="min-w-0 flex-1">
            <img
              src={entry.message.payload["imageUrl"] as string}
              alt=""
              className="mb-1 h-20 w-20 rounded-lg border border-slate-200 object-cover"
            />
            <p className="break-words text-sm text-slate-700">{body}</p>
          </div>
        ) : (
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-slate-700">
            {body}
          </p>
        )}
      </div>
    );
  }

  const job = entry.job;
  const isStart = entry.kind === "job-started";
  return (
    <div className="flex gap-3 rounded-lg bg-slate-50 py-2 pl-0 pr-2 ring-1 ring-slate-100">
      <span className="w-20 shrink-0 pt-0.5 font-mono text-[11px] text-slate-400">{time}</span>
      <span className="w-20 shrink-0 pt-0.5 text-xs font-medium text-indigo-600">render</span>
      <div className="min-w-0 flex-1">
        {isStart ? (
          <p className="text-sm text-slate-700">
            Started <span className="font-medium">{job.mode}</span>
            {job.product_ids.length ? ` — ${job.product_ids.join(", ")}` : ""}
            {job.attempt > 0 ? ` (retry ${job.attempt})` : ""}
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <StatusPill status={job.status} />
            {job.error && <span className="text-sm text-rose-600">{job.error}</span>}
            {job.result_url && (
              <a
                href={job.result_url}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-indigo-600 underline underline-offset-2"
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
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await callAdmin<{ jobs: JobRow[]; messages: MessageRow[] }>(
        `/api/admin/wa-status?limit=80&session_key=${encodeURIComponent(sessionKey)}`,
        token,
      );
      setJobs(data.jobs ?? []);
      setMessages(data.messages ?? []);
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

  const timeline = useMemo(() => buildTimeline(messages, jobs), [messages, jobs]);
  const activeJob = jobs.find((j) => j.status === "pending" || j.status === "generating");

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
        <div>
          <h2 className="font-mono text-xs text-slate-400">{shortKey(sessionKey)}</h2>
          {activeJob && (
            <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-amber-600">
              <Loader2 className="h-3 w-3 animate-spin" />A render is in progress
            </div>
          )}
        </div>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-slate-300" />}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {timeline.length === 0 && !loading && (
          <p className="mt-8 text-center text-sm text-slate-400">
            No activity in this session yet.
          </p>
        )}
        <div className="divide-y divide-slate-100">
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
          ? "border-slate-300 bg-white shadow-sm"
          : session.hasError
            ? "border-rose-200 bg-rose-50/60 hover:bg-rose-50"
            : "border-transparent hover:bg-white hover:shadow-sm"
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
            session.hasError ? "bg-rose-100 text-rose-700" : "bg-slate-200 text-slate-600"
          }`}
        >
          {initialsOf(identity.primary)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium text-slate-900">{identity.primary}</span>
            <span className="shrink-0 text-[11px] text-slate-400">
              {timeAgo(session.lastActivity)}
            </span>
          </div>
          {identity.secondary && (
            <span className="text-[11px] text-slate-400">{identity.secondary}</span>
          )}
          <p className="mt-1 truncate text-xs text-slate-500">
            {session.lastMessagePreview ||
              (session.latestJob ? `${session.latestJob.mode} render` : "—")}
          </p>
          <div className="mt-1.5 flex items-center gap-1.5">
            {session.latestJob && <StatusPill status={session.latestJob.status} />}
            {session.hasError && session.latestJob?.error && (
              <span className="truncate text-[11px] text-rose-600">{session.latestJob.error}</span>
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
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

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
      } catch (err) {
        if (err instanceof Error && err.message === "UNAUTHORIZED") {
          window.localStorage.removeItem(TOKEN_KEY);
          setToken(null);
          setAuthError("That token was rejected. Check CRON_SECRET and try again.");
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
    <div className="flex h-screen flex-col bg-slate-50 text-slate-900">
      <header className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6 py-3.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-900">
            <Sparkles className="h-3.5 w-3.5 text-white" />
          </div>
          <h1 className="text-sm font-semibold text-slate-900">Comfortel logs</h1>
          <span className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
            Live
          </span>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            <input
              type="checkbox"
              checked={errorsOnly}
              onChange={(e) => setErrorsOnly(e.target.checked)}
              className="accent-rose-500"
            />
            Errors only
          </label>
          <button
            onClick={() => void load(token, true)}
            className="rounded-lg border border-slate-200 p-1.5 text-slate-500 transition-colors hover:bg-slate-50"
            title="Refresh now"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </header>

      {loadError && (
        <div className="flex shrink-0 items-center gap-2 border-b border-rose-100 bg-rose-50 px-6 py-2 text-xs text-rose-700">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {loadError}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-96 shrink-0 flex-col border-r border-slate-200 bg-slate-50/60">
          <div className="shrink-0 px-4 py-3 text-xs text-slate-500">
            {sessions.length} session{sessions.length === 1 ? "" : "s"}
            {errorCount > 0 && (
              <span className="font-medium text-rose-600"> · {errorCount} with errors</span>
            )}
          </div>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-4">
            {sessions.length === 0 && !loading && (
              <p className="mt-8 px-2 text-center text-sm text-slate-400">
                {errorsOnly ? "No sessions with errors right now." : "No activity yet."}
              </p>
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

        <main className="min-h-0 flex-1 bg-white">
          {selected ? (
            <SessionPane sessionKey={selected} token={token} />
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-slate-400">Select a session to see its full timeline.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
