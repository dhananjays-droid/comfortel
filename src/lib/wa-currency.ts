export type BudgetCurrency = "USD" | "AUD" | "CAD" | "GBP" | "EUR" | "other";

// Explicit markers, most specific first: "C$" and "A$" contain a dollar sign
// but are not US dollars. A nationality alone ("a Canadian salon") is not a
// currency choice.
const EXPLICIT: [BudgetCurrency, RegExp][] = [
  ["CAD", /\bCAD\b|\b(?:C|CA|CDN)\$|\bcanadian dollars?\b|\bin canadian\b/i],
  ["AUD", /\bAUD\b|\b(?:A|AU)\$|\baustralian dollars?\b|\bin australian\b|\baussie dollars?\b/i],
  [
    "other",
    /\b(?:NZD|SGD|HKD|MXN|INR|JPY|CNY|AED|ZAR|CHF)\b|\b(?:NZ|S|HK|MX)\$|₹|¥|\brupees?\b|\bdirhams?\b|\bnew zealand dollars?\b|\bsingapore dollars?\b/i,
  ],
  ["GBP", /\bGBP\b|£|\bpounds? sterling\b|\bbritish pounds?\b/i],
  ["EUR", /\bEUR\b|€|\beuros?\b/i],
  ["USD", /\bUSD\b|\bUS\$|\bU\.?S\.? dollars?\b|\bamerican dollars?\b/i],
];
// A plain "$35,000" or "35k dollars" with no other currency named.
const BARE_DOLLAR = /(?:^|[^A-Za-z$])\$\s?\d|\d\s*(?:k\s*)?dollars?\b/i;

/** The currency a customer's message gives for an amount. A bare $ amount is
 * USD by default (explicit: false), so it never overrides a currency the
 * customer chose earlier; an explicit currency always wins, including later
 * corrections. No amount is converted here. */
export function budgetCurrency(
  text: string,
): { currency: BudgetCurrency; explicit: boolean } | null {
  for (const [currency, pattern] of EXPLICIT)
    if (pattern.test(text)) return { currency, explicit: true };
  return BARE_DOLLAR.test(text) ? { currency: "USD", explicit: false } : null;
}
