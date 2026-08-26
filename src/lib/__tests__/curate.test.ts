import { describe, expect, it } from "vitest";

import { CATALOG_FULL } from "@/lib/catalog";
import { candidates, type Role } from "@/lib/packages";
import { adopt, collectionOf, fitToBand, reasonsFor, sampleCandidates } from "@/lib/curate";

const firstId = (role: Role) => candidates(role)[0]!.id;

/** A minimal valid proposal, so each test can break one thing at a time. */
const proposal = (overrides: Partial<Parameters<typeof adopt>[0]> = {}) => ({
  tier: "balanced",
  lines: [
    { role: "styling", productId: firstId("styling"), qty: 4 },
    { role: "mirror", productId: firstId("mirror"), qty: 4 },
  ],
  rationale: "Same collection throughout.",
  ...overrides,
});

describe("sampleCandidates", () => {
  it("spans the price range instead of truncating the cheap end", () => {
    const pool = candidates("mirror");
    const sample = sampleCandidates("mirror", 8);
    expect(pool.length).toBeGreaterThan(8);
    // Truncation would have hidden the dearest options entirely.
    expect(sample[0]!.id).toBe(pool[0]!.id);
    expect(sample.at(-1)!.id).toBe(pool.at(-1)!.id);
  });

  it("returns the whole pool when it already fits", () => {
    const pool = candidates("reception");
    expect(sampleCandidates("reception", 50)).toHaveLength(pool.length);
  });

  it("never repeats a product", () => {
    for (const role of ["styling", "wash", "mirror", "reception"] as Role[]) {
      const ids = sampleCandidates(role, 12).map((c) => c.id);
      expect(new Set(ids).size, role).toBe(ids.length);
    }
  });

  it("carries the collection through, since that is the point of curating", () => {
    const withCollection = (["styling", "mirror", "wash"] as Role[]).flatMap((r) =>
      sampleCandidates(r, 12),
    );
    expect(withCollection.some((c) => c.collection)).toBe(true);
  });

  it("never emits a zero price, which would let the model reason about cost", () => {
    for (const role of ["styling", "wash", "mirror"] as Role[]) {
      for (const c of sampleCandidates(role)) expect(c.price, role).toBeGreaterThan(0);
    }
  });
});

describe("collectionOf", () => {
  it("reads a collection whichever shape the catalogue used", () => {
    const found = Object.values(CATALOG_FULL).filter((p) => collectionOf(p));
    expect(found.length).toBeGreaterThan(50);
  });

  it("returns undefined rather than an empty string", () => {
    const blank = { style_collections: ["", "  "] } as never;
    expect(collectionOf(blank)).toBeUndefined();
  });
});

describe("adopt — the verify half", () => {
  it("accepts a clean proposal and computes the money itself", () => {
    const { package: pkg } = adopt(proposal());
    expect(pkg).not.toBeNull();
    const styling = pkg!.lines.find((l) => l.role === "styling")!;
    expect(styling.subtotal).toBe((styling.product.price ?? 0) * 4);
    expect(pkg!.total).toBe(pkg!.lines.reduce((s, l) => s + l.subtotal, 0));
  });

  it("rejects an invented product id", () => {
    const { issues } = adopt(
      proposal({
        lines: [
          { role: "styling", productId: "not-a-real-id", qty: 4 },
          { role: "mirror", productId: firstId("mirror"), qty: 4 },
        ],
      }),
    );
    expect(issues).toContainEqual({ kind: "unknown-product", productId: "not-a-real-id" });
  });

  // The failure this guards against is a shower hose proposed as a backwash.
  it("rejects a real product placed in a role it cannot fill", () => {
    const mirrorId = firstId("mirror");
    const { issues } = adopt(
      proposal({
        lines: [
          { role: "styling", productId: firstId("styling"), qty: 4 },
          { role: "wash", productId: mirrorId, qty: 1 },
        ],
      }),
    );
    expect(issues).toContainEqual({ kind: "wrong-role", productId: mirrorId, role: "wash" });
  });

  it("refuses a package with no styling chairs, whatever else is in it", () => {
    const { package: pkg } = adopt(
      proposal({ lines: [{ role: "mirror", productId: firstId("mirror"), qty: 4 }] }),
    );
    expect(pkg).toBeNull();
  });

  it("rejects an unknown tier outright", () => {
    const { package: pkg, issues } = adopt(proposal({ tier: "cheapest" }));
    expect(pkg).toBeNull();
    expect(issues).toContainEqual({ kind: "unknown-tier", tier: "cheapest" });
  });

  it("rejects absurd and non-integer quantities", () => {
    for (const qty of [0, -2, 999]) {
      const { issues } = adopt(
        proposal({
          lines: [
            { role: "styling", productId: firstId("styling"), qty: 4 },
            { role: "mirror", productId: firstId("mirror"), qty },
          ],
        }),
      );
      expect(
        issues.some((i) => i.kind === "bad-qty"),
        String(qty),
      ).toBe(true);
    }
  });

  it("keeps only the first of a duplicated role", () => {
    const { package: pkg, issues } = adopt(
      proposal({
        lines: [
          { role: "styling", productId: firstId("styling"), qty: 4 },
          { role: "styling", productId: candidates("styling")[1]!.id, qty: 2 },
        ],
      }),
    );
    expect(pkg!.lines.filter((l) => l.role === "styling")).toHaveLength(1);
    expect(issues).toContainEqual({ kind: "duplicate-role", role: "styling" });
  });

  it("ignores a role name it does not recognise", () => {
    const { issues } = adopt(
      proposal({
        lines: [
          { role: "styling", productId: firstId("styling"), qty: 4 },
          { role: "chandelier", productId: firstId("mirror"), qty: 1 },
        ],
      }),
    );
    expect(issues).toContainEqual({ kind: "unknown-role", role: "chandelier" });
  });
});

