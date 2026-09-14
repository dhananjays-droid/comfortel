import { z } from "zod";
import type { FullProduct, SlimProduct } from "@/lib/catalog";

const publicUrl = z
  .string()
  .url()
  .refine((value) => {
    try {
      const u = new URL(value);
      return (
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        !/^(localhost|0\.|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|\[)/i.test(
          u.hostname,
        )
      );
    } catch {
      return false;
    }
  }, "Use a public HTTPS URL without credentials");
const optionalUrl = z.union([publicUrl, z.literal("")]);
export const managedProductSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    name: z.string().trim().min(2).max(200),
    price: z.number().finite().nonnegative().max(1000000).nullable(),
    mrp: z.number().finite().nonnegative().max(1000000).nullable(),
    url: publicUrl,
    images: z.array(publicUrl).max(20),
    description: z.string().max(10000).nullable(),
    specs: z.record(z.string().max(100), z.string().max(2000)).nullable(),
    dims_cm: z
      .object({
        w: z.number().positive().nullable(),
        d: z.number().positive().nullable(),
        h: z.number().positive().nullable(),
      })
      .nullable(),
    placement: z.string().max(200).nullable(),
    in_stock: z.boolean(),
    category: z.string().max(200).nullable(),
    sku: z.string().max(100).nullable(),
    product_type: z.string().max(200).nullable(),
    is_component: z.boolean(),
    delivery_date: z.string().max(200).nullable(),
    salon_placement: z.string().max(200).nullable(),
    replaces: z.string().max(200).nullable(),
    source_image_link: optionalUrl,
    updated_image_link: optionalUrl,
    archived: z.boolean(),
    visualizable: z.boolean(),
    currency: z.literal("USD"),
    chat_summary: z.string().max(500),
    colour: z.string().max(200),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.price !== null && Math.abs(p.price * 100 - Math.round(p.price * 100)) > 0.00001)
      ctx.addIssue({
        code: "custom",
        path: ["price"],
        message: "Price must have at most two decimal places",
      });
    if (!p.archived && !p.updated_image_link)
      ctx.addIssue({
        code: "custom",
        path: ["updated_image_link"],
        message: "An image is required for an active product",
      });
  });
export type ManagedProduct = z.infer<typeof managedProductSchema>;
export type ProductRow = {
  id: string;
  product: ManagedProduct;
  revision: number;
  updated_at: string;
};
export type CatalogSnapshot = {
  full: Record<string, FullProduct>;
  slim: SlimProduct[];
  byId: Record<string, SlimProduct>;
};
export function productSnapshot(rows: ProductRow[]): CatalogSnapshot {
  const full: Record<string, FullProduct> = {},
    slim: SlimProduct[] = [];
  for (const { product: p } of rows) {
    if (p.archived) continue;
    full[p.id] = {
      ...p,
      images: [p.updated_image_link, ...p.images.filter((x) => x !== p.updated_image_link)].filter(
        Boolean,
      ),
    };
    slim.push({
      id: p.id,
      n: p.name,
      c: p.category ?? "",
      p: p.price,
      col: p.colour,
      d: p.chat_summary,
      v: p.visualizable ? 1 : 0,
      available: p.in_stock,
    });
  }
  return { full, slim, byId: Object.fromEntries(slim.map((p) => [p.id, p])) };
}
export function metaProduct(p: ManagedProduct) {
  if (p.price === null || p.price <= 0 || !p.updated_image_link)
    throw new Error("Meta requires a positive price and product image");
  return {
    retailer_id: p.id,
    name: p.name,
    description: (p.description?.trim() || p.chat_summary.trim() || p.name).slice(0, 9999),
    price: Math.round(p.price * 100),
    currency: p.currency,
    url: p.url,
    image_url: p.updated_image_link,
    additional_image_urls: p.images.filter((x) => x !== p.updated_image_link).slice(0, 9),
    brand: "Comfortel",
    condition: "new",
    availability: p.archived || !p.in_stock ? "out of stock" : "in stock",
  };
}

export const cartSchema = z.object({
  catalog_id: z.string().regex(/^\d+$/),
  text: z.string().max(4000).optional(),
  product_items: z
    .array(
      z.object({
        product_retailer_id: z.string().max(100),
        quantity: z.number().int().min(1).max(999),
        item_price: z
          .union([
            z.string().regex(/^\d+(?:\.\d{1,2})?$/),
            z.number().finite().nonnegative().max(1000000),
          ])
          .refine(
            (v) =>
              Number.isFinite(Number(v)) &&
              Number(v) <= 1000000 &&
              Math.abs(Number(v) * 100 - Math.round(Number(v) * 100)) < 0.00001,
            "Invalid price",
          ),
        currency: z.string().regex(/^[A-Z]{3}$/),
      }),
    )
    .min(1)
    .max(100),
});
export type CatalogCart = z.infer<typeof cartSchema>;
