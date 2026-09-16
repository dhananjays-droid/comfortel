import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCdnUrl, mirrorImageToCdn } from "@/lib/asset-cdn.server";

const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (url.endsWith("/generate-presigned-url-multi-part"))
        return Response.json({
          files: [
            {
              upload_id: "u1",
              file_key: "public-assets/k/x.jpg",
              public_url: "https://web-assets.quickads.ai/public-assets/k/x.jpg",
              parts: [{ part_number: 1, url: "https://storage.example/part-1?sig" }],
            },
          ],
        });
      if (url.startsWith("https://storage.example/"))
        return new Response(null, { status: 200, headers: { etag: '"abc"' } });
      if (url.endsWith("/complete-multipart-upload")) return Response.json({ count: 1 });
      // the source image
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("mirrorImageToCdn", () => {
  it("leaves a URL that is already on the CDN untouched, with no network call", async () => {
    const url = "https://web-assets.quickads.ai/public-assets/a/b.jpg";
    expect(isCdnUrl(url)).toBe(true);
    expect(await mirrorImageToCdn(url)).toBe(url);
    expect(calls).toEqual([]);
  });
  it("downloads, uploads the part as octet-stream, completes, and returns the CDN URL", async () => {
    const out = await mirrorImageToCdn("https://comfortelfurniture.com/wp-content/uploads/x.jpg");
    expect(out).toBe("https://web-assets.quickads.ai/public-assets/k/x.jpg");
    const put = calls.find((c) => c.url.startsWith("https://storage.example/"))!;
    expect(put.init?.method).toBe("PUT");
    expect((put.init?.headers as Record<string, string>)["content-type"]).toBe(
      "application/octet-stream",
    );
    const complete = calls.find((c) => c.url.endsWith("/complete-multipart-upload"))!;
    expect(JSON.parse(String(complete.init?.body))).toEqual({
      files: [
        {
          file_key: "public-assets/k/x.jpg",
          upload_id: "u1",
          content_type: "image/jpeg",
          parts: [{ part_number: 1, etag: "abc" }],
        },
      ],
    });
  });
  it("fails loudly when the source cannot be fetched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    await expect(mirrorImageToCdn("https://comfortelfurniture.com/missing.jpg")).rejects.toThrow(
      /404/,
    );
  });
});
