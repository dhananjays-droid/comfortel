import { createServerFn } from "@tanstack/react-start";

import { FAULTS, FAULT_KINDS, readVerdict, type Verdict } from "@/lib/render-qa";

/**
 * The vision pass over a finished render.
 *
 * Haiku 4.5 has vision and this runs on every render, so the tier matters here in
 * a way it does not for package curation: this is per-image, not per-session. The
 * job is also narrow — "is anything obviously broken" against a fixed list — which
 * is the shape Haiku handles well.
 *
 * A failure to inspect is never a failure to deliver. Every error path returns
 * "ok", because showing the customer a render we could not check beats showing
 * them nothing.
 */

const MODEL = "claude-haiku-4-5-20251001";

/**
 * Written to suppress false positives, which cost more than false negatives.
 *
 * A missed fault shows one imperfect image. A phantom fault burns a $0.03 render
 * and another 90 seconds of waiting to produce something no better. So the
 * instruction is biased towards passing: only call it broken when it is
 * unmistakable at a glance.
 */
const SYSTEM = `You are checking an AI-generated interior render of a salon for obvious physical mistakes before it is shown to a customer.

Look only for these faults:
${FAULT_KINDS.map((k) => `- ${k}: ${FAULTS[k]}`).join("\n")}

How to judge:
- Report a fault only if it is unmistakable at a glance — the kind of thing a customer would point at immediately.
- Soft judgements are not faults. Styling, colour choice, whether the furniture suits the room, lighting mood, image sharpness, minor imperfection: all fine, report nothing.
- Partial occlusion is normal and is NOT "intersecting": furniture legitimately passes behind other furniture, and pieces at the frame edge are legitimately cut off by it. Only report intersecting when a piece is clearly embedded IN a solid surface, as though the surface were not there.
- If you are unsure, it is not a fault.

Return your answer with the record_check tool. An empty fault list means the render is fine, which is the normal answer.`;

const TOOL = {
  name: "record_check",
  description: "Record whether the render has an obvious physical fault.",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      faults: {
        type: "array",
        description: "Unmistakable faults only. Empty when the render is acceptable.",
        items: { type: "string", enum: FAULT_KINDS },
      },
      note: {
        type: "string",
        description:
          "Where the worst fault is, in a few words, e.g. 'chair second from left is inside the timber panel'. Empty when there are no faults.",
      },
    },
    required: ["faults", "note"],
    additionalProperties: false,
  },
};

const PASS: Verdict = { ok: true, faults: [] };

export const inspectRender = createServerFn({ method: "POST" })
  .validator((input: { imageUrl: string }) => {
    const url = String(input?.imageUrl ?? "");
    // Only ever fetch renders from where our generator puts them.
    const allowed = /^https:\/\/[\w.-]*(aiquickdraw\.com|redpandaai\.co)\//i.test(url);
    if (!allowed) throw new Error("unexpected render host");
    return { imageUrl: url };
  })
  .handler(async ({ data }): Promise<Verdict> => {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) return PASS;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 512,
          system: SYSTEM,
          tool_choice: { type: "tool", name: TOOL.name },
          tools: [TOOL],
          messages: [
            {
              role: "user",
              content: [
                // A URL source keeps the image off our server entirely; kie's
                // CDN is already public for the lifetime of the render.
                { type: "image", source: { type: "url", url: data.imageUrl } },
                { type: "text", text: "Check this render." },
              ],
            },
          ],
        }),
      });

      if (!res.ok) {
        console.error("inspect: anthropic error", res.status, await res.text());
        return PASS;
      }

      const json = (await res.json()) as {
        content?: Array<{ type: string; name?: string; input?: unknown }>;
      };
      const call = json.content?.find((b) => b.type === "tool_use" && b.name === TOOL.name);
      const verdict = readVerdict(call?.input);
      if (!verdict.ok) {
        console.warn(`inspect: ${verdict.faults.join(", ")} — ${verdict.note ?? "no detail"}`);
      }
      return verdict;
    } catch (err) {
      console.error("inspect: failed", err);
      return PASS;
    }
  });
