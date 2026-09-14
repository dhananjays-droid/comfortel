import { needsFor, buildPackages, type Need, type Package, type Role } from "@/lib/packages";
const names: Record<Role, string> = {
  styling: "(?:salon |styling |barber )?(?:chairs?|stations?)",
  mirror: "mirrors?",
  wash: "(?:shampoo|wash|backwash)(?: units?| lounges?)?",
  reception: "reception(?: desks?)?",
  waiting: "waiting(?: chairs?| seats?| seating)?",
  trolley: "trolleys?",
  stool: "stools?",
};
const numbers: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};
export function whatsappNeeds(stations: number, brief: string): Need[] {
  const quantities = new Map(needsFor(stations).map((need) => [need.role, need.qty]));
  for (const sentence of brief.split(/[.\n]/))
    for (const [role, name] of Object.entries(names) as Array<[Role, string]>) {
      const scoped =
        role === "styling"
          ? sentence.replace(/\bwaiting(?: chairs?| seats?| seating)?\b/gi, "")
          : sentence;
      if (
        new RegExp(`\\b(?:no|without|exclude|don.t need)\\b.{0,55}\\b${name}\\b`, "i").test(scoped)
      )
        quantities.delete(role);
      const matches = [
        ...sentence.matchAll(
          new RegExp(`\\b(\\d{1,2}|${Object.keys(numbers).join("|")})\\s+${name}\\b`, "gi"),
        ),
      ];
      const match = matches.at(-1);
      if (match) {
        const qty = numbers[match[1]!.toLowerCase()] ?? Number(match[1]);
        if (qty > 0 && qty <= 20) quantities.set(role, qty);
      }
    }
  return [...quantities].map(([role, qty]) => ({ role, qty }));
}
export function enforceWhatsAppNeeds(
  pkg: Package,
  needs: Need[],
  fallback: Package,
  budget?: number,
): Package {
  const lines = needs.flatMap((need) => {
    const line =
      pkg.lines.find((line) => line.role === need.role) ??
      fallback.lines.find((line) => line.role === need.role);
    return line
      ? [
          {
            ...line,
            qty: need.qty,
            subtotal: (Math.round((line.product.price ?? 0) * 100) * need.qty) / 100,
          },
        ]
      : [];
  });
  const corrected: Package = {
    ...pkg,
    lines,
    total: Math.round(lines.reduce((sum, line) => sum + line.subtotal, 0) * 100) / 100,
    reasons: [],
  };
  if (budget !== undefined && pkg.tier !== "premium" && corrected.total > budget) {
    const safe = [fallback, ...buildPackages(budget, needs)]
      .filter((option) => option.total <= budget)
      .sort((a, b) => b.total - a.total)[0];
    if (safe) return { ...safe, tier: pkg.tier, reasons: [] };
  }
  return corrected;
}
