import type { Expected, Verdict } from "@/lib/render-qa";

/** Delivery-only check: never changes retry eligibility or purchases a call. */
export function quantityReview(expected: Expected[], verdict: Verdict) {
  const issues: string[] = [];
  for (const want of expected) {
    const matches = (verdict.counts ?? []).filter(c => c.item.trim().toLowerCase() === want.name.trim().toLowerCase());
    if (matches.length !== 1 || !Number.isInteger(matches[0]?.seen) || matches[0]!.seen < 0)
      issues.push(`${want.name}: quantity could not be verified`);
    else if (matches[0]!.seen !== want.qty)
      issues.push(`${want.name}: requested ${want.qty}, counted ${matches[0]!.seen}`);
  }
  const unavailable = verdict.inspection === "unavailable" ||
    ("editCheck" in verdict && verdict.editCheck === "unavailable");
  const accepted = !unavailable && verdict.ok && issues.length === 0;
  // Leave room for the delivery footer within WhatsApp's caption limit.
  const detail = issues.length
    ? `${issues.join("; ").slice(0, 550)}${issues.join("; ").length > 550 ? "…" : "."} `
    : "The automatic image check did not pass. ";
  return {
    accepted,
    message: accepted ? "" : `Preview only—not verified as matching your selection. ${detail}Your plan and quote quantities are unchanged. This image is not evidence that the furniture fits your room.`,
  };
}
