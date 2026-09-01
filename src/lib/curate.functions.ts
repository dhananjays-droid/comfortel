import { createServerFn } from "@tanstack/react-start";

import { buildPackages, needsFor, type Package, type Role, type Tier } from "@/lib/packages";
import { adopt, fitToBand, reasonsFor, sampleCandidates, type ProposedPackage } from "@/lib/curate";

/**
 * Curating packages with a model, with the deterministic packer as the floor.
 *
 * Sonnet rather than Haiku: this reads ~80 candidates across seven roles, holds a
 * budget, keeps a look coherent and honours stated priorities, which is a
 * different order of task from picking four chairs for a chat reply. It runs once
 * or twice a session, not per message, so the tier costs pennies.
 *
 * If anything goes wrong — no key, rate limit, malformed proposal, invented
 * product ids — the caller still gets the deterministic package rather than an
 * error. A worse package beats a broken screen.
 */

const MODEL = "claude-sonnet-5";

/** The band each tier is tuned to, as a multiple of the customer's budget. */
const TIER_TARGET: Record<string, number> = { lean: 0.87, balanced: 1.0, premium: 1.18 };

/** Roles offered to the model, in the order a salon is actually walked through. */
const ROLES: Role[] = ["reception", "waiting", "styling", "mirror", "stool", "trolley", "wash"];

/**
 * The instructions.
 *
 * Written against the failure modes of the code it replaces. The deterministic
 * packer's faults were: no sense of whether pieces belong together, a barber
 * chair dropped into a salon, and a fixed idea of what a fit-out contains
 * regardless of what kind of business it is. Each of those gets an explicit rule.
 *
 * The hard constraint repeated most often is the one that matters most: never
 * write a number. Totals are computed from the catalogue after the fact, so any
 * price the model invented would be silently overwritten — and a rationale that
 * quotes a wrong figure would survive. Hence "never mention prices".
 */
const SYSTEM = `You are a salon fit-out specialist for Comfortel, choosing furniture packages from a fixed catalogue.

You will be given a customer brief, a station count, a budget, and candidate products grouped by role. Propose exactly three packages.

THE THREE PACKAGES
Work to these totals. Multiply each unit price by the quantity you choose and keep a running sum — the budget is the whole point of the exercise, and a package far under it has under-served the customer just as surely as one far over.
- "lean": roughly 80-90% of the budget. A real, complete salon that costs less — not a crippled version. Someone should be able to open with it.
- "balanced": 95-100% of the budget. The closest honest fit.
- "premium": roughly 110-125% of the budget. Above it, but only where the extra genuinely buys something the customer said they care about.
All three must be defensible. Do not make one bad to flatter another.

CHOOSING PIECES
- Style coherence is your main advantage over sorting by price. Many products carry a collection name. Prefer pieces from the same or a complementary collection so the room reads as one decision, and say which thread you followed.
- Match the business. A barbershop is not a salon: do not put a barber chair in a hair salon, or a salon styling chair in a barbershop, unless the brief asks for it.
- Honour stated priorities. If the customer says the chairs matter most, spend there and economise elsewhere — do not spread the budget evenly out of caution.
- Vary quantities to suit the brief. One backwash serves roughly three chairs, and a colour-heavy salon wants more trolleys than a dry-cutting one. These are guides, not rules.
- A role may be left out when the brief makes it irrelevant. Say so if you do.
- Every package needs styling chairs.

HARD RULES
- Use only product ids from the candidate lists given to you. Never invent an id.
- Pick at most one product per role, per package.
- Use the unit prices to hit the totals above, but never WRITE a price, total or dollar figure in your rationale. The real totals are computed from the catalogue after you answer and shown to the customer separately, so any figure you write would be duplicated or contradicted. Describing something as costing less or being a step up is fine; naming a number is not.
- Your rationale is one or two sentences on why these pieces suit this customer and hang together. Write it to the salon owner, plainly. No sales language.`;

