import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleAdminRequests } from "@/lib/wa-requests-admin.server";

const mock = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: mock }));
beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "admin-test-secret");
  mock.from.mockReset();
});
const req = (method: string, body?: unknown, auth = true) =>
  new Request("https://example.com/api/admin/wa-requests", {
    method,
    headers: {
      ...(auth ? { authorization: "Bearer admin-test-secret" } : {}),
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

describe("request inbox authorization and updates", () => {
  it.each(["GET", "PATCH", "POST"])(
    "rejects unauthenticated %s without querying customer data",
    async (method) => {
      expect((await handleAdminRequests(req(method, undefined, false))).status).toBe(401);
      expect(mock.from).not.toHaveBeenCalled();
    },
  );
  it("does not permit arbitrary statuses or draft submission by staff", async () => {
    expect(
      (
        await handleAdminRequests(
          req("PATCH", { reference: "CF-1234567890ABCDEF", status: "draft" }),
        )
      ).status,
    ).toBe(400);
    expect(mock.from).not.toHaveBeenCalled();
  });
  it("validates references before querying", async () => {
    expect(
      (await handleAdminRequests(req("PATCH", { reference: "malformed", status: "open" }))).status,
    ).toBe(400);
    expect(mock.from).not.toHaveBeenCalled();
  });
  it("does not expose contact fields in the inbox listing and disables caching", async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      neq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    mock.from.mockReturnValue(chain);
    const response = await handleAdminRequests(req("GET"));
    expect(response.status).toBe(200);
    expect(chain.select.mock.calls[0]?.[0]).not.toContain("phone");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("does not claim a nonexistent request was updated", async () => {
    const chain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    mock.from.mockReturnValue(chain);
    expect(
      (
        await handleAdminRequests(
          req("PATCH", { reference: "CF-1234567890ABCDEF", status: "resolved" }),
        )
      ).status,
    ).toBe(404);
    expect(chain.in).toHaveBeenCalledWith("status", ["open", "in_progress", "resolved"]);
  });
});
