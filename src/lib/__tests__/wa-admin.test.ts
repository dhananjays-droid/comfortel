import { afterEach, describe, expect, it } from "vitest";

import { handleAdminStatus } from "@/lib/wa-admin.server";

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
