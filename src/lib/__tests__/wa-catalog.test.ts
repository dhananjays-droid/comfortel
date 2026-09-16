import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ from: vi.fn(), insert: vi.fn(), reads: [] as unknown[] }));
vi.mock("@/lib/managed-catalog.server", () => ({ productDb: { from: m.from } }));
vi.mock("@/lib/wa-phone-crypto.server", () => ({ encryptPhone: () => "encrypted-phone" }));
import { receiveCatalogCart, catalogTurn } from "@/lib/wa-catalog.server";
const input = {
  sessionKey: "customer",
  phone: "123",
  waMessageId: "wamid.cart",
  cart: {
    catalog_id: "123",
    product_items: [
      { product_retailer_id: "chair", quantity: 2, item_price: "12.50", currency: "USD" },
    ],
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  m.reads = [];
  m.insert.mockResolvedValue({ error: null });
  m.from.mockImplementation((table: string) => {
    if (table === "catalog_settings")
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: { catalog_id: "123", enabled: true }, error: null }),
          }),
        }),
      };
    if (table === "managed_products")
      return {
        select: () => ({
          not: () => ({
            order: () => ({
              limit: async () => ({
                data: [
                  {
                    id: "chair",
                    meta_id: "meta-chair",
                    product: {
                      name: "Chair",
                      price: 15,
                      currency: "USD",
                      in_stock: true,
                      archived: false,
                      updated_image_link: "https://cdn.example.com/chair.jpg",
                    },
                  },
                ],
                error: null,
              }),
            }),
          }),
          in: async () => ({
            data: [
              {
                id: "chair",
                revision: 2,
                product: {
                  name: "Chair",
                  price: 15,
                  currency: "USD",
                  in_stock: true,
                  archived: false,
                },
              },
            ],
            error: null,
          }),
        }),
      };
    return {
      insert: m.insert,
      select: () => ({
        eq: () => ({ maybeSingle: async () => m.reads.shift() ?? { data: null, error: null } }),
      }),
    };
  });
});
describe("WhatsApp cart to staff lead", () => {
  it("opens the native catalog with honest order wording", async () =>
    expect(await catalogTurn()).toMatchObject({
      kind: "catalog",
      thumbnailProductRetailerId: "chair",
      text: expect.stringContaining("does not confirm an order"),
    }));
  it("saves the submitted price and flags a changed master price", async () => {
    const reply = await receiveCatalogCart(input),
      saved = m.insert.mock.calls[0]![0];
    expect(saved).toMatchObject({
      category: "sales",
      status: "open",
      customer_phone_enc: "encrypted-phone",
    });
    expect(saved.details[0].items[0]).toMatchObject({
      item_price: 12.5,
      current_price: 15,
      quantity: 2,
      needs_review: true,
    });
    expect(reply[0]).toMatchObject({
      kind: "buttons",
      text: expect.stringContaining("isn’t confirmed"),
    });
  });
  it("replays a duplicate cart without creating a second lead", async () => {
    m.reads.push({ data: { reference: "existing" }, error: null });
    await receiveCatalogCart(input);
    expect(m.insert).not.toHaveBeenCalled();
  });
  it("does not claim receipt when the database rejects the lead", async () => {
    m.insert.mockResolvedValue({ error: { code: "500" } });
    await expect(receiveCatalogCart(input)).rejects.toThrow("could not be saved");
  });
  it("verifies a committed lead after a unique-conflict response", async () => {
    m.insert.mockResolvedValue({ error: { code: "23505" } });
    await expect(receiveCatalogCart(input)).rejects.toThrow("could not be confirmed");
  });
  it("rejects a cart from a different catalog", async () => {
    const reply = await receiveCatalogCart({
      ...input,
      cart: { ...input.cart, catalog_id: "456" },
    });
    expect(reply[0]).toMatchObject({ text: expect.stringContaining("couldn’t match") });
    expect(m.insert).not.toHaveBeenCalled();
  });
});
