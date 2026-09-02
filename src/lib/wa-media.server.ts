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
 * browser-only — FileReader/Image/canvas don't exist server-side, and there
 * is no native image library in this project (adding one like `sharp` would
 * risk breaking whatever edge/serverless runtime this ends up deployed to,
 * per the Cloudflare-preset note in the implementation plan). Inbound photos
 * are size-capped and re-hosted unresized instead. In practice WhatsApp's own
 * client already compresses photos before upload, and `visualizeStart`
 * itself still enforces a hard `MAX_BASE64_CHARS` ceiling downstream — so an
 * oversized image is rejected with a clear error there rather than silently
 * misbehaving, but the bandwidth/base64 savings resize-image.ts buys the web
 * app are not currently realized here.
 */

const GRAPH_API_VERSION = "v21.0";
const BUCKET = "wa-media";
/** Matches index.tsx's own MAX_PHOTO_BYTES client-side accept threshold. */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

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

/**
 * Outbound path: a finished kie.ai render, tempfile URL → durable URL. Called
 * from wa-render-worker.server.ts once a render completes.
 */
export async function rehostRender(sourceUrl: string): Promise<string | null> {
  try {
    const res = await fetch(sourceUrl);
    if (!res.ok) return null;
    const bytes = await res.arrayBuffer();
    const contentType = res.headers.get("content-type") ?? "image/png";
    return uploadWaMedia(bytes, contentType, "renders");
  } catch (err) {
    console.error("rehostRender failed", err);
    return null;
  }
}
