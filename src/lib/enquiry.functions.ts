import { createServerFn } from "@tanstack/react-start";

import catalogFull from "@/data/catalog-full.json";

export type EnquiryInput = {
  productId: string;
  fullName: string;
  email: string;
  /** Extra recipients beyond the primary — a business partner, say. The
   * confirmation email goes to all of them; `email` stays the one
   * required field so the web app's existing form needs no change. */
  additionalEmails?: string[] | undefined;
  phone?: string | undefined;
  businessName?: string | undefined;
  quantity?: number | undefined;
  notes?: string | undefined;
  visualizationUrl?: string | undefined;
};

export type EnquiryResult = { reference: string; productName: string };

// Deliberately permissive: this is a "did they typo it" check, not an attempt to
// implement RFC 5322. Anything stricter rejects real addresses.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const trim = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

/** CF-K3F9QA — short enough to read down a phone, unique enough for a demo. */
function makeReference(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I/L/O/0/1
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `CF-${out}`;
}

/** Up to 4 extras beyond the primary — enough for "me and a couple of
 * partners", not an open invite list. Invalid entries are dropped rather
 * than rejecting the whole submission: a typo'd second email shouldn't
 * cost the customer the quote they actually asked for. */
const MAX_ADDITIONAL_EMAILS = 4;

export function parseEnquiryInput(input: EnquiryInput) {
  const productId = trim(input?.productId, 32);
  const fullName = trim(input?.fullName, 120);
  const email = trim(input?.email, 200);

  if (!productId) throw new Error("productId required");
  if (fullName.length < 2) throw new Error("NAME_REQUIRED");
  if (!EMAIL.test(email)) throw new Error("EMAIL_INVALID");

  const additionalEmails = Array.isArray(input?.additionalEmails)
    ? Array.from(
        new Set(
          input.additionalEmails
            .map((e) => trim(e, 200))
            .filter((e) => e && EMAIL.test(e) && e.toLowerCase() !== email.toLowerCase()),
        ),
      ).slice(0, MAX_ADDITIONAL_EMAILS)
    : [];

  const quantity = Number(input?.quantity);
  return {
    productId,
    fullName,
    email,
    additionalEmails,
    phone: trim(input?.phone, 40),
    businessName: trim(input?.businessName, 160),
    notes: trim(input?.notes, 2000),
    visualizationUrl: trim(input?.visualizationUrl, 2000),
    quantity: Number.isFinite(quantity) ? Math.min(999, Math.max(1, Math.round(quantity))) : 1,
  };
}

export type EnquiryData = ReturnType<typeof parseEnquiryInput>;

export async function runSubmitEnquiry(data: EnquiryData): Promise<EnquiryResult> {
  const catalog = catalogFull as unknown as Record<
    string,
    { name: string; url: string } | undefined
  >;
  const product = catalog[data.productId];
  if (!product) throw new Error("PRODUCT_NOT_FOUND");

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // The reference is random, so a collision is a retry rather than an error.
    for (let attempt = 0; attempt < 4; attempt++) {
      const reference = makeReference();
      const { error } = await supabaseAdmin.from("enquiries").insert({
        reference,
        product_id: data.productId,
        product_name: product.name,
        product_url: product.url ?? null,
        quantity: data.quantity,
        full_name: data.fullName,
        email: data.email,
        additional_emails: data.additionalEmails,
        phone: data.phone || null,
        business_name: data.businessName || null,
        notes: data.notes || null,
        visualization_url: data.visualizationUrl || null,
      });

      if (!error) {
        // Best-effort: the enquiry itself is already durably recorded above,
        // so a mail-sending hiccup must never turn into a customer-facing
        // "your quote request failed" when it plainly did not.
        const { sendQuoteEmails } = await import("@/lib/wa-email.server");
        await sendQuoteEmails({
          reference,
          productName: product.name,
          productUrl: product.url ?? null,
          quantity: data.quantity,
          fullName: data.fullName,
          emails: [data.email, ...data.additionalEmails],
          businessName: data.businessName || null,
        });
        return { reference, productName: product.name };
      }
      // 23505 = unique_violation on `reference`
      if (error.code !== "23505") throw error;
    }
    throw new Error("could not allocate a reference");
  } catch (err) {
    console.error("submitEnquiry failed", err);
    throw new Error("ENQUIRY_FAILED");
  }
}

export const submitEnquiry = createServerFn({ method: "POST" })
  .validator(parseEnquiryInput)
  .handler(async ({ data }): Promise<EnquiryResult> => runSubmitEnquiry(data));
