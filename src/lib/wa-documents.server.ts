import { createHash } from "node:crypto";
import type { InboundEvent, WaTurn } from "@/lib/wa-runtime";
import type { SessionState } from "@/lib/wa-session";
import {
  documentLines,
  comparisonSummary,
  productSpec,
  resolveDocumentSelection,
  type CommerceDocument,
} from "@/lib/commerce-documents";
import { buildCommercePdf } from "@/lib/commerce-pdf.server";
import { requestIntent } from "@/lib/wa-requests";
import { CATALOG_FULL } from "@/lib/catalog";

export async function handleDocumentInbound(
  session: SessionState,
  event: InboundEvent,
  messageId: string,
): Promise<WaTurn[] | null> {
  const button = event.kind === "button" ? event.id : "";
  const text = event.kind === "text" ? event.text.trim() : "";
  // A complaint/order/support action takes priority over incidental words
  // such as "compare" in the customer's description.
  if (text && requestIntent(text)) return null;
  if (
    session.lastDocument?.kind === "comparison" &&
    /^(?:which (?:one )?is (?:cheaper|wider)|which costs less)[?! .]*$/i.test(text)
  ) {
    const lines = documentLines(session.lastDocument.ids);
    return [
      {
        kind: "text",
        text: /wider/i.test(text)
          ? lines
              .map(
                (line) =>
                  `${line.product.name}: overall width ${productSpec(line.product, ["Total Width", "Full Width", "Chair width", "Width"])}; seat width ${productSpec(line.product, ["Seat Width", "Internal Seat Width"])}.`,
              )
              .join("\n")
          : comparisonSummary(lines),
      },
    ];
  }
  const quantityEdit = text.match(
    /\b(?:quantity|change|make|update)\b.*?\b(\d{1,2})\s+(chairs?|mirrors?|trolleys?|desks?)\b/i,
  );
  if (quantityEdit && session.lastDocument?.kind === "quote") {
    const qty = Number(quantityEdit[1]);
    const category = quantityEdit[2]!.replace(/s$/i, "");
    const matches = session.lastDocument.ids.filter((id) =>
      new RegExp(`\\b${category}s?\\b`, "i").test(CATALOG_FULL[id]?.name ?? ""),
    );
    if (qty < 1 || qty > 99)
      return [{ kind: "text", text: "Please choose a quantity between 1 and 99." }];
    if (matches.length !== 1)
      return [
        {
          kind: "text",
          text: "Which exact product should I change? Please include its model and finish so I don’t update the wrong item.",
        },
      ];
    const id = matches[0]!;
    session.lastDocument = {
      ...session.lastDocument,
      qty: { ...session.lastDocument.qty, [id]: qty },
    };
    return [
      {
        kind: "buttons",
        text: `Updated your estimate to ${qty} × ${CATALOG_FULL[id]!.name}. The other quantities are unchanged. This does not place or change an order.`,
        action: {
          kind: "buttons",
          buttons: [
            {
              id: `docs:quote:${session.lastDocument.ids.join(",")}:${session.lastDocument.ids.map((id) => session.lastDocument!.qty[id] ?? 1).join(",")}`,
              title: "Updated PDF",
            },
            { id: "nav:menu", title: "Main menu" },
          ],
        },
      },
    ];
  }
  if (/\b(catalog|catalogue)\b/i.test(text) && /\b(pdf|download|print)\b/i.test(text))
    return [
      {
        kind: "buttons",
        text: "I can make a focused PDF estimate or comparison for the products you choose. I don’t have a complete catalog PDF to send. Which would help?",
        action: {
          kind: "buttons",
          buttons: [
            { id: "docs:quote:", title: "PDF estimate" },
            { id: "ask", title: "Find products" },
          ],
        },
      },
    ];
  const compare =
    button.startsWith("docs:compare:") || /\b(compare|comparison|versus)\b|\bvs\.?\s/i.test(text);
  const quote =
    button.startsWith("docs:quote:") ||
    /\b(pdf|download|print|itemi[sz]ed)\b.*\b(quote|estimate|quotation)\b|\b(quote|estimate|quotation)\b.*\b(pdf|download|print)\b/i.test(
      text,
    );
  if (!compare && !quote) return null;
  if (compare && quote)
    return [
      {
        kind: "text",
        text: "Would you like a product comparison or an itemised estimate first? Send 'Compare' with 2 or 3 product names, or 'PDF quote' for your saved plan.",
      },
    ];
  const kind = compare ? "comparison" : "quote";
  const selection = resolveDocumentSelection(text);
  let ids = button.startsWith("docs:")
    ? (button.split(":")[2]?.split(",").filter(Boolean) ?? [])
    : selection.ids;
  if (
    !ids.length &&
    /\b(that|those|same|again|updated|previous|resend)\b/i.test(text) &&
    session.lastDocument?.kind === kind
  )
    ids = session.lastDocument.ids;
  if (!ids.length && compare && /\b(these|them|those|that)\b/i.test(text))
    ids = session.shownProductIds ?? [];
  // Only use the plan when no specific products were named. Never silently
  // replace an unrecognised named product with an unrelated plan.
  if (
    !ids.length &&
    /^(?:please\s+)?(?:(?:send|give|make|create|download|print)(?:\s+me)?\s+)?(?:a\s+|my\s+|the\s+)?(?:pdf\s+(?:quote|estimate)|(?:quote|estimate)\s+pdf|compare\s+my plan)(?:\s+please)?[.!?]*$/i.test(
      text,
    )
  )
    ids = session.plan.ids;
  if (!ids.length)
    return [
      {
        kind: "text",
        text: compare
          ? "Which 2 or 3 products would you like to compare? Include the finish, for example: 'Compare Chloe Tan and Blake Textured Black'. You can also tap Compare products below a shortlist."
          : "Which products should the PDF include? Type 'PDF quote' to use your current plan, or include the exact product names and finishes. If your plan is empty, choose some products first.",
      },
    ];
  if (compare && (ids.length < 2 || ids.length > 3))
    return [
      {
        kind: "text",
        text: "Please choose 2 or 3 exact products so the comparison stays useful. Include the model and finish, or use the Compare products button on a shortlist.",
      },
    ];
  if (quote && ids.length > 10)
    return [
      {
        kind: "text",
        text: "I can include up to 10 different products in one PDF estimate. Please choose a smaller selection, or ask our team for a larger project quote.",
      },
    ];
  try {
    const buttonQty = button.split(":")[3]?.split(",");
    if (buttonQty && buttonQty.length !== ids.length) throw new Error("Invalid quote quantities");
    const quantities = buttonQty
      ? Object.fromEntries(ids.map((id, i) => [id, Number(buttonQty[i])]))
      : {
          ...session.plan.qty,
          ...(session.lastDocument?.kind === kind ? session.lastDocument.qty : {}),
          ...selection.quantities,
        };
    const lines = documentLines(ids, kind === "quote" ? quantities : {});
    const reference = `${quote ? "CQ" : "CC"}-${createHash("sha256").update(messageId).digest("hex").slice(0, 10).toUpperCase()}`;
    const data: CommerceDocument = {
      kind,
      reference,
      issuedAt: new Date().toISOString().slice(0, 10),
      lines,
    };
    const bytes = await buildCommercePdf(data);
    session.lastDocument = {
      kind,
      ids: lines.map((line) => line.product.id),
      qty: Object.fromEntries(lines.map((line) => [line.product.id, line.qty])),
    };
    const caption = quote
      ? "Your itemised furniture estimate is attached. It includes your selected quantities and product links; freight, taxes and current availability still need confirmation."
      : `Your side-by-side comparison is attached. ${comparisonSummary(lines)}`;
    return [
      {
        kind: "document",
        bytes,
        filename: `Comfortel-${kind}-${reference}.pdf`,
        caption,
        reference,
      },
      {
        kind: "buttons",
        text: quote
          ? "Would you like our team to confirm delivery?"
          : "Ready to take the next step?",
        action: {
          kind: "buttons",
          buttons: quote
            ? [
                {
                  id: `request:sales:quote:${ids.join(",")}:${lines.map((l) => l.qty).join(",")}:${reference}`,
                  title: "Confirm delivery",
                },
              ]
            : [
                { id: `docs:quote:${ids.join(",")}`, title: "PDF estimate" },
                { id: "request:sales", title: "Ask our team" },
              ],
        },
      },
    ];
  } catch (error) {
    console.error(
      "WhatsApp document generation failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return [
      {
        kind: "text",
        text: "Sorry, I couldn't create that PDF just now. Your plan hasn't changed. Please try again, or type 'sales request' for help from our team.",
      },
    ];
  }
}