const TOOL = {
  name: "propose_packages",
  description: "Propose exactly three furniture packages for the customer's salon.",
  // Without this the model is free to satisfy the schema loosely, and it did:
  // it returned `packages` as a JSON *string* containing another {"packages":[...]}
  // object. strict guarantees the declared shape, and needs the
  // additionalProperties:false + required already present at every level.
  //
  // It also accepts only a subset of JSON Schema — no `minItems` above 1, no
  // `minimum`/`maximum` on numbers. Both were rejected with a 400 before being
  // removed, so bounds live in adopt() instead of the schema.
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      packages: {
        type: "array",
        // No minItems/maxItems here: strict mode rejects minItems above 1
        // ("values other than 0 or 1 are not supported"). "Exactly three" is
        // carried by the system prompt and enforced by the validation below,
        // which already refuses anything short of three tiers.
        items: {
          type: "object",
          properties: {
            tier: { type: "string", enum: ["lean", "balanced", "premium"] },
            lines: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  role: {
                    type: "string",
                    enum: ["styling", "wash", "mirror", "stool", "trolley", "reception", "waiting"],
                  },
                  productId: { type: "string" },
                  // No minimum/maximum: strict mode rejects numeric bounds too.
                  // adopt() range-checks quantity anyway, and rejects the line.
                  qty: { type: "integer" },
                },
                required: ["role", "productId", "qty"],
                additionalProperties: false,
              },
            },
            rationale: {
              type: "string",
              description:
                "One or two sentences on why these pieces suit this customer and work together. No prices.",
            },
          },
          required: ["tier", "lines", "rationale"],
          additionalProperties: false,
        },
      },
    },
    required: ["packages"],
    additionalProperties: false,
  },
};

/**
 * The candidate block. Ids must be verbatim, so they lead each line.
 *
 * Prices are shown. They were omitted at first on the theory that a model which
 * never sees a price cannot misquote one — but a model that cannot see prices
 * cannot hit a budget either, and every tier came back well under. The rule that
 * matters is narrower: it may reason about cost, it must never write a figure.
 */
function candidateBlock(): string {
  return ROLES.map((role) => {
    const rows = sampleCandidates(role)
      .map((c) => `  ${c.id} | $${c.price} | ${c.name}${c.collection ? ` | ${c.collection}` : ""}`)
      .join("\n");
    return `${role}:\n${rows}`;
  }).join("\n\n");
}

/**
 * Pull the package list out of a tool-call input.
 *
 * `strict: true` should make this a plain property read, but the shape observed
 * before it was added — a JSON string holding another `{packages: [...]}` object —
 * is cheap to keep tolerating, and tool input escaping is documented to vary.
 * Belt and braces on the one boundary where the model's output enters our types.
 */
function readPackages(input: unknown): ProposedPackage[] | null {
  const unwrap = (value: unknown): unknown =>
    value && typeof value === "object" && "packages" in value
      ? (value as { packages: unknown }).packages
      : value;

  let current = unwrap(input);
  for (let depth = 0; depth < 3; depth++) {
    if (Array.isArray(current)) return current as ProposedPackage[];
    if (typeof current !== "string") return null;
    try {
      current = unwrap(JSON.parse(current));
    } catch {
      return null;
    }
  }
  return null;
}

export type CuratedResult = {
  packages: Package[];
  /** True when the model's proposal was used; false when it fell back to code. */
  curated: boolean;
};

