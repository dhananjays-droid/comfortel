/**
 * kie.ai integration — ISOLATED ON PURPOSE.
 *
 * Flow: upload room photo (base64 -> public URL) -> createTask -> client polls status.
 * Never poll in a server-side loop; the browser drives polling.
 *
 * The whole operation is: image URLs plus a prompt. Room photo first, product
 * references after — the order is what tells the model which is which.
 */

import { isMultiReferenceMode, type VisualizeMode } from "@/lib/visualize-prompt";

const KIE_API = "https://api.kie.ai";
const KIE_UPLOAD = "https://kieai.redpandaai.co/api/file-base64-upload";

/**
 * GPT Image 2. Chosen over gpt-image/1.5-image-to-image after rendering the
 * same salon photo through both: 1.5 does not replace furniture, it RE-SKINS
 * it — asked to fit a black Comfortel chair into a room of chrome barber
 * chairs it recoloured the existing chairs black and kept their frames, bases
 * and footrests. GPT Image 2 removed them and installed the actual product,
 * preserving the room, the chair count and each station's facing.
 *
 * It also lifts two hard limits that shaped this module: the prompt cap goes
 * from 3000 characters to 20000, and up to 16 reference images are accepted.
 *
 * Note the id has NO slash, unlike the 1.5 ids.
 */
const MODEL = "gpt-image-2-image-to-image";

/**
 * Resolution is chosen per render, because what it buys depends on the mode.
 *
 * kie's tiers are native generations rather than upscales — 6 credits ($0.03)
 * at 1K, 10 ($0.05) at 2K, 16 ($0.08) at 4K — so 2K is four times the pixels
 * for two-thirds more money, not a resize.
 *
 * Where that matters is crowding. A refit, a lineup or a staged room puts
 * several DIFFERENT products in one frame, and each one's share of the pixels
 * is what decides whether its armrests and base survive; a seven-product plan
 * at 1K is where pieces stop being recognisable. A single-product placement has
 * one identity to get right and is read in a chat bubble, so it gains almost
 * nothing and 1K stays the honest default there.
 *
 * The aspect-ratio caveat does not bite: 2K and 4K exclude 5:4, 4:5, 3:1, 1:3
 * and 9:21, and resize-image.ts only ever produces 1:1, 3:2 or 2:3.
 *
 * KIE_IMAGE_RESOLUTION still overrides both, for testing a whole run at one
 * tier without touching code.
 */
const VALID_RESOLUTIONS = ["1K", "2K", "4K"];

export function resolutionFor(mode: VisualizeMode): string {
  const override = (process.env["KIE_IMAGE_RESOLUTION"] ?? "").trim();
  if (VALID_RESOLUTIONS.includes(override)) return override;
  return isMultiReferenceMode(mode) ? "2K" : "1K";
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
      model: MODEL,
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
