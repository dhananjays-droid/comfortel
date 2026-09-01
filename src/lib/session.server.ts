import { createHmac } from "node:crypto";

/**
 * The session key for a WhatsApp customer.
 *
 * An HMAC of the phone number, never the number. The webhook hands us the
 * number on every single message, so we never need to read one back out of the
 * database in order to reply — which makes storing it pure liability. A plain
 * SHA-256 would not do: the space of phone numbers is small enough to exhaust,
 * so an unkeyed digest is reversible by brute force in minutes. The secret is
 * what makes the mapping one-way.
 *
 * Rotating WHATSAPP_SESSION_SECRET orphans every existing session. That is the
 * intended behaviour for a leaked secret — old rows become unreadable rather
 * than re-linkable — but it does mean customers lose their plans, so it is not
 * something to do casually.
 */
export function waSessionKey(phone: string): string {
  const secret = process.env["WHATSAPP_SESSION_SECRET"];
  if (!secret) throw new Error("WHATSAPP_SESSION_SECRET is not configured");

  // Digits only, so "+61 400 000 000" and "61400000000" are one customer rather
  // than two conversations that never meet.
  const normalised = phone.replace(/\D/g, "");
  if (!normalised) throw new Error("phone required");

  return `wa:${createHmac("sha256", secret).update(normalised).digest("hex")}`;
}
