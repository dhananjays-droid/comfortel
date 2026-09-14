import { createHash } from "node:crypto";
import { productDb } from "@/lib/managed-catalog.server";
import { encryptPhone } from "@/lib/wa-phone-crypto.server";
import { cartSchema, type CatalogCart, type ProductRow } from "@/lib/product-management";
import type { WaTurn } from "@/lib/wa-runtime";
export async function catalogTurn(): Promise<WaTurn> {
  const { data, error } = await productDb
    .from("catalog_settings")
    .select("*")
    .eq("id", true)
    .single();
  return !error && data?.enabled && data.catalog_id
    ? {
        kind: "catalog",
        text: "Browse our products, choose quantities and send your cart here. Our team will help with delivery and the next steps—sending a cart does not confirm an order.",
      }
    : {
        kind: "text",
        text: "Our WhatsApp catalog is not available yet. Tell me what you’re looking for and I’ll show you the options here.",
      };
}
export async function receiveCatalogCart(input: {
  sessionKey: string;
  phone: string;
  waMessageId: string;
  cart: CatalogCart;
}): Promise<WaTurn[]> {
  const cart = cartSchema.parse(input.cart);
  const { data: settings, error } = await productDb
    .from("catalog_settings")
    .select("*")
    .eq("id", true)
    .single();
  if (error) throw new Error("Catalog lookup unavailable");
  if (!settings?.catalog_id || cart.catalog_id !== settings.catalog_id)
    return [
      {
        kind: "text",
        text: "I couldn’t match this cart to our catalog. Please open our current catalog and send your selection again.",
      },
    ];
  const reference = `CF-${createHash("sha256").update(`${input.sessionKey}:cart:${input.waMessageId}`).digest("hex").slice(0, 16).toUpperCase()}`;
  const { data: existing, error: readError } = await productDb
    .from("wa_requests")
    .select("reference")
    .eq("reference", reference)
    .maybeSingle();
  if (readError) throw new Error("Request lookup unavailable");
  const turns: WaTurn[] = [
    {
      kind: "buttons",
      text: `Thanks! We’ve received your selection. Reference: ${reference}. Our team will help with delivery and the next steps. Your order isn’t confirmed yet.`,
      action: {
        kind: "buttons",
        buttons: [
          { id: "request:status", title: "Request status" },
          { id: "nav:menu", title: "Main menu" },
        ],
      },
    },
  ];
  if (existing) return turns;
  const { data: rows, error: productError } = await productDb
    .from("managed_products")
    .select("*")
    .in(
      "id",
      cart.product_items.map((p) => p.product_retailer_id),
    );
  if (productError) throw new Error("Products unavailable");
  const products = new Map((rows as ProductRow[]).map((r) => [r.id, r]));
  const lines = cart.product_items.map((line) => {
    const row = products.get(line.product_retailer_id),
      p = row?.product;
    const submittedPrice = Number(line.item_price);
    return {
      ...line,
      item_price: submittedPrice,
      name: p?.name ?? `Unknown product ${line.product_retailer_id}`,
      current_price: p?.price ?? null,
      revision: row?.revision ?? null,
      needs_review:
        !p ||
        p.archived ||
        !p.in_stock ||
        line.currency !== p.currency ||
        p.price !== submittedPrice,
    };
  });
  const summary = lines
    .map(
      (p) =>
        `${p.quantity} × ${p.name} — ${p.currency} ${p.item_price.toFixed(2)} each${p.needs_review ? " [STAFF REVIEW: price, availability or product mismatch]" : ""}`,
    )
    .join("\n");
  const { error: saveError } = await productDb
    .from("wa_requests")
    .insert({
      reference,
      session_key: input.sessionKey,
      source_message_id: input.waMessageId,
      last_inbound_id: input.waMessageId,
      category: "sales",
      status: "open",
      stage: "confirm",
      customer_phone_enc: encryptPhone(input.phone),
      last_reply: turns,
      details: [
        {
          messageId: input.waMessageId,
          text: `WhatsApp catalog cart\n${summary}${cart.text ? `\nCustomer note: ${cart.text}` : ""}`,
          catalog_id: cart.catalog_id,
          items: lines,
        },
      ],
    });
  if (saveError) {
    if (saveError.code !== "23505") throw new Error("Cart request could not be saved");
    const { data: committed, error: confirmError } = await productDb
      .from("wa_requests")
      .select("reference")
      .eq("reference", reference)
      .maybeSingle();
    if (confirmError || !committed) throw new Error("Cart request could not be confirmed");
  }
  return turns;
}
