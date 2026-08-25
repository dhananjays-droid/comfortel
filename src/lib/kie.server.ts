/**
 * kie.ai integration — ISOLATED ON PURPOSE.
 *
 * Flow: upload room photo (base64 -> public URL) -> createTask -> client polls status.
 * Never poll in a server-side loop; the browser drives polling.
 */

const KIE_API = "https://api.kie.ai";
const KIE_UPLOAD = "https://kieai.redpandaai.co/api/file-base64-upload";

function key(): string {
  const k = process.env["KIE_API_KEY"];
  if (!k) throw new Error("KIE_API_KEY is not configured");
  return k;
}

function jsonHeaders() {
  return { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" };
}

/** Step 1 — push the room photo to kie's temp storage, get a public URL. */
export async function uploadToKie(base64Data: string): Promise<string> {
  const res = await fetch(KIE_UPLOAD, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      base64Data,
      uploadPath: "images/rooms",
      fileName: `room-${Date.now()}.jpg`,
    }),
  });

  const json = (await res.json()) as any;
  if (!json?.success || !json?.data?.downloadUrl) {
    throw new Error(`kie upload failed: ${json?.msg ?? res.status}`);
  }
  return json.data.downloadUrl as string;
}

/**
 * Step 2 — create the generation task. Returns a taskId immediately.
 * input_urls is an ARRAY: room photo FIRST, product reference SECOND.
 */
export async function createVisualizeTask(
  roomUrl: string,
  productImageUrl: string,
  prompt: string,
  aspectRatio: string,
): Promise<string> {
  const res = await fetch(`${KIE_API}/api/v1/jobs/createTask`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      model: "gpt-image/1.5-image-to-image",
      input: {
        input_urls: [roomUrl, productImageUrl],
        prompt,
        aspect_ratio: aspectRatio,
        quality: "medium",
      },
    }),
  });

  const json = (await res.json()) as any;
  if (json?.code !== 200 || !json?.data?.taskId) {
    throw new Error(`kie createTask failed: ${json?.msg ?? res.status}`);
  }
  return json.data.taskId as string;
}

export type KieTaskResult =
  | { done: false; progress: number }
  | { done: true; imageUrl: string };

/** Step 3 — poll a single time. Called per client poll, never in a loop here. */
export async function getTaskResult(taskId: string): Promise<KieTaskResult> {
  const res = await fetch(
    `${KIE_API}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
    { headers: { Authorization: `Bearer ${key()}` } },
  );

  const json = (await res.json()) as any;
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
