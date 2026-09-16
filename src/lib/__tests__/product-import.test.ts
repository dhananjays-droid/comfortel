import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  readProducts: vi.fn(),
  mirror: vi.fn(),
}));
vi.mock("@/lib/managed-catalog.server", () => ({ productDb: m, readProducts: m.readProducts }));
vi.mock("@/lib/asset-cdn.server", () => ({
  mirrorImageToCdn: m.mirror,
  isCdnUrl: (u: string) => u.startsWith("https://web-assets.quickads.ai/"),
}));
import { handleProductAdmin } from "@/lib/product-admin.server";
import { managedProductSchema, type ManagedProduct } from "@/lib/product-management";
import raw from "@/data/catalog-full.json";

const base = Object.values(raw)[0]!;
const product = (over: Partial<ManagedProduct> = {}): ManagedProduct =>
  managedProductSchema
    .innerType()
    .strip()
    .parse({
      ...base,
      currency: "USD",
      source_image_link: base.images[0],
      updated_image_link: base.images[0],
      images: base.images.slice(0, 2),
      archived: false,
      visualizable: true,
      chat_summary: "Description",
      colour: "white",
      ...over,
    });
const request = (body: unknown) =>
  new Request("https://app.example/api/admin/products", {
    method: "POST",
    headers: { authorization: "Bearer test-admin" },
    body: JSON.stringify(body),
  });
const CDN = "https://web-assets.quickads.ai/public-assets/mirrored/img.jpg";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CRON_SECRET", "test-admin");
  m.readProducts.mockResolvedValue([]);
  m.mirror.mockResolvedValue(CDN);
  m.rpc.mockResolvedValue({ data: {}, error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("CSV import action", () => {
  it("adds an unknown product at revision 0 and updates a known one at its current revision", async () => {
    const known = product();
    m.readProducts.mockResolvedValue([
      { id: known.id, product: known, revision: 7, updated_at: "2026-09-16T00:00:00Z" },
    ]);
    const fresh = product({ id: "brand-new-1", name: "Brand new" });
    const res = await handleProductAdmin(request({ action: "import", products: [known, fresh] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([
      { id: known.id, status: "updated" },
      { id: "brand-new-1", status: "added" },
    ]);
    const revisions = m.rpc.mock.calls.map((c) => c[1].p_expected_revision);
    expect(revisions).toEqual([7, 0]);
  });
  it("mirrors non-CDN images to the bucket and stores the CDN URL, keeping the original as source", async () => {
    const p = product();
    await handleProductAdmin(request({ action: "import", products: [p] }));
    const saved = m.rpc.mock.calls[0]![1].p_product as ManagedProduct;
    expect(saved.updated_image_link).toBe(CDN);
    expect(saved.source_image_link).toBe(p.source_image_link);
    expect(saved.images.every((u) => u === CDN)).toBe(true);
    expect(m.mirror).toHaveBeenCalledWith(p.updated_image_link);
  });
  it("does not re-upload an image that is already on the CDN", async () => {
    const p = product({ updated_image_link: CDN, images: [CDN] });
    await handleProductAdmin(request({ action: "import", products: [p] }));
    expect(m.mirror).not.toHaveBeenCalled();
  });
  it("reports a failed row and still applies the others", async () => {
    m.rpc
      .mockResolvedValueOnce({ data: null, error: { code: "PT409" } })
      .mockResolvedValueOnce({ data: {}, error: null });
    const res = await handleProductAdmin(
      request({ action: "import", products: [product({ id: "a1" }), product({ id: "a2" })] }),
    );
    const body = await res.json();
    expect(body.results[0]).toMatchObject({ id: "a1", status: "failed" });
    expect(body.results[0].error).toMatch(/edited|reload/i);
    expect(body.results[1]).toEqual({ id: "a2", status: "added" });
  });
  it("treats a mirroring failure as that row failing, not the import", async () => {
    m.mirror.mockRejectedValueOnce(new Error("source 404"));
    const res = await handleProductAdmin(
      request({ action: "import", products: [product({ id: "a1" })] }),
    );
    const body = await res.json();
    expect(body.results[0]).toMatchObject({ id: "a1", status: "failed" });
    expect(body.results[0].error).toMatch(/image/i);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("rejects an invalid product before touching storage", async () => {
    const res = await handleProductAdmin(
      request({ action: "import", products: [{ ...product(), price: -3 }] }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].status).toBe("failed");
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("caps a chunk at 25 products", async () => {
    const many = Array.from({ length: 26 }, (_, i) => product({ id: `p-${i}` }));
    expect((await handleProductAdmin(request({ action: "import", products: many }))).status).toBe(
      400,
    );
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("never deletes: products absent from the import are not touched", async () => {
    m.readProducts.mockResolvedValue([
      { id: "keep-me", product: product({ id: "keep-me" }), revision: 1, updated_at: "" },
    ]);
    await handleProductAdmin(request({ action: "import", products: [product({ id: "new-9" })] }));
    expect(m.rpc.mock.calls.map((c) => c[1].p_product.id)).toEqual(["new-9"]);
    expect(m.from).not.toHaveBeenCalled();
  });
});
