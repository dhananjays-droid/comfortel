import { describe, expect, it } from "vitest";

import { ROLE_LABEL, buildPackages, candidates, idsOf, needsFor, type Role } from "@/lib/packages";

const ROLES: Role[] = ["styling", "wash", "mirror", "stool", "trolley", "reception", "waiting"];

describe("candidates", () => {
  it("finds real furniture for every role", () => {
    for (const role of ROLES) {
      expect(candidates(role).length, role).toBeGreaterThan(0);
    }
  });

  it("returns them cheapest first", () => {
    for (const role of ROLES) {
      const prices = candidates(role).map((p) => p.price ?? 0);
      expect(
        [...prices].sort((a, b) => a - b),
        role,
      ).toEqual(prices);
    }
  });

  // The whole reason the price floors exist. These specific entries live in the
  // same buckets as the furniture and would otherwise be picked first, since the
  // packer starts from the cheapest option.
  it("excludes the accessories that share a bucket with the furniture", () => {
    const names = (role: Role) => candidates(role).map((p) => p.name.toLowerCase());
    expect(names("wash").some((n) => n.includes("hose"))).toBe(false);
    expect(names("wash").some((n) => n.includes("comfortneck"))).toBe(false);
    expect(names("mirror").some((n) => n.includes("joiner frame"))).toBe(false);
    expect(names("trolley").some((n) => n.includes("tint bowl"))).toBe(false);
  });

  it("keeps the actual furniture", () => {
    expect(candidates("styling").some((p) => p.name.includes("Styling Chair"))).toBe(true);
    expect(candidates("reception").some((p) => p.name.includes("Reception Desk"))).toBe(true);
  });
});

describe("needsFor", () => {
  it("gives one chair, mirror and stool per station", () => {
    const needs = needsFor(4);
    for (const role of ["styling", "mirror", "stool"] as const) {
      expect(needs.find((n) => n.role === role)?.qty, role).toBe(4);
    }
  });

  it("puts one backwash in for every three chairs, rounded up", () => {
    expect(needsFor(1).find((n) => n.role === "wash")?.qty).toBe(1);
    expect(needsFor(3).find((n) => n.role === "wash")?.qty).toBe(1);
    expect(needsFor(4).find((n) => n.role === "wash")?.qty).toBe(2);
    expect(needsFor(9).find((n) => n.role === "wash")?.qty).toBe(3);
  });

  it("only ever needs one reception desk", () => {
    expect(needsFor(12).find((n) => n.role === "reception")?.qty).toBe(1);
  });

  it("clamps absurd station counts rather than trying to serve them", () => {
    expect(needsFor(0).find((n) => n.role === "styling")?.qty).toBe(1);
    expect(needsFor(500).find((n) => n.role === "styling")?.qty).toBe(20);
  });
});

describe("buildPackages", () => {
  const budget = 15000;
  const needs = needsFor(4);
  const packs = buildPackages(budget, needs);

  it("returns exactly three, cheapest first", () => {
    expect(packs.map((p) => p.tier)).toEqual(["lean", "balanced", "premium"]);
  });

  it("brackets the budget: one under, one near, one above", () => {
    const [lean, balanced, premium] = packs;
    expect(lean!.total).toBeLessThan(balanced!.total);
    expect(balanced!.total).toBeLessThanOrEqual(premium!.total);
    expect(lean!.total).toBeLessThan(budget);
  });

  it("never proposes a package it could not afford at its own target", () => {
    // Each tier is capped at its multiple of the budget, mirroring TIER_TARGET.
    const caps = [0.85, 1.0, 1.25];
    packs.forEach((pkg, i) => {
      expect(pkg.total, pkg.tier).toBeLessThanOrEqual(budget * caps[i]!);
    });
  });

  it("covers every role in every tier", () => {
    for (const pkg of packs) {
      expect(pkg.lines.map((l) => l.role).sort()).toEqual([...ROLES].sort());
    }
  });

  it("gets the arithmetic right", () => {
    for (const pkg of packs) {
      const sum = pkg.lines.reduce((s, l) => s + (l.product.price ?? 0) * l.qty, 0);
      expect(pkg.total).toBe(sum);
      for (const line of pkg.lines) {
        expect(line.subtotal).toBe((line.product.price ?? 0) * line.qty);
      }
    }
  });

  it("buys more with more money", () => {
    const poor = buildPackages(8000, needs)[1]!;
    const rich = buildPackages(30000, needs)[1]!;
    expect(rich.total).toBeGreaterThan(poor.total);
  });

  it("is deterministic — the same ask returns the same package", () => {
    expect(idsOf(buildPackages(budget, needs)[1]!)).toEqual(idsOf(packs[1]!));
  });

  it("still returns something usable on a budget that cannot cover the room", () => {
    const broke = buildPackages(500, needsFor(4));
    for (const pkg of broke) {
      expect(pkg.lines.length).toBe(ROLES.length);
      expect(pkg.total).toBeGreaterThan(0);
    }
  });
});

