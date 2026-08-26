import { describe, expect, it } from "vitest";

import { CARRIER_LABEL, WA, carrierFor, clock, fit, timeOf, truncate } from "@/lib/whatsapp";

describe("truncate", () => {
  it("leaves text inside the limit untouched", () => {
    expect(truncate("Render these", WA.buttonTitle)).toBe("Render these");
  });

  it("never exceeds the limit, including the ellipsis", () => {
    const out = truncate("See these pieces in my salon right now", WA.buttonTitle);
    expect(out.length).toBeLessThanOrEqual(WA.buttonTitle);
    expect(out.endsWith("…")).toBe(true);
  });

  it("handles a limit of zero without throwing", () => {
    expect(truncate("anything", 0)).toBe("…");
  });

  it("does not leave a dangling space before the ellipsis", () => {
    expect(truncate("aaaa bbbbbbbbbbbbbbbbbbbbbb", 6)).toBe("aaaa…");
  });
});

describe("fit", () => {
  it("keeps everything when it fits", () => {
    const { kept, dropped } = fit([1, 2, 3], WA.buttons);
    expect(kept).toEqual([1, 2, 3]);
    expect(dropped).toEqual([]);
  });

  it("reports the overflow rather than silently cutting", () => {
    const { kept, dropped } = fit([1, 2, 3, 4, 5], WA.buttons);
    expect(kept).toHaveLength(3);
    expect(dropped).toEqual([4, 5]);
  });
});

describe("carrierFor", () => {
  it("uses buttons up to the button cap", () => {
    expect(carrierFor(1)).toBe("buttons");
    expect(carrierFor(WA.buttons)).toBe("buttons");
  });

  it("steps up to a list past the button cap", () => {
    expect(carrierFor(WA.buttons + 1)).toBe("list");
    expect(carrierFor(WA.listRows)).toBe("list");
  });

  it("steps up to the catalogue past the list cap", () => {
    expect(carrierFor(WA.listRows + 1)).toBe("catalog");
    expect(carrierFor(WA.catalogProducts)).toBe("catalog");
  });

  it("reports an impossible set rather than pretending", () => {
    expect(carrierFor(WA.catalogProducts + 1)).toBe("too-many");
  });

  it("labels every carrier it can return", () => {
    for (const n of [1, 5, 20, 100]) {
      expect(CARRIER_LABEL[carrierFor(n)]).toBeTruthy();
    }
  });

  // The plan caps at 10 products, which is exactly the list-message limit —
  // worth pinning, because raising MAX_REFERENCES would silently force the
  // heavier catalogue path.
  it("keeps a full 10-piece plan inside a single list message", () => {
    expect(carrierFor(10)).toBe("list");
  });
});

describe("timeOf", () => {
  const now = 1_756_200_000_000;

  it("recovers the creation time from an id", () => {
    const id = `m${now.toString(36)}0`;
    expect(timeOf(id, now)).toBe(now);
  });

  it("recovers it regardless of how long the sequence suffix is", () => {
    const id = `m${now.toString(36)}zzz`;
    expect(timeOf(id, now)).toBe(now);
  });

  it("falls back to now when the id is not in the expected format", () => {
    expect(timeOf("not-an-id", now)).toBe(now);
    expect(timeOf("", now)).toBe(now);
  });

  it("falls back rather than rendering an absurd date", () => {
    expect(timeOf("m000000000", now)).toBe(now);
  });
});

describe("clock", () => {
  it("renders hours and minutes only", () => {
    expect(clock(new Date(2026, 0, 1, 9, 5).getTime())).toMatch(/\b9:05\b/);
  });
});
