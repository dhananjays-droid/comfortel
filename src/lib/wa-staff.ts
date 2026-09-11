export type StaffReply = {
  id: string;
  request_reference: string;
  session_key: string;
  body: string;
  state: "sending" | "accepted" | "failed" | "unknown";
  wa_message_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type StaffMessage = {
  wa_message_id: string;
  direction: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type StaffThread = {
  manualMode: boolean;
  customerName: string | null;
  messages: StaffMessage[];
  replies: StaffReply[];
  statuses: { wa_message_id: string; status: string; event_at: string }[];
  replyWindowEndsAt: string | null;
  canReply: boolean;
};

// Only a signed Meta customer timestamp opens a window. Old audit rows without
// it cannot prove eligibility, and queue processing time must not extend it.
export function replyWindow(messages: StaffMessage[], now = Date.now()) {
  const times = messages
    .filter((m) => m.direction === "inbound")
    .map((m) =>
      typeof m.payload["customerSentAt"] === "string"
        ? Date.parse(m.payload["customerSentAt"])
        : NaN,
    )
    .filter((time) => Number.isFinite(time) && time <= now);
  const latest = times.length ? Math.max(...times) : null;
  const end = latest === null ? null : latest + 24 * 60 * 60 * 1000;
  return {
    replyWindowEndsAt: end === null ? null : new Date(end).toISOString(),
    canReply: end !== null && now + 30_000 < end,
  };
}

export function customerTimestamp(value: unknown, now = Date.now()): string | null {
  if (typeof value !== "string" || !/^\d{10,11}$/.test(value)) return null;
  const ms = Number(value) * 1000;
  return Number.isFinite(ms) && ms <= now ? new Date(ms).toISOString() : null;
}
