import { afterEach, describe, expect, it, vi } from "vitest";
import { triggerInboundWorker } from "@/lib/wa-inbound-queue.server";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("inbound worker dispatch", () => {
  function setup(response: () => Promise<Response>) {
    vi.stubEnv("PUBLIC_BASE_URL", "https://comfortel-new.vercel.app");
    vi.stubEnv("CRON_SECRET", "test-secret");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn<typeof globalThis.fetch>(response);
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("does not mistake a login page for an accepted job", async () => {
    setup(async () => new Response("<html>Login</html>"));
    expect(await triggerInboundWorker()).toBe(false);
  });

  it("allows inline recovery on timeout or rejected requests", async () => {
    setup(async () => {
      throw new DOMException("Timed out", "AbortError");
    });
    expect(await triggerInboundWorker()).toBe(false);
  });

  it("rejects redirects and validates the worker response", async () => {
    const fetch = setup(async () => Response.json({ worker: "wa-inbound", claimed: 1 }));
    expect(await triggerInboundWorker()).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://comfortel-new.vercel.app/api/cron/wa-inbound-worker",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("uses the production alias instead of the protected deployment URL", async () => {
    const fetch = setup(async () => Response.json({ worker: "wa-inbound", claimed: 0 }));
    vi.stubEnv("PUBLIC_BASE_URL", "");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "comfortel-new.vercel.app");
    vi.stubEnv("VERCEL_URL", "protected-deployment.vercel.app");
    expect(await triggerInboundWorker()).toBe(true);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://comfortel-new.vercel.app/api/cron/wa-inbound-worker",
    );
  });
});
