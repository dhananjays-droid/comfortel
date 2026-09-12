import { beforeEach, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ upsert: vi.fn(), maybeSingle: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      upsert: db.upsert,
      select: () => ({ eq: () => ({ maybeSingle: db.maybeSingle }) }),
    }),
  },
}));
import { loadSession, saveSession } from "@/lib/wa-session-store.server";
import { EMPTY_SESSION, type SessionState } from "@/lib/wa-session";
import { CATALOG_FULL } from "@/lib/catalog";
const id = Object.keys(CATALOG_FULL)[0]!;
const state = (): SessionState => ({
  ...EMPTY_SESSION,
  pendingRender: {
    id: "12345678-1234-4234-8234-123456789012",
    at: Date.now(),
    mode: "refit_room",
    productIds: [id],
    quantities: { [id]: 2 },
    room: { url: "https://example.com/room.jpg", at: Date.now() },
    roomSpec: null,
    note: "Use both white chairs",
  },
});
beforeEach(() => {
  vi.clearAllMocks();
  db.upsert.mockResolvedValue({ error: null });
});
it("persists and restores the same confirmation across webhook invocations", async () => {
  const s = state();
  await saveSession("wa:test", s);
  const row = db.upsert.mock.calls[0]![0];
  expect(row.pending_render).toEqual(s.pendingRender);
  db.maybeSingle.mockResolvedValue({ data: row, error: null });
  expect((await loadSession("wa:test")).pendingRender).toEqual(s.pendingRender);
});
it("refuses to deliver a usable-looking confirmation when persistence fails", async () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  db.upsert.mockResolvedValue({ error: { code: "42703" } });
  await expect(saveSession("wa:test", state())).rejects.toThrow("confirmation could not be saved");
  spy.mockRestore();
});