export const curatePackages = createServerFn({ method: "POST" })
  .validator((input: { brief?: string; stations: number; budget: number }) => {
    const stations = Math.max(1, Math.min(20, Math.round(input?.stations ?? 4)));
    const budget = Math.max(500, Math.round(input?.budget ?? 15000));
    return { brief: (input?.brief ?? "").slice(0, 800), stations, budget };
  })
  .handler(async ({ data }): Promise<CuratedResult> => {
    const fallback = (): CuratedResult => ({
      packages: buildPackages(data.budget, needsFor(data.stations)),
      curated: false,
    });

    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) return fallback();

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
          max_tokens: 8192,
          system: [
            { type: "text", text: SYSTEM },
            // The candidate block is identical between the three tiers and
            // between customers, so it is worth a cache breakpoint. Everything
            // that varies sits after it, in the user turn.
            {
              type: "text",
              text: `CANDIDATE PRODUCTS\nFormat: id | unit price | name | collection\n\n${candidateBlock()}`,
              cache_control: { type: "ephemeral" },
            },
          ],
          // Forced tool use rather than asking for JSON in prose: the schema is
          // validated at the API, so a malformed proposal is retried by the model
          // instead of arriving here as unparseable text.
          tool_choice: { type: "tool", name: TOOL.name },
          tools: [TOOL],
          messages: [
            {
              role: "user",
              content: [
                data.brief
                  ? `Customer brief: ${data.brief}`
                  : "No brief given — assume a general-purpose hair salon.",
                `Styling stations: ${data.stations}`,
                `Budget: ${data.budget} USD (furniture only)`,
                "",
                "Propose the three packages now.",
              ].join("\n"),
            },
          ],
        }),
      });

      if (!res.ok) {
        console.error("curate: anthropic error", res.status, await res.text());
        return fallback();
      }

      const json = (await res.json()) as {
        stop_reason?: string;
        usage?: { output_tokens?: number };
        content?: Array<{ type: string; name?: string; input?: unknown }>;
      };
      if (json.stop_reason && json.stop_reason !== "tool_use") {
        // A truncated tool call arrives as a partial proposal rather than an
        // error, so this is the difference between "the model chose badly" and
        // "the model ran out of room mid-answer".
        console.warn(
          `curate: stop_reason=${json.stop_reason} output_tokens=${json.usage?.output_tokens}`,
        );
      }
      const call = json.content?.find((b) => b.type === "tool_use" && b.name === TOOL.name);
      const proposed = readPackages(call?.input);
      if (!Array.isArray(proposed) || proposed.length === 0) {
        console.warn("curate: no tool call in response", JSON.stringify(json).slice(0, 400));
        return fallback();
      }

      const packages: Package[] = [];
      for (const one of proposed) {
        const { package: adopted, issues } = adopt(one);
        if (issues.length) console.warn("curate: rejected lines", JSON.stringify(issues));
        if (!adopted) {
          console.warn(
            `curate: dropped "${one.tier}" — roles [${(one.lines ?? []).map((l) => l.role).join(", ")}]`,
          );
          continue;
        }
        // The model's composition, tuned by code to the tier's price band.
        const target = data.budget * (TIER_TARGET[adopted.tier] ?? 1);
        const fitted = fitToBand(adopted, target);
        packages.push({
          ...fitted,
          reasons: reasonsFor(fitted, data.budget, one.rationale),
        });
      }

      // Anything short of three tiers is not the choice we promised the customer.
      if (packages.length < 3) {
        console.warn(`curate: only ${packages.length}/3 packages survived validation`);
        return fallback();
      }
      console.log(`curate: adopted ${packages.length} packages from the model`);

      // Relabel by what things actually cost. The model names its own tiers, and
      // band-fitting then moves each package by a different amount depending on
      // what its composition allows — which produced a "Stretch" that was the
      // cheapest of the three. A tier name that contradicts the price beside it
      // is worse than no tier name at all, so the order decides the label.
      packages.sort((a, b) => a.total - b.total);
      const ORDER: Tier[] = ["lean", "balanced", "premium"];
      const labelled = packages.map((pkg, i) => ({ ...pkg, tier: ORDER[i] ?? pkg.tier }));

      return { packages: labelled, curated: true };
    } catch (err) {
      console.error("curate: failed", err);
      return fallback();
    }
  });
