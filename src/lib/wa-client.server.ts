/**
 * Outbound WhatsApp Cloud API client — the one place that speaks Meta's Graph
 * API, the same way kie.server.ts is the one place that speaks kie.ai's.
 *
 * Deliberately DB-free: this only sends. Logging a send to `wa_messages` (for
 * audit and the 24h-window check) happens at the call site, the same
 * separation kie.server.ts (speaks kie.ai) and visualize.functions.ts (writes
 * the cache row) already keep between them.
 */

import type { WaAction } from "@/lib/wa-flow";
import { WA, truncate } from "@/lib/whatsapp";

/** Verify against developers.facebook.com/docs/whatsapp/cloud-api at deploy
 * time — this is exactly the kind of vendor detail that drifts. */
const GRAPH_API_VERSION = "v21.0";

export class WaClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

function credentials(): { token: string; phoneNumberId: string } {
  const token = process.env["WHATSAPP_ACCESS_TOKEN"];
  const phoneNumberId = process.env["WHATSAPP_PHONE_NUMBER_ID"];
  if (!token || !phoneNumberId) {
    throw new Error("WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID not configured");
  }
  return { token, phoneNumberId };
}

type SendResult = { messages?: Array<{ id?: string }> };

async function send(payload: Record<string, unknown>): Promise<string> {
  const { token, phoneNumberId } = credentials();
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    },
  );

  const json = (await res.json().catch(() => ({}))) as SendResult;
  if (!res.ok) {
    console.error("WhatsApp send failed", res.status, json);
    throw new WaClientError(`WhatsApp send failed (${res.status})`, res.status, json);
  }

  const id = json.messages?.[0]?.id;
  if (!id) throw new WaClientError("WhatsApp send returned no message id", res.status, json);
  return id;
}

export async function sendText(to: string, body: string): Promise<string> {
  return send({ to, type: "text", text: { body: truncate(body, WA.body) } });
}

export async function sendImage(to: string, imageUrl: string, caption?: string): Promise<string> {
  return send({
    to,
    type: "image",
    image: caption ? { link: imageUrl, caption: truncate(caption, WA.body) } : { link: imageUrl },
  });
}

export async function sendButtons(
  to: string,
  body: string,
  action: WaAction & { kind: "buttons" },
): Promise<string> {
  const buttons = action.buttons.slice(0, WA.buttons).map((b) => ({
    type: "reply",
    reply: { id: b.id, title: truncate(b.title, WA.buttonTitle) },
  }));
  return send({
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: truncate(body, WA.body) },
      action: { buttons },
    },
  });
}

export async function sendList(
  to: string,
  body: string,
  action: WaAction & { kind: "list" },
): Promise<string> {
  const rows = action.rows.slice(0, WA.listRows).map((r) => ({
    id: r.id,
    title: truncate(r.title, WA.listRowTitle),
    ...(r.description ? { description: truncate(r.description, WA.listRowDescription) } : {}),
  }));
  return send({
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: truncate(body, WA.body) },
      // Meta caps a list's own button label at 20 chars too — the same limit
      // WA.buttonTitle already names for reply buttons; whatsapp.ts has no
      // separate constant for it since only wa-client.server.ts needs it.
      action: { button: truncate(action.button, WA.buttonTitle), sections: [{ rows }] },
    },
  });
}

export async function sendTemplate(to: string, name: string, params: string[]): Promise<string> {
  return send({
    to,
    type: "template",
    template: {
      name,
      language: { code: "en_US" },
      ...(params.length
        ? {
            components: [
              { type: "body", parameters: params.map((text) => ({ type: "text", text })) },
            ],
          }
        : {}),
    },
  });
}
