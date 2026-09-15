import { afterEach, describe, expect, it, vi } from "vitest";
import { callShoppingModel, isSimplePolicyQuestion } from "@/lib/wa-shopping.server";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const question = [{ role: "user" as const, content: "What is your warranty policy?" }];
const response = (input: unknown) =>
  new Response(
    JSON.stringify({
      content: [{ type: "tool_use", name: "finish", id: "test", input }],
      usage: { input_tokens: 100, output_tokens: 20 },
    }),
  );

describe("advisor cost routing", () => {
  it("limits Haiku to standalone policy questions", () => {
    expect(isSimplePolicyQuestion(question, "{}")).toBe(true);
    for (const text of [
      "What is your warranty policy? Also replace my chair",
      "What about that one?",
      "Plan 3 stations",
      "Cancel my order",
      "yes",
    ])
      expect(isSimplePolicyQuestion([{ role: "user", content: text }], "{}")).toBe(false);
    expect(
      isSimplePolicyQuestion(
        question,
        JSON.stringify({ workflow: { request: { status: "draft" } } }),
      ),
    ).toBe(false);
    expect(
      isSimplePolicyQuestion(
        question,
        JSON.stringify({ workflow: { quotedMessage: "old reply" } }),
      ),
    ).toBe(false);
  });
  it("caches a stable prefix, keeps customer state outside it and uses Haiku once", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic");
    const fetch = vi
      .fn()
      .mockImplementation(async () =>
        response({ action: "answer", text: "Coverage depends on the product and conditions." }),
      );
    vi.stubGlobal("fetch", fetch);
    await callShoppingModel(question, '{"customer":"synthetic-A"}');
    await callShoppingModel(question, '{"customer":"synthetic-B"}');
    const bodies = fetch.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(bodies[0].model).toBe("claude-haiku-4-5-20251001");
    expect(bodies[0].system[0]).toEqual(bodies[1].system[0]);
    expect(bodies[0].system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(bodies[0].system[0].text).not.toContain("synthetic-A");
    expect(bodies[0].system[1].cache_control).toBeUndefined();
    expect(bodies[0].system[1].text).toContain("synthetic-A");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects Haiku mutations and escalates once without executing them", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic");
    vi.stubEnv("WA_ADVISOR_MODEL", "claude-sonnet-4-6");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ action: "render", text: "Generate" }))
      .mockResolvedValueOnce(response({ action: "answer", text: "Policy answer" }));
    vi.stubGlobal("fetch", fetch);
    const blocks = await callShoppingModel(question, "{}");
    expect(blocks[0]?.input).toEqual({ action: "answer", text: "Policy answer" });
    expect(fetch.mock.calls.map((c) => JSON.parse(c[1].body).model)).toEqual([
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-6",
    ]);
  });
  it("sends complex turns straight to Sonnet without a paid classification call", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic");
    vi.stubEnv("WA_ADVISOR_MODEL", "claude-sonnet-4-6");
    const fetch = vi
      .fn()
      .mockResolvedValue(response({ action: "answer", text: "Which currency?" }));
    vi.stubGlobal("fetch", fetch);
    await callShoppingModel([{ role: "user", content: "Plan 3 stations for 20k" }], "{}");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0]![1].body).model).toBe("claude-sonnet-4-6");
  });
});
