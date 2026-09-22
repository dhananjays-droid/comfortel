import type { Database } from "@/integrations/supabase/types";
import type { RequestStore } from "@/lib/wa-requests.server";

type Row = Database["public"]["Tables"]["wa_requests"]["Row"];

/** In-memory wa_requests with the production constraints that matter here:
 * one unsent draft per chat and category, drafts ordered by last touch. */
export function memoryRequestStore(rows: Row[] = []): RequestStore & { rows: Row[] } {
  let tick = 0;
  const stamp = () => new Date(Date.now() + ++tick).toISOString();
  return {
    rows,
    latest: async (session) => [...rows].reverse().find((r) => r.session_key === session) ?? null,
    drafts: async (session) =>
      rows
        .filter((r) => r.session_key === session && r.status === "draft")
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    find: async (session, reference) =>
      rows.find((r) => r.session_key === session && r.reference === reference) ?? null,
    replay: async (session, message) =>
      rows.find((r) => r.session_key === session && r.last_inbound_id === message) ?? null,
    create: async (row) => {
      const status = row.status ?? "draft";
      if (
        status === "draft" &&
        rows.some(
          (r) =>
            r.session_key === row.session_key &&
            r.category === row.category &&
            r.status === "draft",
        )
      )
        throw new Error("duplicate key value violates unique constraint");
      rows.push({
        status: "draft",
        stage: "details",
        details: [],
        last_inbound_id: null,
        last_reply: null,
        created_at: stamp(),
        updated_at: stamp(),
        ...row,
      } as Row);
    },
    update: async (reference, session, patch) => {
      const row = rows.find((r) => r.reference === reference && r.session_key === session);
      if (!row) throw new Error("missing");
      Object.assign(row, patch, patch.updated_at ? { updated_at: stamp() } : {});
    },
  };
}
