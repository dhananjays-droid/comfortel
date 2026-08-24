/**
 * kie.ai gpt-image integration — ISOLATED ON PURPOSE.
 *
 * Everything about the kie.ai HTTP contract lives in this one file:
 *   - the endpoint URLs
 *   - the request body shape
 *   - the response parsing
 *
 * Replace the marked sections with the exact kie.ai spec; nothing outside
 * this file needs to change.
 *
 * Contract assumed here (async task model):
 *   1. POST a task  -> returns a task id
 *   2. Poll the task -> returns state + result image url
 * Timeout: 90s. Poll interval: 3s.
 */

const KIE_BASE_URL = "https://api.kie.ai";
// --- REPLACE: task submission endpoint ---------------------------------------
const KIE_CREATE_TASK_URL = `${KIE_BASE_URL}/api/v1/jobs/createTask`;
// --- REPLACE: task polling endpoint (task id appended as query param) --------
const KIE_TASK_STATUS_URL = `${KIE_BASE_URL}/api/v1/jobs/recordInfo`;

const POLL_INTERVAL_MS = 3_000;
const TIMEOUT_MS = 90_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Submits an image-edit task to kie.ai and returns the finished image URL.
 *
 * @param roomImageBase64  the customer's room photo, base64 (no data: prefix)
 * @param productImageUrl  catalog-full[productId].images[0]
 * @param prompt           the fully-built placement prompt
 */
export async function callKieImageEdit(
  roomImageBase64: string,
  productImageUrl: string,
  prompt: string,
): Promise<string> {
  const apiKey = process.env["KIE_API_KEY"];
  if (!apiKey) throw new Error("KIE_API_KEY is not configured");

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  // ── 1. SUBMIT TASK ───────────────────────────────────────────────────────
  // --- REPLACE: request body shape ---
  const createBody = {
    model: "gpt-image",
    input: {
      prompt,
      // room photo as an inline data URL + the product reference image
      image_urls: [`data:image/jpeg;base64,${roomImageBase64}`, productImageUrl],
      output_format: "png",
      image_size: "auto",
    },
  };

  const createRes = await fetch(KIE_CREATE_TASK_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(createBody),
  });

  if (!createRes.ok) {
    throw new Error(`kie.ai task creation failed (${createRes.status})`);
  }

  const createJson = (await createRes.json()) as Record<string, unknown>;
  // --- REPLACE: task id extraction ---
  const taskId =
    (createJson as any)?.data?.taskId ??
    (createJson as any)?.data?.task_id ??
    (createJson as any)?.taskId;

  if (!taskId || typeof taskId !== "string") {
    throw new Error("kie.ai did not return a task id");
  }

  // ── 2. POLL UNTIL COMPLETE ───────────────────────────────────────────────
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const pollRes = await fetch(
      `${KIE_TASK_STATUS_URL}?taskId=${encodeURIComponent(taskId)}`,
      { headers },
    );

    if (!pollRes.ok) continue; // transient — keep polling until the deadline

    const pollJson = (await pollRes.json()) as any;
    // --- REPLACE: response parsing ---
    const data = pollJson?.data ?? pollJson;
    const state: string = String(data?.state ?? data?.status ?? "").toLowerCase();

    if (state === "success" || state === "succeeded" || state === "completed") {
      let result = data?.resultJson ?? data?.result ?? data?.output;
      if (typeof result === "string") {
        try {
          result = JSON.parse(result);
        } catch {
          // a bare URL string is also acceptable
          if (result.startsWith("http")) return result;
        }
      }
      const url: string | undefined =
        result?.resultUrls?.[0] ??
        result?.image_urls?.[0] ??
        result?.images?.[0] ??
        result?.url;

      if (!url) throw new Error("kie.ai finished but returned no image URL");
      return url;
    }

    if (state === "fail" || state === "failed" || state === "error") {
      throw new Error("kie.ai image generation failed");
    }
  }

  throw new Error("kie.ai image generation timed out after 90 seconds");
}
