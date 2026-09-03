import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

// No raw-route convention exists in the installed @tanstack/react-start
// (no createServerFileRoute/createAPIFileRoute) — only client-callable
// createServerFn RPCs, which can't express Meta's GET verification handshake
// or a POST that must be signature-checked before its body is parsed. So the
// WhatsApp webhook is intercepted here, ahead of the TanStack handler, the
// same way this function already wraps that handler's response.
const RAW_ROUTES: Record<string, (request: Request) => Promise<Response>> = {
  "/api/webhooks/whatsapp": async (request) => {
    const { handleWhatsAppWebhook } = await import("./lib/wa-webhook.server");
    return handleWhatsAppWebhook(request);
  },
  // Invoked by Vercel Cron (see vercel.json) — bearer-checked inside the
  // handler itself against CRON_SECRET, the convention Vercel's own cron
  // sends automatically once that env var is set on the project.
  "/api/cron/wa-render-worker": async (request) => {
    const { handleRenderWorkerTick } = await import("./lib/wa-render-worker.server");
    return handleRenderWorkerTick(request);
  },
  // Developer diagnostics: recent wa_render_jobs + wa_messages, bearer-checked
  // against the same CRON_SECRET. GET /api/admin/wa-status?limit=25&session_key=...
  "/api/admin/wa-status": async (request) => {
    const { handleAdminStatus } = await import("./lib/wa-admin.server");
    return handleAdminStatus(request);
  },
};

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    const rawRoute = RAW_ROUTES[new URL(request.url).pathname];
    if (rawRoute) {
      try {
        return await rawRoute(request);
      } catch (error) {
        console.error(error);
        return new Response("Internal Server Error", { status: 500 });
      }
    }

    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
