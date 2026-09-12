import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ chat: vi.fn(), enqueue: vi.fn(), active: vi.fn(), claim: vi.fn() }));
vi.mock("@/lib/chat.functions", () => ({ parseChatInput: (x: unknown) => x, runChatTurn: m.chat }));
vi.mock("@/lib/wa-render-jobs.server", () => ({
  getActiveRenderState: m.active,
  enqueueRenderJob: m.enqueue,
  cancelActiveRenderJobs: vi.fn(async () => 0),
}));
vi.mock("@/lib/wa-rate-limit.server", () => ({ tooManyRenderRequests: vi.fn(async () => false) }));
vi.mock("@/lib/wa-render-guards.server", () => ({ claimRenderAction: m.claim }));
import { handleInboundMessage } from "@/lib/wa-runtime";
import { EMPTY_SESSION, liveRoom, sanitizeSession, type SessionState } from "@/lib/wa-session";
import { CATALOG_FULL } from "@/lib/catalog";
import { groupByZone } from "@/lib/zones";
const id = Object.keys(CATALOG_FULL)[0]!;
const room = { url: "https://example.com/salon.jpg", at: Date.now() - 73 * 60000 };
const fresh = (): SessionState => ({
  ...EMPTY_SESSION,
  room,
  transcript: [{ role: "user", content: "Show me a chair" }],
});
const text = (s: SessionState, t: string) =>
  handleInboundMessage(s, "wa:test", "15551234567", { kind: "text", text: t });
const tap = (s: SessionState, id: string) =>
  handleInboundMessage(s, "wa:test", "15551234567", { kind: "button", id });
const words = (r: Awaited<ReturnType<typeof text>>) =>
  r.turns.map((t) => ("text" in t ? t.text : "")).join("\n");
