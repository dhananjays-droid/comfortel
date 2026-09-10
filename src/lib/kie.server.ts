/**
 * kie.ai integration — ISOLATED ON PURPOSE.
 *
 * Flow: upload room photo (base64 -> public URL) -> createTask -> client polls status.
 * Never poll in a server-side loop; the browser drives polling.
 *
 * The whole operation is: image URLs plus a prompt. Room photo first, product
 * references after — the order is what tells the model which is which.
 */

import { cdnFor } from "@/lib/cdn-assets";
import type { VisualizeMode } from "@/lib/visualize-prompt";

const KIE_API = "https://api.kie.ai";
const KIE_UPLOAD = "https://kieai.redpandaai.co/api/file-base64-upload";

/**
 * Kie's recommended GPT Image 2.5 production variant. Flare keeps the same
 * createTask contract this integration already uses while improving reference
 * preservation, edit precision and latency. Image-to-image is used for every
 * mode because even staged rooms include product reference images.
 */
export const KIE_IMAGE_MODEL = "gpt-image-2-5-flare-image-to-image";

/** Fixed at 1K while measuring latency and fidelity with the existing full
 * reference allocation. Both web and WhatsApp call this shared adapter. */
export function resolutionFor(_mode: VisualizeMode): string {
  return "1K";
}

// Narrow shapes for the three kie responses this module reads. Only the fields
// actually consumed are declared — kie returns more, and typing all of it would
// be a fiction we'd have to maintain.
type KieUploadResponse = {
  success?: boolean;
  msg?: string;
  data?: { downloadUrl?: string };
};

type KieCreateResponse = {
  code?: number;
  msg?: string;
  data?: { taskId?: string };
};

type KieRecordResponse = {
  data?: {
    state?: string;
    progress?: number | string;
    failMsg?: string;
    failCode?: string;
    resultJson?: string | { resultUrls?: string[] };
  };
};

function key(): string {
  const k = process.env["KIE_API_KEY"];
  if (!k) throw new Error("KIE_API_KEY is not configured");
  return k;
}

function jsonHeaders() {
  return { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" };
}

/** Step 1 — push an image to kie's temp storage, get a publicly fetchable URL. */
export async function uploadToKie(
  base64Data: string,
  uploadPath = "images/rooms",
  fileName = `room-${Date.now()}.jpg`,
): Promise<string> {
  const res = await fetch(KIE_UPLOAD, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ base64Data, uploadPath, fileName }),
  });

  const json = (await res.json()) as KieUploadResponse;
  if (!json?.success || !json?.data?.downloadUrl) {
    throw new Error(`kie upload failed: ${json?.msg ?? res.status}`);
  }
  return json.data.downloadUrl;
}

/**
 * Copy a product image onto kie's own storage and return that URL.
 *
 * Necessary, not defensive: GPT Image 2 fails the whole task with "Image fetch
 * failed. Check access settings or use our File Upload API instead." when given
 * a comfortelfurniture.com URL. (1.5 could fetch them, which is why this only
 * surfaced on the model switch.) Downloading and re-uploading is the documented
 * workaround.
 */
const mirrored = new Map<string, { url: string; at: number }>();

/** kie serves these from tempfile storage, so a mirror is not cached for long. */
const MIRROR_TTL_MS = 20 * 60 * 1000;

async function mirror(sourceUrl: string): Promise<string> {
  // Already on our own CDN, which GPT Image 2 fetches happily — no download,
  // no re-upload, nothing to expire. This is the whole point of
  // scripts/sync-cdn-assets.mjs: mirroring here measured at ~16.7s before
  // generation started, paid on almost every render because this Map is
  // in-process and Vercel cold-starts wipe it.
  //
  // The upload path below stays as the fallback, deliberately. A product
  // scraped since the last sync, or one whose upload failed, still renders —
  // slowly, rather than not at all.
  const fromCdn = cdnFor(sourceUrl);
  if (fromCdn) return fromCdn;

  const hit = mirrored.get(sourceUrl);
  if (hit && Date.now() - hit.at < MIRROR_TTL_MS) return hit.url;

  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`product image fetch failed: ${res.status} ${sourceUrl}`);
  const base64 = Buffer.from(await res.arrayBuffer()).toString("base64");

  const name = sourceUrl.split("/").pop()?.split("?")[0] || "product.jpg";
  const url = await uploadToKie(base64, "images/products", name);

  mirrored.set(sourceUrl, { url, at: Date.now() });
  return url;
}

/** Mirrors run concurrently — they are independent and each is a full upload. */
async function mirrorAll(urls: string[]): Promise<string[]> {
  return Promise.all(urls.map((u) => mirror(u)));
}

/**
 * Step 2 — create the generation task. Returns a taskId immediately.
 *
 * input_urls is an ARRAY and the order is the contract: room photo FIRST, then
 * one or more product references. The prompt refers to them positionally ("the
 * first image", "image 2 is a..."), so reordering silently inverts it.
 */
export async function createVisualizeTask(
  /** null for staged_room, where the references are the only input. */
  roomUrl: string | null,
  productImageUrls: string[],
  prompt: string,
  aspectRatio: string,
  /** Decides the resolution tier — see resolution(). */
  mode: VisualizeMode,
): Promise<string> {
  const references = await mirrorAll(productImageUrls);

  const res = await fetch(`${KIE_API}/api/v1/jobs/createTask`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      model: KIE_IMAGE_MODEL,
      input: {
        input_urls: roomUrl ? [roomUrl, ...references] : references,
        prompt,
        aspect_ratio: aspectRatio,
        resolution: resolutionFor(mode),
      },
    }),
  });

  const json = (await res.json()) as KieCreateResponse;
  if (json?.code !== 200 || !json?.data?.taskId) {
    throw new Error(`kie createTask failed: ${json?.msg ?? res.status}`);
  }
  return json.data.taskId;
}

export type KieTaskResult = { done: false; progress: number } | { done: true; imageUrl: string };

/** Step 3 — poll a single time. Called per client poll, never in a loop here. */
export async function getTaskResult(taskId: string): Promise<KieTaskResult> {
  const res = await fetch(
    `${KIE_API}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
    { headers: { Authorization: `Bearer ${key()}` } },
  );

  const json = (await res.json()) as KieRecordResponse;
  const d = json?.data;
  if (!d) throw new Error("kie recordInfo returned no data");

  // TRAP 1: do NOT branch on json.code — kie returns 505 alongside msg:"success".
  // States: waiting | queuing | generating | success | fail
  if (d.state === "fail") {
    throw new Error(d.failMsg || d.failCode || "generation failed");
  }
  if (d.state !== "success") {
    return { done: false, progress: Number(d.progress ?? 0) };
  }

  // TRAP 2: resultJson is a JSON *string*, not an object.
  const parsed = typeof d.resultJson === "string" ? JSON.parse(d.resultJson) : d.resultJson;
  const url = parsed?.resultUrls?.[0];
  if (!url) throw new Error("kie finished but returned no image URL");
  return { done: true, imageUrl: url as string };
}
