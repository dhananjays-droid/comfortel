import { describe, expect, it } from "vitest";
import auditRaw from "@/data/product-views-audit.json";
import catalogRaw from "@/data/catalog-full.json";

type AuditImage = { i: number; url: string; verdict: string };
type AuditEntry = { name: string; decidedBy: string; note: string; images: AuditImage[] };
const AUDIT = auditRaw as unknown as {
  _meta: { vendorScrape: { finding: string } };
  products: Record<string, AuditEntry>;
};
const CATALOG = catalogRaw as unknown as Record<string, { images?: string[] }>;
const VERDICTS = ["hero", "front", "side", "back", "detail", "reject"];

import { ANGLE_PHRASE, viewsFor } from "@/lib/product-views";
import { referenceViews } from "@/lib/visualize-prompt";

describe("viewsFor", () => {
  it("returns an empty list for an unknown product", () => {
    expect(viewsFor("no-such-id")).toEqual([]);
  });
});

describe("ANGLE_PHRASE", () => {
  it("phrases every angle for the prompt", () => {
    expect(ANGLE_PHRASE.hero).toBe("as the catalogue shows it");
    expect(ANGLE_PHRASE.front).toBe("from the front");
    expect(ANGLE_PHRASE.side).toBe("from the side");
    expect(ANGLE_PHRASE.back).toBe("from the back");
    expect(ANGLE_PHRASE.detail).toBe("in close-up detail");
  });

  it("phrases angles identically in both modules", () => {
    for (const angle of ["hero", "front", "side", "back", "detail"] as const) {
      const [view] = referenceViews({
        id: "x",
        name: "x",
        images: [],
        views: [{ url: "u", angle }],
      });
      expect(view?.angle).toBe(ANGLE_PHRASE[angle]);
    }
  });
});

describe("the classification audit", () => {
  it("records a verdict for every photograph of every product", () => {
    // The audit is the reasoning; product-views.json is only the survivors.
    // Without it, a re-run repeats the work and repeats the mistakes.
    for (const [id, entry] of Object.entries(AUDIT.products)) {
      const images = CATALOG[id]?.images ?? [];
      expect(entry.images.length, `${entry.name} image count`).toBe(images.length);
      for (const img of entry.images) {
        expect(VERDICTS, `${entry.name} #${img.i}`).toContain(img.verdict);
      }
    }
  });

  it("agrees with the views the app actually sends", () => {
    // The two files drifting apart is silent: the app keeps using a reference
    // the audit says was rejected, and nobody finds out.
    for (const [id, entry] of Object.entries(AUDIT.products)) {
      const kept = new Set(
        entry.images.filter((i) => i.verdict !== "reject").map((i) => `${i.url}|${i.verdict}`),
      );
      const live = viewsFor(id).map((v) => `${v.url}|${v.angle}`);
      for (const v of live) expect(kept, `${entry.name}`).toContain(v);
      expect(live.length, `${entry.name} count`).toBe(kept.size);
    }
  });

  it("never keeps two photographs at the same angle, in the hand-reviewed sets", () => {
    for (const [, entry] of Object.entries(AUDIT.products)) {
      if (entry.decidedBy !== "hand") continue;
      const angles = entry.images.map((i) => i.verdict).filter((v) => v !== "reject");
      expect(new Set(angles).size, `${entry.name}`).toBe(angles.length);
    }
  });

  it("tolerates duplicate angles in the auto sets, because referenceViews dedupes them", () => {
    // 35 auto-classified products label two photos the same angle. Not a live
    // fault — referenceViews takes one per angle before it takes any second —
    // but it is a standing reason to prefer the hand sets, so it is counted
    // here rather than left as folklore.
    const dupes = Object.values(AUDIT.products).filter((entry) => {
      const angles = entry.images.map((i) => i.verdict).filter((v) => v !== "reject");
      return new Set(angles).size !== angles.length;
    });
    expect(dupes.every((d) => d.decidedBy === "auto")).toBe(true);
    expect(dupes.length).toBeGreaterThan(0);
  });

  it("leads every multi-view set with a hero", () => {
    for (const [id, entry] of Object.entries(AUDIT.products)) {
      const views = viewsFor(id);
      if (views.length < 2) continue;
      expect(views[0]?.angle, `${entry.name}`).toBe("hero");
    }
  });

  it("keeps the scrape finding with the data it explains", () => {
    // So the next person does not write another scraper to discover the same
    // thing: the vendor publishes nothing the catalogue is missing.
    expect(AUDIT._meta.vendorScrape.finding).toMatch(/no photographs the catalogue is missing/i);
  });

  it("marks the hand-reviewed products, which the classifier must not overwrite", () => {
    const hand = Object.values(AUDIT.products).filter((p) => p.decidedBy === "hand");
    expect(hand.length).toBeGreaterThan(40);
  });
});
