import { afterEach, describe, expect, it } from "vitest";
import raw from "@/data/catalog-full.json";
import slim from "@/data/catalog-slim.json";
import { CATALOG_FULL, CATALOG_SLIM, setCatalogResolver, type FullProduct } from "@/lib/catalog";
import {
  managedProductSchema,
  metaProduct,
  cartSchema,
  productSnapshot,
  type ProductRow,
} from "@/lib/product-management";
import { withProductSpecifications } from "@/lib/product-specifications";
import { cdnFor } from "@/lib/cdn-assets";
const seed = Object.values(raw)
  .filter((p) => p.id !== "347812")
  .map((value) => {
    const p = withProductSpecifications(value as FullProduct),
      s = slim.find((s) => s.id === p.id);
    return {
      ...p,
      source_image_link: p.images[0] ?? "",
      updated_image_link: cdnFor(p.images[0] ?? "") ?? p.images[0] ?? "",
      currency: "USD",
      archived: false,
      visualizable: s?.v === 1,
      chat_summary: s?.d ?? "",
      colour: s?.col ?? "",
    };
  });
const product = () => managedProductSchema.innerType().strip().parse(seed[0]);
afterEach(() => setCatalogResolver(() => undefined));
describe("managed product source of truth", () => {
  it("retains all existing source facts and compact chat descriptions", () => {
    for (const p of seed) {
      expect(managedProductSchema.innerType().strip().safeParse(p).success, p.name).toBe(true);
      expect(p.chat_summary.length).toBeLessThanOrEqual(500);
    }
  });
  it("uses CDN image first and excludes archived products", () => {
    const p = product();
    p.updated_image_link = "https://cdn.example.com/a.jpg";
    const row: ProductRow = { id: p.id, revision: 1, updated_at: "", product: p };
    const snapshot = productSnapshot([
      row,
      { ...row, id: "archived", product: { ...p, id: "archived", archived: true } },
    ]);
    expect(snapshot.full[p.id]?.images[0]).toBe(p.updated_image_link);
    expect(snapshot.slim).toHaveLength(1);
    expect(snapshot.slim[0]?.d).toBe(p.chat_summary);
  });
  it("dynamic lookups and serialization use the same request snapshot", () => {
    const p = product(),
      snapshot = productSnapshot([{ id: p.id, product: p, revision: 1, updated_at: "" }]);
    setCatalogResolver(() => snapshot);
    expect(Object.keys(CATALOG_FULL)).toEqual([p.id]);
    expect(Object.values(CATALOG_FULL)[0]?.price).toBe(p.price);
    expect(JSON.parse(JSON.stringify(CATALOG_SLIM))).toEqual(snapshot.slim);
    expect(CATALOG_SLIM.filter(() => true)).toEqual(snapshot.slim);
  });
  it("rejects invalid URLs, fractional cents and missing active images", () => {
    for (const patch of [
      { url: "http://example.com" },
      { url: "https://localhost/foo" },
      { price: 10.123 },
      { updated_image_link: "" },
    ])
      expect(managedProductSchema.safeParse({ ...product(), ...patch }).success).toBe(false);
  });
  it("preserves cents, stable IDs, and CDN image in Meta payload", () => {
    const p = {
      ...product(),
      price: 123.45,
      description: "Test description",
      updated_image_link: "https://cdn.example.com/a.jpg",
    };
    expect(metaProduct(p)).toMatchObject({
      retailer_id: p.id,
      price: 12345,
      image_url: p.updated_image_link,
      currency: "USD",
    });
    expect(metaProduct({ ...p, in_stock: false }).availability).toBe("out of stock");
    expect(() => metaProduct({ ...p, price: null })).toThrow();
  });
});
describe("native WhatsApp carts", () => {
  const cart = {
    catalog_id: "123",
    product_items: [
      { product_retailer_id: "abc", quantity: 2, item_price: "12.50", currency: "USD" },
    ],
  };
  it("accepts normal Meta string prices", () => expect(cartSchema.parse(cart)).toEqual(cart));
  it.each([-1, 0, 1.5, 1000])("rejects invalid quantity %s", (quantity) =>
    expect(
      cartSchema.safeParse({ ...cart, product_items: [{ ...cart.product_items[0], quantity }] })
        .success,
    ).toBe(false),
  );
  it.each(["999999999999999999999999", "1e100", "12.345", 12.345, -2])(
    "rejects invalid amount %s",
    (item_price) =>
      expect(
        cartSchema.safeParse({ ...cart, product_items: [{ ...cart.product_items[0], item_price }] })
          .success,
      ).toBe(false),
  );
});
