import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Loader2, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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

/** A short, glanceable stand-in for the full session_key hash — enough to
 * recognise "is this the same customer as before" across a scrolling feed
 * without ever showing anything that reverses to a phone number. */
function shortKey(sessionKey: string): string {
  const hex = sessionKey.replace(/^wa:/, "");
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
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
  pending: "bg-zinc-500/15 text-zinc-300",
  generating: "bg-amber-500/15 text-amber-300",
  done: "bg-emerald-500/15 text-emerald-300",
  failed: "bg-red-500/15 text-red-300",
};

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status] ?? "bg-zinc-500/15 text-zinc-300"}`}
    >
      {status === "generating" && <Loader2 className="h-3 w-3 animate-spin" />}
      {status}
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
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4">
      <form
        className="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-900 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <h1 className="text-sm font-semibold text-zinc-100">Comfortel logs</h1>
        <p className="mt-1 text-xs text-zinc-400">
          Enter the CRON_SECRET value (same one used for /api/admin/wa-status).
        </p>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Bearer token"
          className="mt-4 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
        />
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        <button
          type="submit"
          className="mt-4 w-full rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 hover:bg-white"
        >
          Connect
        </button>
      </form>
    </div>
  );
}

function EventLine({ m }: { m: MessageRow }) {
  const isIn = m.direction === "inbound";
  const text =
    typeof m.payload["text"] === "string"
      ? (m.payload["text"] as string)
      : typeof m.payload["caption"] === "string"
        ? (m.payload["caption"] as string).split("\n")[0]
        : typeof m.payload["buttonReplyId"] === "string"
          ? `[tapped: ${m.payload["buttonReplyId"]}]`
          : `[${m.kind}]`;
  return (
    <div className="flex gap-2 py-1.5 text-xs">
      <span className="w-14 shrink-0 text-zinc-500">
        {new Date(m.created_at).toLocaleTimeString()}
      </span>
      <span className={`w-16 shrink-0 font-medium ${isIn ? "text-sky-400" : "text-zinc-400"}`}>
        {isIn ? "customer" : "bot"}
      </span>
      <span className="text-zinc-200">{text}</span>
    </div>
  );
}

function JobLine({ j }: { j: JobRow }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950 p-2.5 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium text-zinc-200">
          {j.mode} · {j.product_ids.join(", ")}
        </span>
        <StatusPill status={j.status} />
      </div>
      <div className="mt-1 text-zinc-500">
        started {new Date(j.created_at).toLocaleTimeString()}, updated{" "}
        {new Date(j.updated_at).toLocaleTimeString()}
        {j.attempt > 0 ? `, retry ${j.attempt}` : ""}
      </div>
      {j.error && <div className="mt-1 text-red-400">{j.error}</div>}
      {j.result_url && (
        <a
          href={j.result_url}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-sky-400 underline"
        >
          view result
        </a>
      )}
    </div>
  );
}

function SessionDetail({
  sessionKey,
  token,
  onClose,
}: {
  sessionKey: string;
  token: string;
  onClose: () => void;
}) {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await callAdmin<{ jobs: JobRow[]; messages: MessageRow[] }>(
        `/api/admin/wa-status?limit=50&session_key=${encodeURIComponent(sessionKey)}`,
        token,
      );
      setJobs(data.jobs ?? []);
      setMessages(data.messages ?? []);
    } finally {
      setLoading(false);
    }
  }, [sessionKey, token]);

  useEffect(() => {
    void load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="fixed inset-y-0 right-0 w-full max-w-md overflow-y-auto border-l border-zinc-800 bg-zinc-900 p-4 shadow-xl">
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-sm text-zinc-200">{shortKey(sessionKey)}</h2>
        <button onClick={onClose} className="rounded p-1 text-zinc-400 hover:bg-zinc-800">
          <X className="h-4 w-4" />
        </button>
      </div>

      {loading ? (
        <div className="mt-6 flex justify-center text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : (
        <>
          {jobs.length > 0 && (
            <div className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Render jobs
              </h3>
              <div className="mt-2 space-y-2">
                {jobs.map((j) => (
                  <JobLine key={j.id} j={j} />
                ))}
              </div>
            </div>
          )}

          <div className="mt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Conversation ({messages.length})
            </h3>
            <div className="mt-1 divide-y divide-zinc-800/60">
              {[...messages].reverse().map((m) => (
                <EventLine key={m.wa_message_id} m={m} />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
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
  const [lastFetched, setLastFetched] = useState<Date | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

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
        setLastFetched(new Date());
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
    pollRef.current = setInterval(() => void load(token, false), POLL_MS);
    return () => clearInterval(pollRef.current);
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
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <div>
            <h1 className="text-sm font-semibold">Comfortel logs</h1>
            <p className="text-xs text-zinc-500">
              {sessions.length} active session{sessions.length === 1 ? "" : "s"}
              {errorCount > 0 && <span className="text-red-400"> · {errorCount} with errors</span>}
              {lastFetched && ` · updated ${timeAgo(lastFetched.toISOString())}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={errorsOnly}
                onChange={(e) => setErrorsOnly(e.target.checked)}
                className="accent-red-500"
              />
              Errors only
            </label>
            <button
              onClick={() => void load(token, true)}
              className="rounded-md border border-zinc-700 p-1.5 text-zinc-300 hover:bg-zinc-800"
              title="Refresh now"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-4">
        {loadError && (
          <div className="mb-4 flex items-center gap-2 rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-300">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {loadError}
          </div>
        )}

        {sessions.length === 0 && !loading && !loadError && (
          <p className="mt-12 text-center text-sm text-zinc-500">
            {errorsOnly ? "No sessions with errors right now." : "No activity yet."}
          </p>
        )}

        <div className="space-y-1.5">
          {sessions.map((s) => (
            <button
              key={s.sessionKey}
              onClick={() => setSelected(s.sessionKey)}
              className={`block w-full rounded-md border px-3 py-2.5 text-left transition-colors ${
                s.hasError
                  ? "border-red-900/60 bg-red-950/30 hover:bg-red-950/50"
                  : "border-zinc-800 bg-zinc-900 hover:bg-zinc-800/70"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-zinc-400">{shortKey(s.sessionKey)}</span>
                <div className="flex items-center gap-2">
                  {s.latestJob && <StatusPill status={s.latestJob.status} />}
                  <span className="text-xs text-zinc-500">{timeAgo(s.lastActivity)}</span>
                </div>
              </div>
              <p className="mt-1 truncate text-sm text-zinc-200">
                {s.lastMessagePreview || (s.latestJob ? `${s.latestJob.mode} render` : "—")}
              </p>
              {s.hasError && s.latestJob?.error && (
                <p className="mt-1 truncate text-xs text-red-400">{s.latestJob.error}</p>
              )}
            </button>
          ))}
        </div>
      </main>

      {selected && (
        <SessionDetail sessionKey={selected} token={token} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
