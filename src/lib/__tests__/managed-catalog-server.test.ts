import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOG_FULL, CATALOG_SLIM } from "@/lib/catalog";
import { managedProductSchema, type ProductRow } from "@/lib/product-management";
import raw from "@/data/catalog-full.json";
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: mocks }));
import { withManagedCatalog } from "@/lib/managed-catalog.server";
import { runProductSync, handleProductSync } from "@/lib/product-sync.server";
const value = Object.values(raw)[0]!;
const product = managedProductSchema
  .innerType()
  .strip()
  .parse({
    ...value,
    source_image_link: value.images[0],
    updated_image_link: value.images[0],
    archived: false,
    visualizable: true,
    currency: "USD",
    chat_summary: "Summary",
    colour: "White",
  });
const row: ProductRow = { id: product.id, product, revision: 1, updated_at: "" };
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("MANAGED_CATALOG_ENABLED", "true");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("request-scoped product snapshots", () => {
  it("isolates concurrent chats and leaves static web catalog unchanged", async () => {
    let index = 0;
    mocks.from.mockImplementation(() => ({
      select: () => ({
        order: () => ({
          range: async () => ({
            data: [{ ...row, product: { ...product, price: ++index } }],
            error: null,
          }),
        }),
      }),
    }));
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const a = withManagedCatalog(async () => {
      await gate;
      return CATALOG_FULL[product.id]?.price;
    });
    const b = withManagedCatalog(async () => {
      release();
      return CATALOG_SLIM[0]?.p;
    });
    expect(await Promise.all([a, b])).toEqual([1, 2]);
    expect(CATALOG_FULL[product.id]?.price).toBe(value.price);
  });
  it("fails closed instead of serving stale prices on database failure", async () => {
    mocks.from.mockReturnValue({
      select: () => ({
        order: () => ({ range: async () => ({ data: null, error: { message: "offline" } }) }),
      }),
    });
    const work = vi.fn();
    await expect(withManagedCatalog(work)).rejects.toThrow("unavailable");
    expect(work).not.toHaveBeenCalled();
  });
});
describe("retryable Meta sync", () => {
  function setup(p = product) {
    vi.stubEnv("META_CATALOG_ACCESS_TOKEN", "test-token");
    mocks.from.mockImplementation((table: string) => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data:
              table === "catalog_settings"
                ? { enabled: false, sync_enabled: true, catalog_id: "123" }
                : { ...row, product: p },
            error: null,
          }),
        }),
      }),
    }));
    mocks.rpc.mockImplementation(async (name: string) => ({
      data:
        name === "claim_product_sync"
          ? [{ product_id: product.id, lease_id: "lease", desired_revision: 1, meta_id: null }]
          : null,
      error: null,
    }));
  }
  it("publishes a stable retailer ID and acknowledges only a confirmed provider result", async () => {
    setup({ ...product, price: 123.45, description: "Description" });
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: "meta-product" }));
    vi.stubGlobal("fetch", fetch);
    expect(await runProductSync()).toMatchObject({ synced: 1, failed: 0 });
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({
      price: 12345,
      retailer_id: product.id,
      allow_upsert: true,
    });
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      "finish_product_sync",
      expect.objectContaining({ p_lease: "lease", p_meta_id: "meta-product", p_error: null }),
    );
  });
  it("records provider errors without marking the product synced or exposing the token", async () => {
    setup({ ...product, price: 12, description: "Description" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: { code: 190, message: "Invalid token test-token" } }, { status: 400 }),
        ),
    );
    expect(await runProductSync()).toMatchObject({ failed: 1, synced: 0 });
    const args = mocks.rpc.mock.calls.at(-1)![1];
    expect(args.p_error).toContain("190");
    expect(args.p_error).not.toContain("test-token");
  });
  it("does not create archived products", async () => {
    setup({ ...product, archived: true, price: null });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await runProductSync()).toMatchObject({ synced: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("leaves work unclaimed while the connection is disabled", async () => {
    setup();
    vi.stubEnv("META_CATALOG_ACCESS_TOKEN", "");
    expect(await runProductSync()).toMatchObject({ configured: false });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated scheduler requests without claiming work", async () => {
    vi.stubEnv("CRON_SECRET", "admin");
    vi.stubEnv("PRODUCT_SYNC_SECRET", "scheduler");
    expect((await handleProductSync(new Request("https://example.com"))).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("accepts the isolated scheduler credential without enabling the customer catalog", async () => {
    setup();
    vi.stubEnv("PRODUCT_SYNC_SECRET", "scheduler");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ id: "meta-product" })));
    const response = await handleProductSync(new Request("https://example.com", {
      method: "POST", headers: { authorization: "Bearer scheduler" },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ synced: 1 });
  });
});
