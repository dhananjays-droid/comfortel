import raw from "@/data/product-selection-evidence.json";
import type { FullProduct } from "@/lib/catalog";
import { productPurpose } from "@/lib/product-purpose";

type WebsiteEvidence = {
  name: string;
  sourceUrl: string;
  checkedAt: string;
  baselineDescription: string | null;
  baselineCategory: string | null;
  description: string;
  subtitle: string;
  features: string[];
  intendedUses: string[];
  details?: string[];
  specs: Record<string, string>;
  options: Record<string, string[]>;
  manualUrl: string | null;
};
const records = raw as Record<string, WebsiteEvidence>;

/** A changed managed product must not inherit another/stale configuration's facts. */
export function selectionEvidenceFor(p: FullProduct): WebsiteEvidence | null {
  const r = records[p.id];
  return r &&
    r.name === p.name &&
    r.sourceUrl === p.url &&
    r.baselineDescription === p.description &&
    r.baselineCategory === p.category
    ? r
    : null;
}

/** Deterministic, source-backed retrieval metadata, not a product certification.
 * null means not documented; absence is NEVER a claim a feature is unavailable.
 * No dimensions are inferred from photographs, shipping sizes or related models.
 */
export function selectionProfile(p: FullProduct) {
  const source = selectionEvidenceFor(p);
  const entries = [
    p.name,
    source?.subtitle,
    source?.description || p.description,
    ...(source?.features ?? []),
    ...(source?.intendedUses ?? []),
    ...(source?.details ?? []),
  ].filter((s): s is string => Boolean(s));
  const evidence: Record<string, string> = {};
  const has = (key: string, re: RegExp) => {
    const found = entries
      .flatMap((s) => s.split(/(?<=[.!?])\s+|\n/))
      .find(
        (s) =>
          re.test(s) &&
          !/\b(?:not|no|without|optional|optionally|upgrade|add.on|see|refer to)\b/i.test(s),
      );
    if (found) evidence[key] = found.slice(0, 240);
    return found ? true : null;
  };
  const purpose = productPurpose(p);
  const mirror = purpose === "mirror";
  const chair = purpose === "chair";
  const doubleSided = mirror
    ? has(
        "double_sided",
        /double[- ]sided|double salon mirror|double round.*mirror|mirror.*[–-] double/i,
      )
    : null;
  const island = mirror
    ? doubleSided ||
      has("island", /pole frame|free[- ]?standing|double[- ]sided|double salon mirror/i)
    : null;
  const wallSupported = mirror
    ? has("wall_supported", /needs to be leaning against a wall|have a rear support/i)
    : null;
  const wall = mirror ? has("wall", /wall[- ]mount|hang it|wall station/i) : null;
  const beauty = chair
    ? has("beauty_services", /make\s?up|threading|lash extensions|brow waxing/i)
    : null;
  const barber = chair ? has("barber_services", /barber(?:s|ing)?\b/i) : null;
  const styling = chair
    ? has("hair_styling", /styling chair|hairdressing.*chair|hair salon.*chair/i)
    : null;
  const features = {
    led: mirror
      ? has(
          "led",
          /\bLED(?:['’]s|s)?\s+(?:light|mirror)|backlit LED|LED.*(?:round|oval|arch).*mirror/i,
        )
      : null,
    daylightLighting: mirror ? has("daylight_lighting", /6000\s?K|daylight LED/i) : null,
    dimmable: mirror ? has("dimmable", /dimm(?:ing|able)|adjust.*(?:light|brightness)/i) : null,
    workSurface: mirror
      ? has(
          "work_surface",
          /with bench|incorporated workbench|built.in (?:shelf|bench)|bench section|terrazzo table|stone bench/i,
        )
      : null,
    reclining: chair ? has("reclining", /reclin(?:ing|able|e)\b/i) : null,
    adjustableHeight: chair
      ? has("adjustable_height", /hydraulic lift|adjustable (?:seat )?height|height adjust/i)
      : null,
    compact: has("compact", /\bcompact\b|narrow.*profile/i),
    easyClean: has(
      "easy_clean",
      /easy[- ](?:to[- ])?clean|stop hair getting caught|prevent.*hair.*(?:trap|caught)|seamless/i,
    ),
    electric: has("electric", /electric(?:al)? reclin|electric lift/i),
    massage: has("massage", /with massage|massage function/i),
  };
  const use = p.is_component || purpose === "accessory"
    ? "component"
    : chair
      ? beauty
        ? "beauty_services"
        : barber
          ? "barber"
          : styling
            ? "hair_styling"
            : "unknown_chair"
      : mirror
        ? "styling_mirror"
        : purpose === "wash"
          ? "wash_area"
          : /retail shelves/i.test(p.name)
            ? "retail_display"
            : (p.salon_placement ?? p.category ?? "unknown");
  const checks = ["Confirm exact configuration and installation before purchase."];
  if (chair)
    checks.push(
      "Verify assembled-chair load capacity, seat-height range and operating/recline clearance; shipping dimensions are not the footprint.",
    );
  if (mirror) {
    checks.push(
      wallSupported
        ? "This single mirror needs wall or rear support; do not treat it as a self-supporting island."
        : island
          ? "Check floor/ceiling fixing and circulation on both sides."
          : "Confirm wall mounting, wall construction and work-surface needs.",
    );
    if (features.led)
      checks.push(
        "Confirm US electrical compatibility; lighting specifications do not certify overall room colour accuracy.",
      );
  }
  if (use === "wash_area")
    checks.push(
      "Confirm plumbing, service access and power requirements for the exact unit; basin alone is not a wash lounge.",
    );
  if (Object.keys(source?.options ?? {}).length)
    checks.push(
      "Selectable base/lift/options are not automatically included in the listed price or reference image.",
    );
  return {
    version: 1,
    sourceUrl: p.url,
    checkedAt: source?.checkedAt ?? null,
    evidenceStatus: source ? "website_checked" : "saved_catalog_only",
    primaryUse: use,
    mirrorLayout: mirror
      ? wallSupported
        ? "wall"
        : island
          ? "island"
          : wall
            ? "wall"
            : "unknown"
      : null,
    mounting: mirror
      ? wallSupported
        ? "wall_or_rear_support"
        : island
          ? "island_fixing_to_confirm"
          : wall
            ? "wall_mount"
            : "unknown"
      : null,
    stationFaces: mirror ? (wallSupported ? 1 : doubleSided ? 2 : island ? null : 1) : null,
    features,
    evidence,
    checks,
    missingFacts: [
      ...(!p.description && !source?.description ? ["description"] : []),
      ...(chair && !styling && !barber && !beauty ? ["intended chair service"] : []),
      ...(mirror && !wall && !island && !wallSupported ? ["mounting method"] : []),
    ],
  };
}
