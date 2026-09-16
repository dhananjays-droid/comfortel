/**
 * Puts an image on our own CDN and hands back the URL to use from then on.
 *
 * Why this exists: GPT Image 2 will not fetch comfortelfurniture.com URLs, and
 * every render used to pay ~16s re-uploading product photos to kie.ai's
 * temporary storage. The same bytes on web-assets.quickads.ai are fetched
 * without complaint, so a product's `updated_image_link` should always point
 * there. scripts/sync-cdn-assets.mjs did this once for the scraped catalogue;
 * this module does it for anything that arrives later through the product
 * editor or a CSV import.
 *
 * Three-step flow, learned by probing the API rather than from docs:
 *   1. presign  → upload_id, file_key, public_url and one part URL
 *   2. PUT the bytes to the part URL — as application/octet-stream. The part
 *      URL is signed for that type, NOT the content_type declared in step 1;
 *      sending the real type is a 403 SignatureDoesNotMatch.
 *   3. complete → the declared content_type is stamped on the object, which
 *      is why the CDN still serves it as image/jpeg.
 */

export const CDN_HOST = "web-assets.quickads.ai";

const API =
  process.env["QUICKADS_ASSETS_API"] ?? "https://dev-quickads.brandbooster.ai/api/v1/public-assets";
const API_HEADERS = {
  "content-type": "application/json",
  origin: "https://dev-app.quickads.ai",
  referer: "https://dev-app.quickads.ai/",
  accept: "*/*",
};
const TYPE_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

export function isCdnUrl(url: string): boolean {
  try {
    return new URL(url).hostname === CDN_HOST;
  } catch {
    return false;
  }
}

async function api<T>(route: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}/${route}`, {
    method: "POST",
    headers: API_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Asset API ${route} failed (${res.status})`);
  return (await res.json()) as T;
}

type Presigned = {
  files: Array<{
    upload_id: string;
    file_key: string;
    public_url: string;
    parts: Array<{ part_number: number; url: string }>;
  }>;
};

/** The CDN URL for `sourceUrl`. Already on the CDN → returned as-is, no I/O. */
export async function mirrorImageToCdn(sourceUrl: string): Promise<string> {
  if (isCdnUrl(sourceUrl)) return sourceUrl;

  const res = await fetch(sourceUrl, { headers: { "user-agent": "comfortel-asset-sync" } });
  if (!res.ok) throw new Error(`Image download failed (${res.status}) for ${sourceUrl}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  const filename = sourceUrl.split("/").pop()?.split("?")[0] || "image.jpg";
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const contentType =
    res.headers.get("content-type")?.split(";")[0]?.trim() || TYPE_BY_EXT[ext] || "image/jpeg";

  const { files } = await api<Presigned>("generate-presigned-url-multi-part", {
    files: [{ filename, content_type: contentType, total_parts: 1 }],
  });
  const file = files[0];
  if (!file?.parts[0]) throw new Error("Asset API returned no upload target");

  const put = await fetch(file.parts[0].url, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
  });
  if (!put.ok) throw new Error(`Image upload failed (${put.status})`);
  const etag = (put.headers.get("etag") ?? "").replaceAll('"', "");

  await api("complete-multipart-upload", {
    files: [
      {
        file_key: file.file_key,
        upload_id: file.upload_id,
        content_type: contentType,
        parts: [{ part_number: 1, etag }],
      },
    ],
  });
  return file.public_url;
}
