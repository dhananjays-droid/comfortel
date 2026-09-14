import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const m = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), readProducts: vi.fn() }));
vi.mock("@/lib/managed-catalog.server", () => ({ productDb: m, readProducts: m.readProducts }));
import { handleProductAdmin } from "@/lib/product-admin.server";
import { managedProductSchema } from "@/lib/product-management";
import raw from "@/data/catalog-full.json";
const p = Object.values(raw)[0]!;
const product = managedProductSchema
  .innerType()
  .strip()
  .parse({
    ...p,
    currency: "USD",
    source_image_link: p.images[0],
    updated_image_link: p.images[0],
    archived: false,
    visualizable: true,
    chat_summary: "Description",
    colour: "white",
  });
const request = (body: unknown, token = "test-admin") =>
  new Request("https://app.example/api/admin/products", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CRON_SECRET", "test-admin");
});
afterEach(() => vi.unstubAllEnvs());
describe("product administration boundary", () => {
  it("rejects unauthenticated writes before touching storage", async () => {
    expect((await handleProductAdmin(request({ action: "save" }, "wrong"))).status).toBe(401);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("rejects invalid prices before touching storage", async () => {
    expect(
      (
        await handleProductAdmin(
          request({ action: "save", revision: 1, product: { ...product, price: -1 } }),
        )
      ).status,
    ).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("sends the revision to the atomic write RPC", async () => {
    m.rpc.mockResolvedValue({ data: { id: p.id }, error: null });
    expect(
      (await handleProductAdmin(request({ action: "save", revision: 1, product }))).status,
    ).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("save_managed_product", {
      p_product: product,
      p_expected_revision: 1,
    });
  });
  it("returns a conflict without overwriting a concurrent staff edit", async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: "PT409" } });
    expect(
      (await handleProductAdmin(request({ action: "save", revision: 1, product }))).status,
    ).toBe(409);
  });
  it("returns a useful error for malformed JSON", async () => {
    expect(
      (
        await handleProductAdmin(
          new Request("https://app.example", {
            method: "POST",
            headers: { authorization: "Bearer test-admin" },
            body: "{",
          }),
        )
      ).status,
    ).toBe(400);
  });
});
