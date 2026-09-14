import { beforeEach, expect, it, vi } from "vitest";
const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc } }));
vi.mock("@/lib/wa-session.server", () => ({ waSessionKey: () => "wa:test" }));
import {
  contactPreference,
  assertContactAllowed,
  setContactPreference,
} from "@/lib/wa-contact-preferences.server";
import { sendStaffText, sendText } from "@/lib/wa-client.server";
beforeEach(() => {
  rpc.mockReset();
});
it("recognizes explicit STOP and explicit resubscription", () => {
  expect(contactPreference("Stop messaging me")).toBe(true);
  expect(contactPreference("resume messages")).toBe(false);
  expect(contactPreference("Hi")).toBeNull();
});
it("persists consent before success", async () => {
  rpc.mockResolvedValue({ error: null });
  await setContactPreference("wa:test", true);
  expect(rpc).toHaveBeenCalledWith("wa_set_contact_opt_out", {
    p_session_key: "wa:test",
    p_opted_out: true,
  });
  rpc.mockResolvedValue({ error: new Error("offline") });
  await expect(setContactPreference("wa:test", true)).rejects.toThrow("offline");
});
it("blocks bot and staff messages for opted-out contacts before contacting Meta", async () => {
  rpc.mockResolvedValue({ data: true, error: null });
  await expect(sendText("15550000000", "test")).rejects.toThrow("opted out");
  await expect(sendStaffText("15550000000", "test")).rejects.toThrow("opted out");
});
it("fails closed on database error and allows a verified non-opted-out contact", async () => {
  rpc.mockResolvedValue({ error: new Error("offline") });
  await expect(assertContactAllowed("15550000000")).rejects.toThrow("unavailable");
  rpc.mockResolvedValue({ error: null, data: false });
  await expect(assertContactAllowed("15550000000")).resolves.toBeUndefined();
});
