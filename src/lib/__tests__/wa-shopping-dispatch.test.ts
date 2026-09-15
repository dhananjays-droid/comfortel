import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  shopping: vi.fn(),
  runtime: vi.fn(),
  request: vi.fn(),
  document: vi.fn(),
  draft: vi.fn(),
  send: vi.fn(),
  staff: vi.fn(),
}));
vi.mock("@/lib/wa-session-store.server", () => ({
  loadSession: mocks.load,
  saveSession: mocks.save,
}));
vi.mock("@/lib/wa-shopping.server", () => ({ handleShoppingInbound: mocks.shopping }));
vi.mock("@/lib/wa-runtime", () => ({ handleInboundMessage: mocks.runtime }));
vi.mock("@/lib/wa-requests.server", () => ({
  handleRequestInbound: mocks.request,
  hasActiveRequestDraft: mocks.draft,
}));
vi.mock("@/lib/wa-documents.server", () => ({ handleDocumentInbound: mocks.document }));
vi.mock("@/lib/managed-catalog.server", () => ({
  withManagedCatalog: (run: () => unknown) => run(),
}));
vi.mock("@/lib/wa-staff.server", () => ({
  staffHandling: mocks.staff,
  touchStaffRequest: vi.fn(),
}));
vi.mock("@/lib/wa-contact-preferences.server", () => ({
  contactPreference: () => null,
  setContactPreference: vi.fn(),
}));
vi.mock("@/lib/wa-client.server", () => ({ sendText: mocks.send, sendButtons: mocks.send }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: null, error: null }),
        insert: async () => ({ error: null }),
      };
      return q;
    },
  },
}));
import { processQueuedInbound } from "@/lib/wa-webhook.server";
import { EMPTY_SESSION } from "@/lib/wa-session";
const input = {
  sessionKey: "synthetic",
  phone: "15550000000",
  waMessageId: "synthetic-message",
  event: { kind: "text" as const, text: "I want five chairs" },
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("WA_SHOPPING_AGENT_ENABLED", "true");
  mocks.load.mockResolvedValue(structuredClone(EMPTY_SESSION));
  mocks.save.mockResolvedValue(undefined);
  mocks.staff.mockResolvedValue(false);
  mocks.draft.mockResolvedValue(false);
  mocks.document.mockResolvedValue(null);
  mocks.request.mockResolvedValue(null);
  mocks.shopping.mockResolvedValue([{ kind: "text", text: "Which model?" }]);
  mocks.runtime.mockImplementation(async (session) => ({
    session,
    turns: [{ kind: "text", text: "Legacy reply" }],
  }));
  mocks.send.mockResolvedValue("synthetic-outbound");
});
afterEach(() => vi.unstubAllEnvs());
it("keeps production behavior unchanged when disabled", async () => {
  vi.stubEnv("WA_SHOPPING_AGENT_ENABLED", "false");
  await processQueuedInbound(input);
  expect(mocks.shopping).not.toHaveBeenCalled();
  expect(mocks.runtime).toHaveBeenCalledOnce();
});
it("saves a handled conversation before sending and skips competing handlers", async () => {
  await processQueuedInbound(input);
  expect(mocks.shopping).toHaveBeenCalledOnce();
  expect(mocks.runtime).not.toHaveBeenCalled();
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.save.mock.calls[0]?.[2]).toBe(true);
  expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.send.mock.invocationCallOrder[0]!,
  );
  expect(mocks.save.mock.calls[0]?.[1].transcript).toHaveLength(2);
});
it("lets the original handler continue when the agent delegates", async () => {
  mocks.shopping.mockResolvedValue(null);
  await processQueuedInbound(input);
  expect(mocks.runtime).toHaveBeenCalledOnce();
});
it("does not intercept an active staff request draft", async () => {
  mocks.draft.mockResolvedValue(true);
  await processQueuedInbound(input);
  expect(mocks.shopping).not.toHaveBeenCalled();
  expect(mocks.request).toHaveBeenCalledOnce();
});
it("does not reply over staff takeover", async () => {
  mocks.staff.mockResolvedValue(true);
  await processQueuedInbound(input);
  expect(mocks.shopping).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});
it("does not send success when persistence fails", async () => {
  mocks.save.mockRejectedValue(new Error("save failed"));
  await processQueuedInbound(input);
  expect(mocks.send).toHaveBeenCalledOnce();
  expect(mocks.send.mock.calls[0]?.[1]).not.toBe("Which model?");
});
