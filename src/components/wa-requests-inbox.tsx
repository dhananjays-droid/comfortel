import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCheck,
  Clock3,
  ExternalLink,
  Inbox,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import type { RequestRecord } from "@/lib/wa-requests";
import type { StaffMessage, StaffReply, StaffThread } from "@/lib/wa-staff";

type InboxRequest = RequestRecord & { created_at: string; updated_at: string };
type Fetcher = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type ReplyDraft = { draft: string; attempt: { id: string; body: string } | null };
const statusLabel = (s: string) =>
  ({ open: "New", in_progress: "In progress", resolved: "Resolved" })[s] ?? s;
const time = (s: string) =>
  new Date(s).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const safeLink = (s: unknown): s is string => typeof s === "string" && /^https:\/\//i.test(s);
const control =
  "rounded-lg border border-border bg-secondary/60 px-3 py-2 text-xs transition hover:bg-secondary disabled:opacity-40";

export function RequestsInbox({
  token,
  onSession,
}: {
  token: string;
  onSession: (key: string) => void;
}) {
  const [requests, setRequests] = useState<InboxRequest[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("active");
  const [search, setSearch] = useState("");
  const drafts = useRef<Record<string, ReplyDraft>>({});
  const fetcher = useCallback(
    async <T,>(path: string, method = "GET", body?: unknown): Promise<T> => {
      const response = await fetch("/api/admin/wa-requests" + path, {
        method,
        headers: {
          authorization: "Bearer " + token,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? "Request failed. Please refresh and try again.");
      return data as T;
    },
    [token],
  );
  const load = useCallback(async () => {
    try {
      const data = await fetcher<{ requests: InboxRequest[] }>("");
      setRequests(data.requests);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Inbox unavailable");
    } finally {
      setLoading(false);
    }
  }, [fetcher]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => clearInterval(timer);
  }, [load]);
  const shown = requests.filter(
    (r) =>
      (filter === "all" ||
        (filter === "active"
          ? r.status !== "resolved"
          : filter === "resolved"
            ? r.status === "resolved"
            : r.category === filter)) &&
      (r.reference + " " + r.category + " " + r.details.map((d) => d.text).join(" "))
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const current = requests.find((r) => r.reference === selected);
  const active = requests.filter((r) => r.status !== "resolved");
  return (
    <section className="flex h-full min-h-0 w-full flex-col text-foreground">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b border-border px-5 py-5 sm:px-7">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-primary-soft p-3 text-foreground">
            <Inbox className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Customer inbox</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              WhatsApp requests · one place to help your customers
            </p>
          </div>
        </div>
        <div className="flex items-center gap-5">
          <div className="text-right">
            <div className="text-xl font-semibold">{active.length}</div>
            <div className="text-[11px] text-muted-foreground">Active requests</div>
          </div>
          <button aria-label="Refresh requests" onClick={() => void load()} className={control}>
            <RefreshCw className={"h-4 w-4 " + (loading ? "animate-spin" : "")} />
          </button>
        </div>
      </div>
      {error && (
        <p
          role="alert"
          className="border-b border-rose-400/20 bg-rose-400/10 px-5 py-3 text-sm text-rose-800"
        >
          {error}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <aside
          className={
            (selected ? "hidden md:flex" : "flex") +
            " w-full shrink-0 flex-col border-r border-border bg-card md:w-80 lg:w-96"
          }
        >
          <div className="space-y-3 border-b border-border p-4">
            <label className="flex items-center gap-2 rounded-xl border border-border bg-background px-3">
              <Search className="h-4 w-4 text-muted-foreground" />
              <input
                aria-label="Search requests"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search request or message…"
                className="w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
              />
            </label>
            <select
              aria-label="Filter requests"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-xs"
            >
              {[
                ["active", "Active requests"],
                ["all", "All requests"],
                ["sales", "Sales"],
                ["support", "Support"],
                ["order", "Orders"],
                ["complaint", "Complaints"],
                ["resolved", "Resolved"],
              ].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
            {loading ? (
              <p className="p-6 text-sm text-muted-foreground">Loading requests…</p>
            ) : !shown.length ? (
              <div className="px-5 py-12 text-center text-sm text-muted-foreground">
                <Inbox className="mx-auto mb-3 h-7 w-7 opacity-40" />
                No requests in this view.
              </div>
            ) : (
              shown.map((r) => (
                <button
                  key={r.reference}
                  onClick={() => setSelected(r.reference)}
                  className={
                    "w-full rounded-xl border p-4 text-left transition " +
                    (selected === r.reference
                      ? "border-primary-strong bg-primary-soft"
                      : "border-transparent hover:bg-secondary/60")
                  }
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span
                      className={
                        "rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wider " +
                        (r.category === "complaint"
                          ? "bg-rose-400/10 text-rose-700"
                          : "bg-secondary/60 text-foreground")
                      }
                    >
                      {r.category}
                    </span>
                    <span className="text-[10px] text-muted-foreground">{time(r.created_at)}</span>
                  </div>
                  <p className="line-clamp-2 text-sm leading-6 text-foreground">
                    {r.details[0]?.text || "Customer request"}
                  </p>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-[10px] text-muted-foreground">
                      {r.reference}
                    </span>
                    <span
                      className={
                        "shrink-0 text-[11px] " +
                        (r.status === "resolved" ? "text-emerald-800" : "text-amber-800")
                      }
                    >
                      {statusLabel(r.status)}
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
          <p className="border-t border-border p-3 text-center text-[10px] text-muted-foreground">
            Latest 200 requests · refreshes every 15 seconds
          </p>
        </aside>
        <div className={(selected ? "flex" : "hidden md:flex") + " min-w-0 flex-1 flex-col"}>
          {current ? (
            <RequestPane
              key={current.reference}
              request={current}
              drafts={drafts.current}
              fetcher={fetcher}
              reload={load}
              onBack={() => setSelected(null)}
              onSession={() => onSession(current.session_key)}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center p-8 text-center">
              <div className="mb-5 rounded-2xl border border-border bg-card p-5">
                <MessageSquare className="h-8 w-8 text-foreground" />
              </div>
              <h3 className="font-medium">Make the next reply a helpful one</h3>
              <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
                Select a request to read the conversation, take over from the assistant and reply on
                WhatsApp.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function RequestPane({
  request: r,
  drafts,
  fetcher,
  reload,
  onBack,
  onSession,
}: {
  request: InboxRequest;
  drafts: Record<string, ReplyDraft>;
  fetcher: Fetcher;
  reload: () => Promise<void>;
  onBack: () => void;
  onSession: () => void;
}) {
  const [thread, setThread] = useState<StaffThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, updateDraft] = useState(drafts[r.reference]?.draft ?? "");
  const [contact, setContact] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, updateAttempt] = useState(drafts[r.reference]?.attempt ?? null);
  function setDraft(value: string) {
    drafts[r.reference] = { draft: value, attempt: drafts[r.reference]?.attempt ?? null };
    updateDraft(value);
  }
  function setAttempt(value: ReplyDraft["attempt"]) {
    drafts[r.reference] = { draft: drafts[r.reference]?.draft ?? "", attempt: value };
    updateAttempt(value);
  }
  const tail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    tail.current?.scrollIntoView({ block: "end" });
  }, [thread?.messages.length, thread?.replies.length]);
  const refresh = useCallback(async () => {
    try {
      setThread(await fetcher<StaffThread>("?reference=" + r.reference + "&thread=1"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Conversation unavailable");
      setThread(null);
    }
  }, [fetcher, r.reference]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function change(body: Record<string, unknown>) {
    setBusy(true);
    try {
      await fetcher("", "PATCH", { reference: r.reference, ...body });
      await refresh();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    if (busy || (!attempt && !draft.trim())) return;
    const outgoing = attempt ?? { id: crypto.randomUUID(), body: draft.trim() };
    setAttempt(outgoing);
    setBusy(true);
    setNotice(null);
    try {
      const { reply } = await fetcher<{ reply: Pick<StaffReply, "state" | "error"> }>("", "POST", {
        reference: r.reference,
        ...outgoing,
      });
      if (reply.state === "accepted") {
        setDraft("");
        setAttempt(null);
        setNotice("Accepted by WhatsApp. Delivery updates will appear below.");
      } else if (reply.state === "failed") {
        setAttempt(null);
        setNotice(reply.error ?? "WhatsApp rejected this message.");
      } else {
        setNotice(
          reply.error ??
            "Send is pending or unconfirmed. Check its status; do not send a replacement yet.",
        );
      }
      await refresh();
    } catch (e) {
      setNotice(
        e instanceof Error
          ? e.message
          : "Send could not be confirmed. Check status before retrying.",
      );
    } finally {
      setBusy(false);
    }
  }
  const ends = thread?.replyWindowEndsAt ? Date.parse(thread.replyWindowEndsAt) : 0;
  const open = Boolean(thread?.canReply && Date.now() + 30000 < ends);
  const replyIds = new Set(thread?.replies.map((x) => x.wa_message_id).filter(Boolean));
  const items = [
    ...(thread?.messages
      .filter((m) => !replyIds.has(m.wa_message_id))
      .map((m) => ({ id: m.wa_message_id, at: m.created_at, message: m, reply: null })) ?? []),
    ...(thread?.replies.map((reply) => ({
      id: reply.id,
      at: reply.created_at,
      message: null,
      reply,
    })) ?? []),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <>
      <div className="shrink-0 border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button aria-label="Back to requests" onClick={onBack} className="md:hidden">
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="rounded-full bg-secondary p-2.5">
              <UserRound className="h-4 w-4 text-foreground" />
            </div>
            <div>
              <h3 className="text-sm font-semibold">
                {thread?.customerName || "WhatsApp customer"}
              </h3>
              <p className="mt-1 font-mono text-[10px] text-muted-foreground">{r.reference}</p>
            </div>
          </div>
          <select
            aria-label="Request status"
            disabled={busy}
            value={r.status}
            onChange={(e) => void change({ status: e.target.value })}
            className="rounded-lg border border-border bg-card px-3 py-2 text-xs"
          >
            {["open", "in_progress", "resolved"].map((v) => (
              <option value={v} key={v}>
                {statusLabel(v)}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          <button onClick={onSession} className="hover:text-foreground">
            Open diagnostic logs <ExternalLink className="inline h-3 w-3" />
          </button>
          <span>·</span>
          {contact ? (
            <span>+{contact}</span>
          ) : (
            <button
              onClick={() =>
                void fetcher<{ phone: string }>("?reference=" + r.reference + "&contact=1")
                  .then((x) => setContact(x.phone))
                  .catch(() => setError("Contact unavailable"))
              }
              className="hover:text-foreground"
            >
              Reveal contact
            </button>
          )}
          <span className="ml-auto">Status changes are internal only</span>
        </div>
      </div>
      <div
        className={
          "flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-3 " +
          (thread?.manualMode ? "border-amber-300/10 bg-amber-300/5" : "border-border bg-card")
        }
      >
        <div>
          <p
            className={
              "text-xs font-medium " + (thread?.manualMode ? "text-amber-800" : "text-foreground")
            }
          >
            <ShieldCheck className="mr-1.5 inline h-3.5 w-3.5" />
            {thread?.manualMode ? "Staff is handling this conversation" : "Assistant is active"}
          </p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {thread?.manualMode
              ? "New messages stay in this inbox. Existing render jobs may still finish."
              : "Take over before replying so the assistant does not reply alongside you."}
          </p>
        </div>
        <button
          disabled={busy || !thread || Boolean(attempt)}
          onClick={() => void change({ manualMode: !thread?.manualMode })}
          className={control}
        >
          {thread?.manualMode ? "Return to bot" : "Take over"}
        </button>
      </div>
      {error && (
        <p role="alert" className="shrink-0 bg-rose-400/10 px-5 py-3 text-xs text-rose-800">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-7">
        <details className="rounded-xl border border-border bg-card p-4">
          <summary className="cursor-pointer text-xs font-medium text-foreground">
            Original {r.category} request · {r.details.length} detail
            {r.details.length === 1 ? "" : "s"}
          </summary>
          <div className="mt-3 space-y-3">
            {r.details.map((d) => (
              <div key={d.messageId}>
                <p className="whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">
                  {d.text}
                </p>
                {safeLink(d.imageUrl) && (
                  <a
                    href={d.imageUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-block text-xs text-foreground underline"
                  >
                    View attached photo
                  </a>
                )}
              </div>
            ))}
          </div>
        </details>
        {!thread && !error && (
          <p className="text-center text-xs text-muted-foreground">Loading conversation…</p>
        )}
        {items.map((item) => (
          <ConversationBubble
            key={item.id}
            message={item.message}
            reply={item.reply}
            statuses={thread?.statuses ?? []}
          />
        ))}
        {thread && (
          <p className="text-center text-[10px] text-muted-foreground">
            Showing recent conversation history for this customer
          </p>
        )}
        <div ref={tail} />
      </div>
      <div className="shrink-0 border-t border-border bg-card p-4 sm:px-6">
        <div
          className={
            "mb-3 flex items-center gap-2 text-[11px] " +
            (open ? "text-emerald-800" : "text-amber-800")
          }
        >
          <Clock3 className="h-3.5 w-3.5" />
          {open
            ? "Reply window open · closes " + time(thread!.replyWindowEndsAt!)
            : "Free-text reply unavailable. Wait for a new customer message; template sending is not enabled here."}
        </div>
        <label className="sr-only" htmlFor={"reply-" + r.reference}>
          Reply on WhatsApp
        </label>
        <textarea
          id={"reply-" + r.reference}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy || Boolean(attempt) || !thread?.manualMode || !open}
          rows={3}
          maxLength={4000}
          placeholder={
            thread?.manualMode
              ? "Write a helpful reply…"
              : "Take over this conversation to write a reply…"
          }
          className="w-full resize-y rounded-xl border border-border bg-background p-3 text-sm leading-6 outline-none focus:border-primary-strong disabled:opacity-40"
        />
        {notice && (
          <p role="status" className="mt-2 text-xs leading-5 text-amber-900">
            {notice}
          </p>
        )}
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[10px] text-muted-foreground">
            {draft.length}/4000 · Sent as Comfortel
          </span>
          <button
            disabled={busy || (!attempt && (!draft.trim() || !thread?.manualMode || !open))}
            onClick={() => void send()}
            className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-xs font-semibold text-foreground transition hover:bg-primary-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            {attempt ? "Check send status" : "Send WhatsApp reply"}
          </button>
        </div>
        {attempt && (
          <button
            className="mt-2 text-[10px] text-muted-foreground underline"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  "Only continue if you have checked WhatsApp and the reply history. An unconfirmed message may already have been sent. Start a separate reply?",
                )
              ) {
                setAttempt(null);
                setDraft("");
                setNotice(null);
              }
            }}
          >
            I have checked the outcome · start a new reply
          </button>
        )}
      </div>
    </>
  );
}

function ConversationBubble({
  message,
  reply,
  statuses,
}: {
  message: StaffMessage | null;
  reply: StaffReply | null;
  statuses: StaffThread["statuses"];
}) {
  const incoming = message?.direction === "inbound";
  const staff = Boolean(reply) || message?.payload["sender"] === "staff";
  const p = message?.payload;
  const text =
    reply?.body ??
    p?.["text"] ??
    p?.["caption"] ??
    p?.["imageCaption"] ??
    p?.["buttonReplyTitle"] ??
    (message?.kind === "image" ? "Photo" : message?.kind === "document" ? "Document" : "Message");
  const imageUrl = p?.["imageUrl"];
  const mid = reply?.wa_message_id ?? message?.wa_message_id;
  const events = statuses.filter((s) => s.wa_message_id === mid);
  const delivery = events.some((s) => s.status === "read")
    ? "Read"
    : events.some((s) => s.status === "delivered")
      ? "Delivered"
      : events.some((s) => s.status === "failed")
        ? "Delivery failed"
        : events.some((s) => s.status === "sent")
          ? "Sent"
          : reply?.state === "accepted"
            ? "Accepted by WhatsApp"
            : reply?.state === "sending"
              ? "Pending / unconfirmed"
              : reply?.state === "unknown"
                ? "Outcome unknown"
                : reply?.state === "failed"
                  ? "Not sent"
                  : "";
  return (
    <div className={"flex " + (incoming ? "justify-start" : "justify-end")}>
      <div className="max-w-[90%] sm:max-w-[80%]">
        <div
          className={"mb-1.5 text-[10px] text-muted-foreground " + (incoming ? "" : "text-right")}
        >
          {incoming ? "Customer" : staff ? "Comfortel team" : "Assistant"}
        </div>
        <div
          className={
            "rounded-2xl px-4 py-3 " +
            (incoming
              ? "rounded-tl-sm border border-border bg-secondary"
              : staff
                ? "rounded-tr-sm border border-primary-strong/40 bg-primary-soft"
                : "rounded-tr-sm border border-border/60 bg-secondary/60")
          }
        >
          <p className="whitespace-pre-wrap break-words text-sm leading-6">
            {typeof text === "string" ? text : "Message"}
          </p>
          {safeLink(imageUrl) && (
            <a
              href={imageUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 block text-xs text-foreground underline"
            >
              View image <ExternalLink className="inline h-3 w-3" />
            </a>
          )}
          {reply?.error && <p className="mt-2 text-xs text-amber-800">{reply.error}</p>}
        </div>
        <div
          className={
            "mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground " +
            (incoming ? "" : "justify-end")
          }
        >
          <span>{time(reply?.created_at ?? message!.created_at)}</span>
          {delivery && (
            <span className={delivery === "Read" ? "text-sky-800" : ""}>
              <CheckCheck className="mr-1 inline h-3 w-3" />
              {delivery}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
