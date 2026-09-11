# WhatsApp PDF estimates and product comparisons

Implemented September 11, 2026. WhatsApp only; the customer webapp and existing enquiry intake remain unchanged.

## What was missing

- The old Get a quote action created enquiries but did not create a downloadable document.
- The outbound WhatsApp client supported text, images and interactive messages, not document attachments.
- The saved product catalog is enough for a useful estimate and factual comparison, but is not a live inventory, freight or tax service.

## Customer journey

1. Browse products or create a salon plan. Shortlists offer PDF estimate, plus Compare products when there are 2–3 items. Completed room renders also offer PDF estimate and preserve their quantities.
2. Type **PDF quote** for the saved plan, or **PDF quote for 4 Chloe Tan and 2 Blake Textured Black** for an explicit selection. Exact product IDs also work. Separate products with “and”, “vs” or commas. An unrecognised or ambiguous selection asks for clarification instead of omitting products or guessing quantities.
3. Receive a PDF directly in WhatsApp: photos, product names/SKUs, quantities, unit prices, line totals, USD furniture subtotal, clickable product pages, document reference and preparation date. Freight, taxes, duties and installation are explicitly excluded, not shown as zero.
4. Tap **Request final quote**. Products, quantities and the estimate reference are copied into a draft sales request. Add delivery postcode/country and any options, review the request, then submit it to the existing admin inbox. Nothing is booked, charged or ordered automatically.
5. For comparisons, type **Compare Chloe Tan and Blake Textured Black**, use **Compare my plan** for a 2–3-product plan, or tap Compare products. The PDF shows unit prices, finishes and available specification fields side by side, with product links and a short price/fit summary. Missing fields are identified, not inferred from photos. A follow-up offers a PDF estimate or staff help.

An estimate without explicitly supplied quantities uses saved plan quantities for matching products, otherwise one of each. Every quantity is visible in the PDF. Generating documents does not alter the plan or render state. The existing Get a quote contact/email intake remains available.

## Data and document safeguards

- Product source: `src/data/catalog-full.json`, exposed through `src/lib/catalog.ts`. Prices are a saved-catalog snapshot; the preparation date does not imply prices were refreshed that day.
- Photos are fetched only from HTTPS uploads on comfortelfurniture.com, with redirect rejection, byte/pixel limits and a six-second timeout. Missing images fall back to a labelled placeholder.
- No LLM generates prices, specifications, totals or comparative claims. Currency arithmetic uses integer cents.
- Exact specification labels are used. Shipping weights and carton measurements are never substituted for load capacity or installed dimensions. Fields missing for all selected products are summarised below the table.
- Limit: 1–10 quote lines, quantities 1–99, or 2–3 comparison products. Longer PDFs paginate. PDF attachments are capped at 10 MB by this application.
- Node/Vercel-compatible `pdf-lib` generates PDFs in memory; `sharp` prepares catalog photos. No browser, Python server or extra paid document service is required.
- PDFs contain product selections and a reference, not customer names, phone numbers or email addresses. They are uploaded directly to Meta's media endpoint, not a public Supabase bucket.
- Existing inbound queue/idempotency and delivery-status callbacks apply. Outbound logs store filename, caption and reference, never PDF bytes. Immediate attachment failures stop the follow-up CTA and return a retry message.
- WhatsApp attachments use the existing messaging token and phone-number configuration; no catalog approval or database migration is required.

## Files and validation

- Pure data/matching: `src/lib/commerce-documents.ts`
- PDF layout and image handling: `src/lib/commerce-pdf.server.ts`
- WhatsApp document routing: `src/lib/wa-documents.server.ts`
- Transport and integration: `wa-client.server.ts`, `wa-webhook.server.ts`, `wa-runtime.ts`, `wa-render-worker.server.ts`, `wa-requests.server.ts`
- Tests: commerce-documents, wa-documents, existing runtime/render/request suites.
- Reproduce sample artifacts: `PDF_SAMPLES=1 npx vitest run src/lib/__tests__/commerce-documents.test.ts`. Output: ignored `output/pdf/comfortel-sample-quote.pdf` and `comfortel-sample-comparison.pdf`. Samples use public product photos and no customer data. Render and visually inspect before sharing a changed layout.

## Remaining business inputs

For a binding quote or a guaranteed landed total, connect approved live pricing/options, destination-based freight/tax calculations, stock availability and staff-approved commercial terms. Those are not available in the saved JSON and must not be invented. This implementation intentionally produces a budget estimate and routes the final confirmation to staff.

## Technical references

- [Meta document message format](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/messages/document/) — data format only; the archived SDK is not used.
- [Meta WhatsApp Business Platform collection](https://www.postman.com/meta/whatsapp-business-platform/overview/)
- [pdf-lib documentation](https://pdf-lib.js.org/docs/api/classes/pdfdocument)
