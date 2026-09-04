/**
 * Sends the two emails a submitted quote request actually needs: a
 * confirmation to the customer (every email address they gave, not just
 * the first), and a notification to Comfortel's own sales inbox so a real
 * person knows to follow up. Neither existed before this — submitEnquiry
 * only ever wrote a database row; "someone will follow up at your email"
 * was a promise nothing kept, which a customer noticed and flagged.
 *
 * Talks to Resend's REST API directly via fetch, the same way
 * kie.server.ts/wa-client.server.ts speak to their own vendors — no SDK
 * dependency for a handful of POST calls.
 *
 * Fails open, like every other outbound send in this codebase: a mail
 * provider hiccup must never turn an already-recorded enquiry into a
 * customer-facing failure. Missing configuration (no API key, no sales
 * address set) degrades to "skip that email and log why", not a thrown
 * error — same resilience stance as wa-media.server.ts's rehostRender.
 */

const RESEND_API_URL = "https://api.resend.com/emails";

type QuoteEmailInput = {
  reference: string;
  productName: string;
  productUrl: string | null;
  quantity: number;
  fullName: string;
  /** Every recipient the customer gave — the primary email plus any
   * additional ones, already deduplicated by parseEnquiryInput. */
  emails: string[];
  businessName: string | null;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendViaResend(payload: {
  to: string[];
  subject: string;
  html: string;
}): Promise<void> {
  const apiKey = process.env["RESEND_API_KEY"];
  if (!apiKey) {
    console.error("sendViaResend: RESEND_API_KEY not configured, skipping send");
    return;
  }
  // Resend's own shared testing sender works with no domain setup at all;
  // swap RESEND_FROM_EMAIL to a verified @comfortelfurniture.com address
  // once one exists — customers seeing a resend.dev sender is fine for
  // now, not fine forever.
  const from = process.env["RESEND_FROM_EMAIL"] || "Comfortel <onboarding@resend.dev>";

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from, to: payload.to, subject: payload.subject, html: payload.html }),
    });
    if (!res.ok) {
      console.error("sendViaResend failed", res.status, await res.text().catch(() => ""));
    }
  } catch (err) {
    console.error("sendViaResend failed", err);
  }
}

function customerEmailHtml(input: QuoteEmailInput): string {
  const productLine = input.productUrl
    ? `<a href="${escapeHtml(input.productUrl)}">${escapeHtml(input.productName)}</a>`
    : escapeHtml(input.productName);
  return `
    <p>Hi ${escapeHtml(input.fullName.split(" ")[0] ?? input.fullName)},</p>
    <p>Thanks for your interest, this confirms we've received your quote request.</p>
    <p>
      <strong>Reference:</strong> ${escapeHtml(input.reference)}<br/>
      <strong>Item:</strong> ${input.quantity} × ${productLine}
    </p>
    <p>Someone from the Comfortel team will follow up shortly with pricing, lead time and freight.</p>
    <p>— Comfortel</p>
  `.trim();
}

function salesEmailHtml(input: QuoteEmailInput): string {
  return `
    <p>New quote request via WhatsApp.</p>
    <p>
      <strong>Reference:</strong> ${escapeHtml(input.reference)}<br/>
      <strong>Item:</strong> ${input.quantity} × ${escapeHtml(input.productName)}<br/>
      <strong>Name:</strong> ${escapeHtml(input.fullName)}<br/>
      <strong>Email(s):</strong> ${input.emails.map(escapeHtml).join(", ")}
      ${input.businessName ? `<br/><strong>Business:</strong> ${escapeHtml(input.businessName)}` : ""}
    </p>
  `.trim();
}

export async function sendQuoteEmails(input: QuoteEmailInput): Promise<void> {
  if (input.emails.length) {
    await sendViaResend({
      to: input.emails,
      subject: `Your Comfortel quote request (${input.reference})`,
      html: customerEmailHtml(input),
    });
  }

  const salesAddress = process.env["SALES_NOTIFICATION_EMAIL"];
  if (!salesAddress) {
    console.error(
      "sendQuoteEmails: SALES_NOTIFICATION_EMAIL not configured, skipping sales notice",
    );
    return;
  }
  await sendViaResend({
    to: [salesAddress],
    subject: `New quote request: ${input.productName} (${input.reference})`,
    html: salesEmailHtml(input),
  });
}
