import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
}));

import { cancelActiveRenderJobs, getActiveRenderState } from "@/lib/wa-render-jobs.server";

function queryBuilder(rows: Array<{ id?: string; status?: string; created_at?: string }>) {
  const builder = {
    select: vi.fn((columns: string) =>
      columns === "id" ? Promise.resolve({ data: rows, error: null }) : builder,
    ),
    update: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    in: vi.fn(() => builder),
    order: vi.fn(() => Promise.resolve({ data: rows, error: null })),
  };
  return builder;
}

describe("WhatsApp render job controls", () => {
  beforeEach(() => mocks.from.mockReset());

  it("summarizes all queued and generating work for a conversation", async () => {
    mocks.from.mockReturnValue(
      queryBuilder([
        { status: "pending", created_at: "2026-09-11T00:00:00Z" },
        { status: "generating", created_at: "2026-09-11T00:00:05Z" },
      ]),
    );
    await expect(getActiveRenderState("wa:test")).resolves.toEqual({
      count: 2,
      pending: 1,
      generating: 1,
      oldestCreatedAt: "2026-09-11T00:00:00Z",
    });
  });

  it("cancels both queued and generating work", async () => {
    const builder = queryBuilder([{ id: "a" }, { id: "b" }]);
    mocks.from.mockReturnValue(builder);
    await expect(cancelActiveRenderJobs("wa:test")).resolves.toBe(2);
    expect(builder.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled", error: "Cancelled by customer" }),
    );
    expect(builder.in).toHaveBeenCalledWith("status", ["pending", "generating"]);
  });
});
