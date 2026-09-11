import { afterEach, describe, expect, it, vi } from "vitest";
import { customerTimestamp, replyWindow, type StaffMessage, type StaffReply } from "@/lib/wa-staff";
import { replyToRequest, type ReplyDependencies } from "@/lib/wa-staff.server";
import { sendStaffText, WaClientError } from "@/lib/wa-client.server";

const reference = "CF-1234567890ABCDEF";
const id = "12345678-1234-4234-8234-123456789012";
const key = "wa:test";
const incoming = (at: number): StaffMessage => ({
  wa_message_id: "in",
  direction: "inbound",
  kind: "text",
  payload: { customerSentAt: new Date(at).toISOString() },
  created_at: new Date().toISOString(),
});
function fixture() {
  const rows = new Map<string, StaffReply>();
  const db: ReplyDependencies = {
    request: vi.fn(async () => ({
      reference,
      session_key: key,
      status: "open",
      customer_phone_enc: "encrypted",
    })),
    manual: vi.fn(async () => true),
    incoming: vi.fn(async () => [incoming(Date.now() - 60000)]),
    find: vi.fn(async (id) => rows.get(id) ?? null),
    claim: vi.fn(async (row) => {
      if (rows.has(row.id)) return false;
      rows.set(row.id, {
        ...row,
        state: "sending",
        wa_message_id: null,
        error: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      return true;
    }),
    finish: vi.fn(async (id, state, mid, error) => {
      Object.assign(rows.get(id)!, { state, wa_message_id: mid, error });
    }),
    phone: vi.fn(() => "15551234567"),
    key: vi.fn(() => key),
    send: vi.fn(async () => "wamid.staff"),
    log: vi.fn(async () => {}),
  };
  return { db, rows };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("staff reply window", () => {
  it("uses the customer's sent time, not delayed queue processing", () => {
    const now = Date.now();
    expect(replyWindow([incoming(now - 25 * 3600000)], now).canReply).toBe(false);
    expect(replyWindow([incoming(now - 3600000)], now).canReply).toBe(true);
  });
  it("fails closed for old logs without signed timestamps, future and invalid timestamps", () => {
    expect(replyWindow([{ ...incoming(Date.now()), payload: {} }]).canReply).toBe(false);
    expect(replyWindow([incoming(Date.now() + 60000)]).canReply).toBe(false);
    expect(customerTimestamp("oops")).toBeNull();
    expect(customerTimestamp(String(Math.floor(Date.now() / 1000) + 100))).toBeNull();
    expect(customerTimestamp("1789056000", 1789056001000)).toBe("2026-09-10T16:00:00.000Z");
  });
  it("does not let outbound messages reopen the window and keeps a safety margin", () => {
    const now = Date.now();
    expect(replyWindow([{ ...incoming(now), direction: "outbound" }], now).canReply).toBe(false);
    expect(replyWindow([incoming(now - 24 * 3600000 + 20000)], now).canReply).toBe(false);
  });
});
describe("staff reply safety", () => {
  it.each(["", "x".repeat(4001)])("rejects invalid length before any query", async (body) => {
    const { db } = fixture();
    expect((await replyToRequest({ reference, id, body }, db)).status).toBe(400);
    expect(db.request).not.toHaveBeenCalled();
  });
  it("requires a valid UUID and reference", async () => {
    const { db } = fixture();
    expect((await replyToRequest({ reference, id: "bad", body: "hello" }, db)).status).toBe(400);
  });
  it("requires takeover", async () => {
    const { db } = fixture();
    db.manual = vi.fn(async () => false);
    expect((await replyToRequest({ reference, id, body: "hello" }, db)).status).toBe(409);
    expect(db.send).not.toHaveBeenCalled();
  });
  it("blocks expired windows on the server", async () => {
    const { db } = fixture();
    db.incoming = vi.fn(async () => [incoming(Date.now() - 25 * 3600000)]);
    expect((await replyToRequest({ reference, id, body: "hello" }, db)).status).toBe(409);
    expect(db.claim).not.toHaveBeenCalled();
  });
  it("rejects a missing or unsubmitted request", async () => {
    const { db } = fixture();
    db.request = vi.fn(async () => null);
    expect((await replyToRequest({ reference, id, body: "hello" }, db)).status).toBe(404);
    expect(db.send).not.toHaveBeenCalled();
  });
  it("verifies the server-resolved recipient matches the session", async () => {
    const { db } = fixture();
    db.key = vi.fn(() => "wa:other");
    expect((await replyToRequest({ reference, id, body: "hello" }, db)).status).toBe(409);
    expect(db.send).not.toHaveBeenCalled();
  });
  it("claims once and returns the saved result on retries", async () => {
    const { db } = fixture();
    const input = { reference, id, body: "hello" };
    await replyToRequest(input, db);
    const again = await replyToRequest(input, db);
    expect((await again.json()).reply.state).toBe("accepted");
    expect(db.send).toHaveBeenCalledTimes(1);
    expect(db.log).toHaveBeenCalledWith("wamid.staff", key, "hello", reference);
  });
  it("concurrent identical requests send at most once", async () => {
    const { db } = fixture();
    await Promise.all([
      replyToRequest({ reference, id, body: "hello" }, db),
      replyToRequest({ reference, id, body: "hello" }, db),
    ]);
    expect(db.send).toHaveBeenCalledTimes(1);
  });
  it("cannot reuse an ID for changed content or another request", async () => {
    const { db } = fixture();
    await replyToRequest({ reference, id, body: "hello" }, db);
    expect((await replyToRequest({ reference, id, body: "changed" }, db)).status).toBe(409);
    expect(
      (await replyToRequest({ reference: "CF-ABCDEF1234567890", id, body: "hello" }, db)).status,
    ).toBe(409);
    expect(db.send).toHaveBeenCalledTimes(1);
  });
  it("does not send if the durable claim fails", async () => {
    const { db } = fixture();
    db.claim = vi.fn(async () => {
      throw new Error("db offline");
    });
    await expect(replyToRequest({ reference, id, body: "hello" }, db)).rejects.toThrow(
      "db offline",
    );
    expect(db.send).not.toHaveBeenCalled();
  });
  it("never automatically retries a timeout or uncertain provider failure", async () => {
    const { db } = fixture();
    db.send = vi.fn(async () => {
      throw new Error("timeout");
    });
    const input = { reference, id, body: "hello" };
    expect((await (await replyToRequest(input, db)).json()).reply.state).toBe("unknown");
    await replyToRequest(input, db);
    expect(db.send).toHaveBeenCalledTimes(1);
  });
  it("records an explicit rejection without claiming delivery", async () => {
    const { db } = fixture();
    db.send = vi.fn(async () => {
      throw new WaClientError("rejected", 400, {});
    });
    expect(
      (await (await replyToRequest({ reference, id, body: "hello" }, db)).json()).reply.state,
    ).toBe("failed");
  });
  it("does not resend after an accepted send followed by an audit failure", async () => {
    const { db } = fixture();
    db.finish = vi.fn(async () => {
      throw new Error("offline");
    });
    const input = { reference, id, body: "hello" };
    const result = await (await replyToRequest(input, db)).json();
    expect(result.reply.state).toBe("unknown");
    expect(result.reply.wa_message_id).toBe("wamid.staff");
    expect((await replyToRequest(input, db)).status).toBe(202);
    expect(db.send).toHaveBeenCalledTimes(1);
  });
  it("sends a long staff reply without truncation", async () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "test");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "test");
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ messages: [{ id: "wamid" }] })),
    );
    vi.stubGlobal("fetch", fetcher);
    const body = "x".repeat(3000);
    await sendStaffText("15551234567", body);
    expect(
      JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).text
        .body,
    ).toBe(body);
  });
});
