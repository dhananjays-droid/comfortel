import { afterEach, describe, expect, it } from "vitest";

import {
  handleAdminSessions,
  handleAdminStatus,
  previewOf,
  type WaMessageRow,
} from "@/lib/wa-admin.server";

/**
 * Only the auth guard is unit-tested here — same reasoning as
 * wa-render-worker.test.ts: the actual query hits Supabase directly, which
 * this test environment has no credentials for.
 */

const ORIGINAL_SECRET = process.env["CRON_SECRET"];
afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env["CRON_SECRET"];
  else process.env["CRON_SECRET"] = ORIGINAL_SECRET;
});

function request(authorization?: string): Request {
  return new Request("https://example.com/api/admin/wa-status", {
    headers: authorization ? { authorization } : {},
  });
}

describe("handleAdminStatus auth guard", () => {
  it("rejects a request with no CRON_SECRET configured at all", async () => {
    delete process.env["CRON_SECRET"];
    const res = await handleAdminStatus(request("Bearer anything"));
    expect(res.status).toBe(401);
  });

  it("rejects a request missing the Authorization header", async () => {
    process.env["CRON_SECRET"] = "test-secret";
    const res = await handleAdminStatus(request());
    expect(res.status).toBe(401);
  });

  it("rejects a request bearing the wrong secret", async () => {
    process.env["CRON_SECRET"] = "test-secret";
    const res = await handleAdminStatus(request("Bearer wrong-secret"));
    expect(res.status).toBe(401);
  });
});

function sessionsRequest(authorization?: string): Request {
  return new Request("https://example.com/api/admin/wa-sessions", {
    headers: authorization ? { authorization } : {},
  });
}

describe("handleAdminSessions auth guard", () => {
  it("rejects a request with no CRON_SECRET configured at all", async () => {
    delete process.env["CRON_SECRET"];
    const res = await handleAdminSessions(sessionsRequest("Bearer anything"));
    expect(res.status).toBe(401);
  });

  it("rejects a request missing the Authorization header", async () => {
    process.env["CRON_SECRET"] = "test-secret";
    const res = await handleAdminSessions(sessionsRequest());
    expect(res.status).toBe(401);
  });

  it("rejects a request bearing the wrong secret", async () => {
    process.env["CRON_SECRET"] = "test-secret";
    const res = await handleAdminSessions(sessionsRequest("Bearer wrong-secret"));
    expect(res.status).toBe(401);
  });
});

function message(overrides: Partial<WaMessageRow>): WaMessageRow {
  return {
    wa_message_id: "wamid.1",
    direction: "inbound",
    session_key: "wa:test",
    kind: "text",
    payload: {},
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("previewOf", () => {
  it("shows a text message with a directional arrow", () => {
    expect(
      previewOf(message({ direction: "inbound", kind: "text", payload: { text: "hi" } })),
    ).toBe("→ hi");
    expect(
      previewOf(message({ direction: "outbound", kind: "text", payload: { text: "hello" } })),
    ).toBe("← hello");
  });

  it("shows an image's caption, first line only", () => {
    expect(
      previewOf(
        message({
          kind: "image",
          direction: "outbound",
          payload: { caption: "*Oakley Chair*\n$599\nhttps://x" },
        }),
      ),
    ).toBe("← [image] *Oakley Chair*");
  });

  it("shows a button tap by its id, not the (usually null) text", () => {
    expect(
      previewOf(
        message({
          kind: "interactive",
          direction: "inbound",
          payload: { buttonReplyId: "pkg:balanced" },
        }),
      ),
    ).toBe("→ [tapped: pkg:balanced]");
  });

  it("falls back to a bracketed kind for anything else", () => {
    expect(previewOf(message({ kind: "template", payload: {} }))).toBe("→ [template]");
  });
});
