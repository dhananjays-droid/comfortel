/**
 * The media bridge: Meta's inbound photo URLs expire in minutes, and kie.ai's
 * finished-render URLs are an expiring tempfile CDN (see kie.server.ts) — the
 * web app gets away with both because the browser fetches immediately. On
 * WhatsApp, wa-render-worker.server.ts runs on a *later* Vercel Cron tick, so
 * a room photo has to be re-hosted durably before that tick can use it, and a
 * finished render has to be re-hosted durably before it can survive both
 * Meta's own fetch and the customer reopening the chat weeks later.
 *
 * Deviation from the original design intent, flagged rather than silently
 * shipped: `resize-image.ts` (1024px longest edge, JPEG q0.85) is
 * browser-only — FileReader/Image/canvas don't exist server-side. Inbound
 * photos are size-capped and re-hosted unresized instead; WhatsApp's own
 * client already compresses photos before upload, and `visualizeStart` itself
 * still enforces a hard `MAX_BASE64_CHARS` ceiling downstream, so an
 * oversized inbound photo is rejected with a clear error there rather than
 * silently misbehaving.
 *
 * Outbound renders are a different story: kie.ai serves multi-reference modes
 * (staged_room, lineup, refit_room) at 2K, which regularly lands at 6-9MB —
 * comfortably fine for a browser tab, but over WhatsApp's 5MB image cap.
 * That failure is silent and easy to miss: Meta's send API still returns a
 * message id for an oversized link-based image (it queues the async fetch
 * without validating the size up front), so the job in wa_render_jobs reads
 * "done" while the customer never receives anything, and there is no
 * delivery-status webhook wired up here to catch it after the fact. `sharp`
 * re-encodes every render to a WhatsApp-safe JPEG before it is re-hosted, so
 * this only touches the WA delivery path — the web app still fetches the
 * original full-resolution PNG straight from kie.ai, untouched.
 */
import sharp from "sharp";

const GRAPH_API_VERSION = "v21.0";
const BUCKET = "wa-media";
/** Matches index.tsx's own MAX_PHOTO_BYTES client-side accept threshold. */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** WhatsApp's hard cap is 5MB; Meta's own guidance is to stay well under
 * that for reliable delivery, so this targets a comfortable margin rather
 * than the ceiling itself. */
const MAX_WHATSAPP_IMAGE_BYTES = 1.2 * 1024 * 1024;
const MAX_LONGEST_EDGE = 1600;

function accessToken(): string {
  const token = process.env["WHATSAPP_ACCESS_TOKEN"];
  if (!token) throw new Error("WHATSAPP_ACCESS_TOKEN is not configured");
  return token;
}

function extensionFor(contentType: string): string {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  return "jpg";
}

/** Resolves Meta's media id to bytes. Never throws — a failed fetch just
 * means the photo can't be attached, not that the whole turn should error. */
async function fetchInboundMedia(
  mediaId: string,
): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  try {
    const token = accessToken();
    const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!metaRes.ok) return null;
    const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
    if (!meta.url) return null;

    const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!fileRes.ok) return null;
    const bytes = await fileRes.arrayBuffer();
    if (bytes.byteLength > MAX_PHOTO_BYTES) return null;
    return { bytes, contentType: meta.mime_type ?? "image/jpeg" };
  } catch (err) {
    console.error("fetchInboundMedia failed", err);
    return null;
  }
}

/** Never throws — same resilience stance as wa-session-store.server.ts. */
async function uploadWaMedia(
  bytes: ArrayBuffer,
  contentType: string,
  keyPrefix: string,
): Promise<string | null> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const path = `${keyPrefix}/${crypto.randomUUID()}.${extensionFor(contentType)}`;
    const { error } = await supabaseAdmin.storage.from(BUCKET).upload(path, bytes, {
      contentType,
      upsert: false,
    });
    if (error) {
      console.error("uploadWaMedia failed", error);
      return null;
    }
    return supabaseAdmin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  } catch (err) {
    console.error("uploadWaMedia failed", err);
    return null;
  }
}

/**
 * Inbound path: a customer's room photo, Meta media id → durable URL. Called
 * from wa-webhook.server.ts synchronously within the webhook request (never
 * deferred to a worker) — queuing the bare media id for "later" is the one
 * sequencing mistake that silently loses the photo, since Meta's download URL
 * is only valid for a few minutes.
 */
export async function receiveRoomPhoto(mediaId: string): Promise<string | null> {
  const media = await fetchInboundMedia(mediaId);
  if (!media) return null;
  return uploadWaMedia(media.bytes, media.contentType, "rooms");
}

/** Re-encodes a render down to a size WhatsApp will actually deliver.
 * Resizing first (renders rarely need to display larger than this on a
 * phone) does most of the work; quality only steps down further if a
 * genuinely dense image is still over budget after that. */
async function compressForWhatsApp(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const resized = sharp(Buffer.from(bytes)).resize({
    width: MAX_LONGEST_EDGE,
    height: MAX_LONGEST_EDGE,
    fit: "inside",
    withoutEnlargement: true,
  });

  let quality = 85;
  let out = await resized.clone().jpeg({ quality }).toBuffer();
  while (out.byteLength > MAX_WHATSAPP_IMAGE_BYTES && quality > 35) {
    quality -= 15;
    out = await resized.clone().jpeg({ quality }).toBuffer();
  }
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

/**
 * Outbound path: a finished kie.ai render, tempfile URL → durable URL. Called
 * from wa-render-worker.server.ts once a render completes.
 */
export async function rehostRender(sourceUrl: string): Promise<string | null> {
  try {
    const res = await fetch(sourceUrl);
    if (!res.ok) return null;
    const bytes = await res.arrayBuffer();
    const compressed = await compressForWhatsApp(bytes);
    return uploadWaMedia(compressed, "image/jpeg", "renders");
  } catch (err) {
    console.error("rehostRender failed", err);
    return null;
  }
}
