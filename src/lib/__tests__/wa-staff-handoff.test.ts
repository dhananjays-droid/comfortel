import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  manual: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
  runtime: vi.fn(),
  request: vi.fn(),
  documents: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@/lib/wa-staff.server", () => ({
  staffHandling: mock.manual,
  touchStaffRequest: vi.fn(async () => {}),
}));
vi.mock("@/lib/wa-session-store.server", () => ({
  loadSession: mock.load,
  saveSession: mock.save,
}));
vi.mock("@/lib/wa-runtime", () => ({ handleInboundMessage: mock.runtime }));
vi.mock("@/lib/wa-requests.server", () => ({ handleRequestInbound: mock.request }));
vi.mock("@/lib/wa-documents.server", () => ({ handleDocumentInbound: mock.documents }));
vi.mock("@/lib/wa-client.server", () => ({ sendText: mock.send }));
import { processQueuedInbound } from "@/lib/wa-webhook.server";
import { EMPTY_SESSION } from "@/lib/wa-session";
beforeEach(() => {
  vi.clearAllMocks();
  mock.manual.mockReset();
  mock.manual.mockResolvedValue(false);
  mock.load.mockResolvedValue(structuredClone(EMPTY_SESSION));
  mock.request.mockResolvedValue(null);
  mock.documents.mockResolvedValue(null);
  mock.runtime.mockResolvedValue({ session: structuredClone(EMPTY_SESSION), turns: [] });
});
const input = {
  sessionKey: "wa:test",
  phone: "15550000000",
  waMessageId: "inbound-test",
  event: { kind: "text" as const, text: "Hello" },
};
describe("staff takeover preserves the customer flow", () => {
  it("does not run the bot or mutate plans while staff is handling", async () => {
    mock.manual.mockResolvedValue(true);
    await processQueuedInbound(input);
    expect(mock.load).not.toHaveBeenCalled();
    expect(mock.runtime).not.toHaveBeenCalled();
    expect(mock.save).not.toHaveBeenCalled();
    expect(mock.send).not.toHaveBeenCalled();
  });
  it("keeps automatic conversations on the existing route", async () => {
    await processQueuedInbound(input);
    expect(mock.runtime).toHaveBeenCalledOnce();
    expect(mock.save).toHaveBeenCalledOnce();
  });
  it("rechecks takeover before delivering an already-running bot reply", async () => {
    mock.manual.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mock.runtime.mockResolvedValueOnce({
      session: structuredClone(EMPTY_SESSION),
      turns: [{ kind: "text", text: "bot reply" }],
    });
    await processQueuedInbound(input);
    expect(mock.send).not.toHaveBeenCalled();
  });
  it("retries instead of dispatching the bot when control cannot be checked", async () => {
    mock.manual.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(processQueuedInbound(input)).rejects.toThrow("database unavailable");
    expect(mock.runtime).not.toHaveBeenCalled();
  });
});