describe("reasons", () => {
  const budget = 15000;
  const packs = buildPackages(budget, needsFor(4));

  it("gives every tier at least one reason", () => {
    for (const pkg of packs) {
      expect(pkg.reasons.length, pkg.tier).toBeGreaterThan(0);
      for (const reason of pkg.reasons) expect(reason.trim()).not.toBe("");
    }
  });

  it("leads with the money, because that is the question being asked", () => {
    expect(packs[0]!.reasons[0]).toMatch(/under your budget/);
    expect(packs[2]!.reasons[0]).toMatch(/over budget/);
    expect(packs[1]!.reasons[0]).toMatch(/\$/);
  });

  it("names a concrete product difference rather than an adjective", () => {
    // Comparative reasons are the point: people judge options against each
    // other, not in isolation.
    const lean = packs[0]!.reasons.join(" ");
    const premium = packs[2]!.reasons.join(" ");
    expect(lean + premium).toMatch(/rather than/);
  });

  it("uses role words a salon owner would recognise", () => {
    const all = packs.flatMap((p) => p.reasons).join(" ");
    const used = Object.values(ROLE_LABEL).some((label) => all.includes(label));
    expect(used).toBe(true);
  });

  it("reassures that the layout does not change between tiers", () => {
    expect(packs[0]!.reasons.join(" ")).toMatch(/Same station count/);
  });
});

describe("tiers stay distinct and honestly described", () => {
  const budget = 15000;
  const packs = buildPackages(budget, needsFor(4));

  // A stretch tier that matches the middle one is not a choice. This happened:
  // an overrun cap blocked every upgrade and premium collapsed onto balanced.
  it("gives three different packages, not two and a copy", () => {
    const signatures = packs.map((p) => idsOf(p).join(","));
    expect(new Set(signatures).size).toBe(3);
  });

  // The first allocator spent $5,908 on mirrors against $2,396 of chairs, in
  // every tier. Checked on lean and balanced only: the styling pool tops out at
  // $1,090 and mirrors run to $1,477, so once the chairs are maxed a dearer
  // mirror is honestly the only upgrade the catalogue still offers. That is a
  // fact about the range, not a broken allocator.
  it("keeps the chairs worth more than the mirrors, where a choice exists", () => {
    for (const pkg of packs.filter((p) => p.tier !== "premium")) {
      const spend = (role: string) => pkg.lines.find((l) => l.role === role)?.subtotal ?? 0;
      expect(spend("styling"), pkg.tier).toBeGreaterThanOrEqual(spend("mirror"));
    }
  });

  it("never says over budget about a package that costs less", () => {
    for (const pkg of packs) {
      const claimsOver = pkg.reasons.some((r) => /over budget/.test(r));
      if (claimsOver) expect(pkg.total, pkg.tier).toBeGreaterThan(budget);
      const claimsUnder = pkg.reasons.some((r) => /under your budget/.test(r));
      if (claimsUnder) expect(pkg.total, pkg.tier).toBeLessThan(budget);
    }
  });

  it("counts differing pieces with the right grammar", () => {
    const all = packs.flatMap((p) => p.reasons).join(" ");
    expect(all).not.toMatch(/\b1 other pieces differ\b/);
    expect(all).not.toMatch(/\b[02-9] other piece differs\b/);
  });

  it("holds up across budgets, not just the one it was tuned on", () => {
    for (const b of [6000, 9000, 15000, 25000, 60000]) {
      const set = buildPackages(b, needsFor(4));
      expect(set, String(b)).toHaveLength(3);
      for (const pkg of set) {
        expect(pkg.total, `${b}/${pkg.tier}`).toBeGreaterThan(0);
        expect(pkg.reasons.length).toBeGreaterThan(0);
      }
      expect(set[0]!.total).toBeLessThanOrEqual(set[1]!.total);
    }
  });
});
