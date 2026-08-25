import { toast } from "sonner";

/**
 * kie serves results from its own CDN, which may or may not send CORS headers.
 * Try the blob path first so the file lands in Downloads with a sensible name;
 * if the fetch is blocked, fall back to opening the image in a new tab rather
 * than failing silently.
 */
export async function downloadImage(url: string, name: string): Promise<void> {
  const filename = `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-in-my-space.png`;
  try {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
    toast("Opened in a new tab", { description: "Right-click the image to save it." });
  }
}
