/**
 * Encrypts the one piece of PII this channel adapter has to store: the
 * customer's phone number, on `wa_render_jobs` only.
 *
 * Every other table is deliberately phone-number-free — `sessions` is keyed
 * by `waSessionKey()`'s one-way HMAC (see wa-session.server.ts) precisely so
 * a session row can never be traced back to a phone number. A render job is
 * the one exception: `wa-render-worker.server.ts` runs on a Vercel Cron tick
 * minutes after the original webhook request, with no access to that
 * request, and an HMAC can't be reversed — there is no other way to know
 * where to deliver the finished image. AES-256-GCM (reversible, authenticated)
 * is the right primitive for "store now, must read back later," unlike the
 * session key's HMAC (never read back, only re-derived and compared).
 *
 * `WHATSAPP_PHONE_ENC_KEY` is deliberately a separate secret from
 * `WHATSAPP_SESSION_SECRET` — a leak of one shouldn't compromise the other.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function encryptionKey(): Buffer {
  const secret = process.env["WHATSAPP_PHONE_ENC_KEY"];
  if (!secret) throw new Error("WHATSAPP_PHONE_ENC_KEY is not configured");
  return scryptSync(secret, "wa-render-jobs-phone", 32);
}

export function encryptPhone(phone: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(phone, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptPhone(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, IV_BYTES);
  const authTag = buf.subarray(IV_BYTES, IV_BYTES + 16);
  const encrypted = buf.subarray(IV_BYTES + 16);
  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
