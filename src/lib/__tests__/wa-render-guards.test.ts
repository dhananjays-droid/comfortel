import { afterEach, describe, expect, it, vi } from "vitest";
const { insert } = vi.hoisted(() => ({ insert: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: () => ({ insert }) },
}));
import { claimRenderAction } from "@/lib/wa-render-guards.server";
afterEach(() => {
  vi.restoreAllMocks();
  insert.mockReset();
});
describe("durable render notification claims", () => {
  it("only permits one of many simultaneous pollers per job and milestone", async () => {
    const saved = new Set<string>();
    insert.mockImplementation(async (row: { wa_message_id: string }) => {
      if (saved.has(row.wa_message_id)) return { error: { code: "23505" } };
      saved.add(row.wa_message_id);
      return { error: null };
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => claimRenderAction("job1", "session", "progress:initial")),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await claimRenderAction("job1", "session", "progress:late")).toBe(true);
    expect(await claimRenderAction("job2", "session", "progress:initial")).toBe(true);
    expect(await claimRenderAction("job1", "session", "progress:initial")).toBe(false);
  });
  it("does not send progress or start a retry when the claim cannot be stored", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    insert.mockResolvedValue({ error: { code: "503" } });
    expect(await claimRenderAction("job", "session", "progress:initial")).toBe(false);
  });
});