describe("reasonsFor", () => {
  const pkg = adopt(proposal()).package!;

  it("states the gap against the budget from the real total", () => {
    expect(reasonsFor(pkg, pkg.total + 2000)[0]).toMatch(/under your/);
    expect(reasonsFor(pkg, pkg.total - 2000)[0]).toMatch(/over your/);
    expect(reasonsFor(pkg, pkg.total)[0]).toMatch(/Exactly on/);
  });

  it("passes the model's rationale through untouched", () => {
    const reasons = reasonsFor(pkg, 20000, "Boho pieces throughout, warm timber.");
    expect(reasons).toContain("Boho pieces throughout, warm timber.");
  });

  it("survives a missing or blank rationale", () => {
    expect(reasonsFor(pkg, 20000).length).toBeGreaterThan(0);
    expect(reasonsFor(pkg, 20000, "   ").some((r) => r.trim() === "")).toBe(false);
  });

  it("says what was left out, so an omission is a choice and not a gap", () => {
    // The fixture has styling and mirror only.
    expect(reasonsFor(pkg, 20000).join(" ")).toMatch(/Leaves out the/);
  });

  it("counts stations and pieces from the lines", () => {
    expect(reasonsFor(pkg, 20000).join(" ")).toMatch(/4 stations, 8 pieces/);
  });
});

describe("fitToBand", () => {
  const base = adopt({
    tier: "balanced",
    lines: [
      { role: "styling", productId: candidates("styling")[0]!.id, qty: 4 },
      { role: "mirror", productId: candidates("mirror")[0]!.id, qty: 4 },
      { role: "wash", productId: candidates("wash")[0]!.id, qty: 2 },
    ],
    rationale: "",
  }).package!;

  it("climbs a badly under-target package towards the band", () => {
    // The observed failure: the model returned a third of the budget.
    const fitted = fitToBand(base, base.total * 3);
    expect(fitted.total).toBeGreaterThan(base.total);
  });

  it("never exceeds the target it was given", () => {
    for (const multiple of [1.5, 2, 4, 10]) {
      const target = base.total * multiple;
      expect(fitToBand(base, target).total, String(multiple)).toBeLessThanOrEqual(target);
    }
  });

  it("leaves a package that already sits in the band alone", () => {
    const fitted = fitToBand(base, base.total);
    expect(fitted.total).toBe(base.total);
  });

  it("keeps the model's roles and quantities untouched — only the product moves", () => {
    const fitted = fitToBand(base, base.total * 3);
    expect(fitted.lines.map((l) => l.role)).toEqual(base.lines.map((l) => l.role));
    expect(fitted.lines.map((l) => l.qty)).toEqual(base.lines.map((l) => l.qty));
  });

  it("keeps subtotals consistent with the product it swapped in", () => {
    for (const line of fitToBand(base, base.total * 3).lines) {
      expect(line.subtotal).toBe((line.product.price ?? 0) * line.qty);
    }
  });

  it("is a no-op on a nonsense target rather than throwing", () => {
    expect(fitToBand(base, 0).total).toBe(base.total);
    expect(fitToBand(base, -100).total).toBe(base.total);
  });
});
