import { createHmac } from "node:crypto";

/**
 * A session is keyed by phone number, but the phone number itself is never
 * stored — see the sessions table's comment in the wa_platform migration. A
 * keyed HMAC, not a plain hash: the space of real phone numbers is small
 * enough to brute-force an unkeyed hash in minutes.
 */
export function waSessionKey(phone: string): string {
  const secret = process.env["WHATSAPP_SESSION_SECRET"];
  if (!secret) throw new Error("WHATSAPP_SESSION_SECRET is not configured");
  const normalised = phone.replace(/\D/g, "");
  if (!normalised) throw new Error("phone required");
  return `wa:${createHmac("sha256", secret).update(normalised).digest("hex")}`;
}