const confirm = (s: SessionState) => tap(s, `render:confirm:${s.pendingRender!.id}`);
beforeEach(() => {
  vi.clearAllMocks();
  m.active.mockResolvedValue({ count: 0, pending: 0, generating: 0, oldestCreatedAt: null });
  m.enqueue.mockResolvedValue(true);
  const claims = new Set<string>();
  m.claim.mockImplementation(async (id: string) => {
    if (claims.has(id)) return false;
    claims.add(id);
    return true;
  });
  m.chat.mockResolvedValue({
    text: "I'm rendering it now, ready in a minute.",
    productIds: [id],
    render: null,
    offer: { mode: "refit_room", productIds: [id], quantities: { [id]: 2 } },
  });
});
describe("WhatsApp explicit render confirmation", () => {
  it("zone-by-zone requests require one confirmation before any images are queued", async () => {
    const groups = groupByZone(Object.values(CATALOG_FULL));
    const ids = groups.map((g) => g.products[0]!.id);
    const s = { ...fresh(), plan: { ids, qty: Object.fromEntries(ids.map((id) => [id, 2])) } };
    const r = await text(s, "render my salon zone by zone");
    expect(r.session.pendingRender?.mode).toBe("zones");
    expect(m.enqueue).not.toHaveBeenCalled();
    await confirm(r.session);
    expect(m.enqueue).toHaveBeenCalledTimes(ids.length);
    for (const call of m.enqueue.mock.calls)
      expect(call[2]).toMatchObject({ mode: "refit_room", roomUrl: room.url });
  });
  it("plain yes never starts generation; it repeats the start button", async () => {
    const r = await text(fresh(), "render it");
    const yes = await text(r.session, "yes");
    expect(yes.session.pendingRender?.id).toBe(r.session.pendingRender?.id);
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(words(yes)).toContain("Tap Start generation");
  });
  it("new instructions invalidate an old start button even without a replacement marker", async () => {
    const r = await text(fresh(), "render it");
    m.chat.mockResolvedValue({
      text: "Which chair colour?",
      productIds: [],
      render: null,
      offer: null,
    });
    const changed = await text(r.session, "Actually change the chair colour");
    expect(changed.session.pendingRender).toBeNull();
    await tap(changed.session, `render:confirm:${r.session.pendingRender!.id}`);
    expect(m.enqueue).not.toHaveBeenCalled();
  });
  it("a database claim failure never submits a job", async () => {
    const r = await text(fresh(), "render it");
    m.claim.mockRejectedValue(new Error("database down"));
    expect(words(await confirm(r.session))).toContain("couldn’t accept");
    expect(m.enqueue).not.toHaveBeenCalled();
  });
  it("an active job prevents a new proposal or second job", async () => {
    m.active.mockResolvedValue({ count: 1, pending: 1, generating: 0 });
    expect(words(await text(fresh(), "render it"))).toContain("already in progress");
    expect(m.enqueue).not.toHaveBeenCalled();
  });
  it("long confirmations preserve full details and all WhatsApp body limits", async () => {
    const note = "Please keep the walls unchanged. ".repeat(24);
    m.chat.mockResolvedValue({
      text: "Rendering",
      productIds: [id],
      render: { mode: "refit_room", productIds: [id], note },
      offer: null,
    });
    const r = await text(fresh(), "render it");
    expect(r.session.transcript.at(-1)?.content).toContain(note);
    expect(r.turns.at(-1)?.kind).toBe("buttons");
    for (const t of r.turns) if ("text" in t) expect(t.text.length).toBeLessThanOrEqual(1024);
    expect(m.enqueue).not.toHaveBeenCalled();
  });
  it("the exact screenshot request produces a confirmation, not a false start", async () => {
    const r = await text(fresh(), "Show me on the photo i shared");
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(words(r)).toContain("Nothing is generating yet");
    expect(words(r)).toContain("saved salon photo");
    expect(words(r)).not.toMatch(/rendering it now|ready in a minute/);
    expect(r.session.transcript.at(-1)?.content).toContain("Nothing is generating yet");
    expect(r.session.pendingRender?.room?.url).toBe(room.url);
    const stored = sanitizeSession(JSON.parse(JSON.stringify(r.session)));
    const sent = await confirm(stored);
    expect(m.enqueue).toHaveBeenCalledExactlyOnceWith(
      "wa:test",
      "15551234567",
      expect.objectContaining({ roomUrl: room.url, mode: "refit_room", quantities: { [id]: 2 } }),
    );
    expect(words(sent)).toContain("queued");
    expect(sent.session.pendingRender).toBeNull();
  });
  it("even an immediate model render marker must wait for a tap", async () => {
    m.chat.mockResolvedValue({
      text: "Generating now",
      productIds: [id],
      render: { mode: "refit_room", productIds: [id] },
      offer: null,
    });
    expect(words(await text(fresh(), "render it"))).toContain("Nothing is generating yet");
    expect(m.enqueue).not.toHaveBeenCalled();
  });
  it("does not use model text to answer ? while awaiting confirmation", async () => {
    const r = await text(fresh(), "Show me on the photo i shared");
    m.chat.mockClear();
    expect(words(await text(r.session, "?"))).toContain("Nothing is generating yet");
    expect(m.chat).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });
  it("checks the queue for a historic false promise instead of repeating it", async () => {
    const s = {
      ...fresh(),
      transcript: [{ role: "assistant" as const, content: "I'm rendering now" }],
    };
    expect(words(await text(s, "?"))).toContain("No new image is being generated");
    expect(m.chat).not.toHaveBeenCalled();
  });
  it("reports genuine queue progress with elapsed time, never a minute promise", async () => {
    m.active.mockResolvedValue({
      count: 1,
      pending: 0,
      generating: 1,
      oldestCreatedAt: new Date(Date.now() - 73 * 60000).toISOString(),
    });
    const r = await text(
      {
        ...fresh(),
        lastRender: {
          resultUrl: room.url,
          at: room.at,
          mode: "refit_room",
          productIds: [id],
          quantities: {},
        },
      },
      "where is my image?",
    );
    expect(words(r)).toContain("73 minutes");
    expect(words(r)).toContain("longer than expected");
    expect(m.chat).not.toHaveBeenCalled();
  });
  it("fails closed when the job lookup fails", async () => {
    m.active.mockResolvedValue({ count: 0, unavailable: true });
    expect(words(await text(fresh(), "render status"))).toContain("can’t check");
    expect(words(await tap(fresh(), `offer:auto:${id}`))).toContain("can’t check");
    expect(m.enqueue).not.toHaveBeenCalled();
  });
  it("never claims a start when the confirmed enqueue fails", async () => {
    const r = await text(fresh(), "render it");
    m.enqueue.mockResolvedValue(false);
    const sent = await confirm(r.session);
    expect(words(sent)).toContain("went wrong starting");
    expect(words(sent)).not.toContain("queued");
  });
  it("rejects expired, stale and other-session confirmation buttons", async () => {
    const r = await text(fresh(), "render it");
    const button = `render:confirm:${r.session.pendingRender!.id}`;
    expect(words(await tap(fresh(), button))).toContain("no longer current");
    const stale = {
      ...r.session,
      pendingRender: { ...r.session.pendingRender!, at: Date.now() - 31 * 60000 },
    };
    expect(words(await tap(stale, button))).toContain("no longer current");
    const newer = await text(r.session, "change the image");
    const oldTap = await tap(newer.session, button);
    expect(words(oldTap)).toContain("no longer current");
    expect(oldTap.session.pendingRender?.id).toBe(newer.session.pendingRender?.id);
    expect(m.enqueue).not.toHaveBeenCalled();
    await confirm(oldTap.session);
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });
  it("durable claims prevent two start taps from a stale session snapshot", async () => {
    const r = await text(fresh(), "render it");
    await Promise.all([confirm(r.session), confirm(r.session)]);
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });
  it("cancel invalidates a confirmation", async () => {
    const r = await text(fresh(), "render it");
    const cancelled = await tap(r.session, "render:cancel");
    await tap(cancelled.session, `render:confirm:${r.session.pendingRender!.id}`);
    expect(m.enqueue).not.toHaveBeenCalled();
  });
  it("Not now dismisses only the matching unstarted proposal", async () => {
    const r = await text(fresh(), "render it");
    const proposalId = r.session.pendingRender!.id;
    const dismissed = await tap(r.session, `render:dismiss:${proposalId}`);
    expect(words(dismissed)).toContain("haven’t started the image");
    expect(dismissed.session.pendingRender).toBeNull();
    expect(m.enqueue).not.toHaveBeenCalled();

    const newer = await text(fresh(), "render it");
    const staleDismiss = await tap(newer.session, `render:dismiss:${proposalId}`);
    expect(staleDismiss.session.pendingRender?.id).toBe(newer.session.pendingRender?.id);
    expect(words(staleDismiss)).toContain("no longer current");
  });
  it("new photo invalidates the old proposal", async () => {
    const r = await text(fresh(), "render it");
    const updated = await handleInboundMessage(r.session, "wa:test", "15551234567", {
      kind: "photo",
      url: "https://example.com/new.jpg",
    });
    await tap(updated.session, `render:confirm:${r.session.pendingRender!.id}`);
    expect(m.enqueue).not.toHaveBeenCalled();
  });
  it("generic product preview uses the saved photo instead of an example room", async () => {
    const r = await tap(fresh(), `offer:auto:${id}`);
    expect(r.session.pendingRender?.mode).toBe("refit_room");
    expect(words(r)).toContain("saved salon photo");
  });
  it("explicitly labels an example room when no photo is available", async () => {
    const r = await tap({ ...fresh(), room: null }, `offer:auto:${id}`);
    expect(words(r)).toContain("example salon (not your uploaded photo)");
    expect(m.enqueue).not.toHaveBeenCalled();
  });
  it("does not silently stage a room when the user asks for their photo", async () => {
    m.chat.mockResolvedValue({
      text: "I'm rendering",
      productIds: [id],
      offer: { mode: "staged_room", productIds: [id] },
      render: null,
    });
    const r = await text(fresh(), "Show me on the photo i shared");
    expect(r.session.pendingRender?.mode).toBe("refit_room");
    const absent = await text({ ...fresh(), room: null }, "Show me on the photo i shared");
    expect(words(absent)).toContain("upload it again");
    expect(absent.session.pendingRender).toBeFalsy();
  });
  it("rejects a photo that expires between proposal and confirmation", async () => {
    const r = await text(fresh(), "render it");
    r.session.pendingRender!.room!.at = Date.now() - 25 * 60 * 60000;
    expect(words(await confirm(r.session))).toContain("expired");
    expect(m.enqueue).not.toHaveBeenCalled();
  });
  it("edits also require confirmation and retain the precise instruction", async () => {
    const note = "Change both black chairs to white";
    m.chat.mockResolvedValue({
      text: "Updating it now",
      productIds: [],
      render: { mode: "edit", productIds: [], note },
      offer: null,
    });
    const r = await text(
      {
        ...fresh(),
        lastRender: {
          resultUrl: room.url,
          at: Date.now(),
          mode: "refit_room",
          productIds: [id],
          quantities: {},
        },
      },
      note,
    );
    expect(words(r)).toContain(note);
    expect(m.enqueue).not.toHaveBeenCalled();
    await confirm(r.session);
    expect(m.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ mode: "edit", note, roomUrl: room.url }),
    );
  });
  it("durable photos remain live after 73 minutes, but not after 24 hours", () => {
    expect(liveRoom(room)).not.toBeNull();
    expect(liveRoom({ ...room, at: Date.now() - 25 * 60 * 60000 })).toBeNull();
  });
});
