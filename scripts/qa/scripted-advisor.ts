/**
 * A scripted stand-in for the advisor model, for running the journey suite
 * without a provider call.
 *
 * It emits the tool sequences Sonnet 5 produced on the live gate: plan_salon
 * for an explicit plan request; find_products then a typed finish for
 * shopping, shortlist and comparison turns; a plain answer for policy detours;
 * request_details/request_resume for staff requests; render for a photo ask.
 *
 * What this proves is the APPLICATION contract under the compact server
 * context and the eight-result search cap — that every family's state
 * assertions hold when a competent model makes the expected decisions. It
 * says nothing about the real model's judgment; that remains the live gate.
 */
import type { ShoppingModel } from "@/lib/wa-shopping.server";

type Ctx = {
  project?: { stations?: number | null; budget?: number | null };
  selection?: Array<{ id: string; name: string }>;
  quantities?: Record<string, number>;
  displayed?: Array<{ id: string; name: string }>;
  workflow?: { request?: { status?: string } | null };
};
type Product = { id: string; name: string; specs?: Record<string, unknown> };

let serial = 0;
const call = (name: string, input: unknown) => [
  { type: "tool_use", id: `scripted-${++serial}`, name, input },
];
const finish = (input: Record<string, unknown>) => call("finish", { text: "…", ...input });

/** Tool results already returned this turn, oldest first. */
function results(messages: Array<{ role: string; content: unknown }>): unknown[] {
  const out: unknown[] = [];
  for (const m of messages)
    if (Array.isArray(m.content))
      for (const b of m.content as Array<{ type?: string; content?: string }>)
        if (b.type === "tool_result" && typeof b.content === "string") {
          try {
            out.push(JSON.parse(b.content));
          } catch {
            out.push(b.content);
          }
        }
  return out;
}

function lastText(messages: Array<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

const byName = (list: Product[], re: RegExp) => list.find((p) => re.test(p.name));

export const scriptedAdvisor: ShoppingModel = async (messages, context) => {
  const ctx = JSON.parse(context) as Ctx;
  const text = lastText(messages);
  const got = results(messages);
  const selection = ctx.selection ?? [];
  const qty = ctx.quantities ?? {};
  let m: RegExpMatchArray | null;

  // --- planning ---
  if ((m = text.match(/salon plan for (\d+) stations with a budget of (\d+) USD/i)))
    return call("plan_salon", {
      stations: Number(m[1]),
      budget: Number(m[2]),
      currency: "USD",
      scope: "equipment",
      business: "salon",
    });
  if ((m = text.match(/Change ONLY the styling chair quantity to (\d+)/i))) {
    const chair = selection.find((p) => /chair/i.test(p.name));
    if (!chair) return finish({ action: "answer", text: "Which chair do you mean?" });
    return finish({
      action: "select",
      text: "Updated the styling chair quantity; everything else is unchanged.",
      lines: selection.map((p) => ({ id: p.id, qty: p.id === chair.id ? Number(m![1]) : qty[p.id] ?? 1 })),
    });
  }

  // --- policy detours: answer only, never touch state ---
  if (/warranty|returns? policy/i.test(text))
    return finish({
      action: "answer",
      text: /warranty/i.test(text)
        ? "US products carry a limited warranty; our team confirms coverage for a specific item. Want to pick your plan back up?"
        : "Contact our team before returning anything so they can confirm the window and any fees. Shall we continue?",
    });

  // --- shopping ---
  if ((m = text.match(/^I want (\d+)$/i)))
    return finish({
      action: "answer",
      text: `Happy to help — which product would you like ${m[1]} of?`,
      memory: { quantity: Number(m[1]) },
    });
  if ((m = text.match(/Select (\d+) Chloe Tan styling chairs/i))) {
    if (!got.length) return call("find_products", { query: "Chloe Tan styling chair" });
    const hit = byName(got[0] as Product[], /Chloe Tan/i);
    return hit
      ? finish({ action: "select", text: "Added to your draft.", lines: [{ id: hit.id, qty: Number(m[1]) }] })
      : finish({ action: "answer", text: "I couldn't find a Chloe Tan chair — which finish did you mean?" });
  }
  if ((m = text.match(/Actually (\d+) instead, same chair/i)) && selection[0])
    return finish({
      action: "select",
      text: "Quantity updated.",
      lines: [{ id: selection[0].id, qty: Number(m[1]) }],
    });
  if (/PDF estimate for my saved selection/i.test(text))
    return finish({ action: "quote", text: "Here is your estimate." });

  // --- comparison / shortlist ---
  if ((m = text.match(/Show me (\d+) salon mirrors.*?Budget is (\d+) USD per mirror/i))) {
    if (!got.length) return call("find_products", { query: "salon mirror", max_price: Number(m[2]) });
    const list = (got[0] as Product[]).slice(0, 3);
    return list.length
      ? finish({
          action: "show",
          text: "Here are mirror options that fit your budget, with the trade-offs.",
          lines: list.map((p) => ({ id: p.id, qty: 1 })),
        })
      : finish({ action: "answer", text: "Nothing in the catalogue fits that budget." });
  }
  if (/Compare Chloe Tan and Blake Textured Black/i.test(text)) {
    if (got.length === 0) return call("find_products", { query: "Chloe Tan styling chair" });
    if (got.length === 1) return call("find_products", { query: "Blake Textured Black styling chair" });
    const chloe = byName(got[0] as Product[], /Chloe Tan/i);
    const blake = byName(got[1] as Product[], /Blake/i);
    return chloe && blake
      ? finish({
          action: "compare",
          text: "Comparison attached.",
          lines: [{ id: chloe.id, qty: 1 }, { id: blake.id, qty: 1 }],
        })
      : finish({ action: "answer", text: "I could only find one of those chairs — which finish?" });
  }
  if (/confirmed weight capacity/i.test(text)) {
    if (!got.length) return call("find_products", { query: "Chloe Tan Blake styling chair" });
    const list = got[0] as Product[];
    const has = list.filter((p) => JSON.stringify(p.specs ?? {}).match(/weight|capacity|load/i));
    return finish({
      action: "answer",
      text: has.length
        ? `A weight capacity is listed for ${has.map((p) => p.name).join(" and ")}; the other isn't stated in our specifications.`
        : "Neither product's specification lists a confirmed weight capacity, so I won't guess — our team can confirm.",
    });
  }

  // --- render ---
  if (/in my salon photo/i.test(text))
    return finish({
      action: "render",
      renderMode: "refit_room",
      text: "I'll prepare an image proposal for you to confirm.",
    });

  // --- staff requests ---
  if (/Continue my saved support request/i.test(text))
    return finish({ action: "request_resume", text: "Resuming your request." });
  if (ctx.workflow?.request?.status === "draft")
    return finish({
      action: "request_details",
      readyToReview: /order|issue|leak|broken|call|visit/i.test(text),
      text: "Noted for the team.",
    });

  return finish({ action: "answer", text: "Could you tell me a little more about what you need?" });
};
