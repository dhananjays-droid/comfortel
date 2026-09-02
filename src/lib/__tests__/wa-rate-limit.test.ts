import { describe, expect, it } from "vitest";

import { tooManyInboundMessages, tooManyRenderRequests } from "@/lib/wa-rate-limit.server";

/**
 * No SUPABASE_SERVICE_ROLE_KEY in this test environment (see
 * wa-render-worker.test.ts's header comment for why), so every count query
 * here fails at client construction — which is exactly the fail-open path
 * that matters most to verify: a rate limiter that blocks everyone during a
 * database outage is worse than one that temporarily stops limiting anyone.
 * The actual over-the-threshold behavior needs a real database and is
 * verified manually against Meta's test number instead, matching this
 * repo's stance on visualize.functions.ts/kie.server.ts (see
 * wa-render-worker.test.ts).
 */
describe("tooManyInboundMessages", () => {
  it("fails open (never rate-limits) when the count query can't run", async () => {
    await expect(tooManyInboundMessages("wa:test-session")).resolves.toBe(false);
  });
});

describe("tooManyRenderRequests", () => {
  it("fails open (never rate-limits) when the count query can't run", async () => {
    await expect(tooManyRenderRequests("wa:test-session")).resolves.toBe(false);
  });
});
