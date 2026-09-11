import { useCallback, useEffect, useState } from "react";
import type { RequestRecord } from "@/lib/wa-requests";

type InboxRequest = RequestRecord & { created_at: string; updated_at: string };

export function RequestsInbox({
  token,
  onSession,
}: {
  token: string;
  onSession: (key: string) => void;
}) {
  const [requests, setRequests] = useState<InboxRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [contacts, setContacts] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("active");
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/wa-requests", {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok)
        throw new Error("Could not load the request inbox. Check access and database migration.");
      const data = (await res.json()) as { requests: InboxRequest[] };
      setRequests(data.requests);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Inbox unavailable");
    }
  }, [token]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => clearInterval(timer);
  }, [load]);

  async function update(reference: string, status: string) {
    setBusy(reference);
    try {
      const res = await fetch("/api/admin/wa-requests", {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ reference, status }),
      });
      if (!res.ok) throw new Error("Status was not saved. Please retry.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusy(null);
    }
  }
  async function reveal(reference: string) {
    try {
      const res = await fetch(
        `/api/admin/wa-requests?reference=${encodeURIComponent(reference)}&contact=1`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error("Contact could not be retrieved.");
      const data = (await res.json()) as { phone: string };
      setContacts((prev) => ({ ...prev, [reference]: data.phone }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Contact unavailable");
    }
  }

  const shown = requests.filter(
    (r) =>
      filter === "all" || (filter === "active" ? r.status !== "resolved" : r.category === filter),
  );
  return (
    <section className="h-full overflow-auto p-6 text-slate-100">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">WhatsApp requests</h2>
        <button onClick={() => void load()} className="rounded border border-white/20 px-3 py-1">
          Refresh
        </button>
      </div>
      <p className="mb-4 text-sm text-slate-400">
        Internal inbox · latest 200 submitted requests. Status changes do not notify the customer or
        change an order/booking. Contact customers using the team's approved channel; this dashboard
        does not send replies.
      </p>
      <label className="mb-4 block">
        Show{" "}
        <select
          className="ml-2 rounded bg-slate-800 p-2"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          {["active", "all", "sales", "support", "order", "complaint"].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      {error && (
        <p role="alert" className="mb-4 text-rose-300">
          {error}
        </p>
      )}
      {!shown.length && !error && (
        <p className="text-slate-400">No submitted requests in this view.</p>
      )}
      <div className="space-y-4">
        {shown.map((r) => (
          <article key={r.reference} className="rounded-xl border border-white/10 bg-slate-900 p-4">
            <div className="flex flex-wrap items-center gap-3">
              <strong>{r.reference}</strong>
              <span>{r.category}</span>
              <span className="text-xs text-slate-400">
                {new Date(r.created_at).toLocaleString()}
              </span>
              <select
                aria-label={`Status for ${r.reference}`}
                className="ml-auto rounded bg-slate-800 p-2"
                value={r.status}
                disabled={busy === r.reference}
                onChange={(e) => void update(r.reference, e.target.value)}
              >
                {["open", "in_progress", "resolved"].map((value) => (
                  <option key={value} value={value}>
                    {value.replace("_", " ")}
                  </option>
                ))}
              </select>
            </div>
            <div className="my-3 space-y-2">
              {r.details.map((d) => (
                <div key={d.messageId}>
                  <p className="whitespace-pre-wrap break-words text-sm">{d.text}</p>
                  {d.imageUrl && /^https:\/\//i.test(d.imageUrl) && (
                    <a
                      href={d.imageUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-indigo-300 underline"
                    >
                      View customer photo
                    </a>
                  )}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <button onClick={() => onSession(r.session_key)} className="text-indigo-300">
                View conversation
              </button>
              {contacts[r.reference] ? (
                <span>Contact: +{contacts[r.reference]}</span>
              ) : (
                <button onClick={() => void reveal(r.reference)} className="text-indigo-300">
                  Reveal customer contact
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
