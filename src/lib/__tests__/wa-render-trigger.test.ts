import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { triggerRenderWorker } from "@/lib/wa-render-trigger.server";

const ENV_KEYS = ["PUBLIC_BASE_URL", "VERCEL_URL", "CRON_SECRET"] as const;
const ORIGINAL = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function restore() {
  for (const k of ENV_KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k] as string;
  }
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  restore();
  vi.unstubAllGlobals();
});

/** Captures the outgoing request without letting a real one escape the suite. */
function stubFetch(impl?: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return impl ? impl(String(url), init) : new Response("{}", { status: 200 });
    }),
  );
  return calls;
}

describe("triggerRenderWorker", () => {
  it("does nothing when no base URL is configured", async () => {
    process.env["CRON_SECRET"] = "s3cret";
    const calls = stubFetch();
    expect(await triggerRenderWorker()).toBe(false);
    expect(calls).toEqual([]);
  });

  it("does nothing without a CRON_SECRET, rather than calling itself unauthenticated", async () => {
    process.env["PUBLIC_BASE_URL"] = "https://example.test";
    const calls = stubFetch();
    expect(await triggerRenderWorker()).toBe(false);
    expect(calls).toEqual([]);
  });

  it("calls the worker route with the cron bearer token", async () => {
    process.env["PUBLIC_BASE_URL"] = "https://example.test";
    process.env["CRON_SECRET"] = "s3cret";
    const calls = stubFetch();

    expect(await triggerRenderWorker()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://example.test/api/cron/wa-render-worker?depth=0");
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer s3cret",
    );
  });

  it("passes the chain depth through, so the worker can enforce its ceiling", async () => {
    process.env["PUBLIC_BASE_URL"] = "https://example.test";
    process.env["CRON_SECRET"] = "s3cret";
    const calls = stubFetch();

    await triggerRenderWorker(7);
    expect(calls[0]!.url).toContain("depth=7");
  });

  it("prefers an explicit base URL over VERCEL_URL", async () => {
    process.env["PUBLIC_BASE_URL"] = "https://explicit.test";
    process.env["VERCEL_URL"] = "deployment.vercel.app";
    process.env["CRON_SECRET"] = "s3cret";
    const calls = stubFetch();

    await triggerRenderWorker();
    expect(calls[0]!.url.startsWith("https://explicit.test/")).toBe(true);
  });

  it("derives https:// from a bare VERCEL_URL host", async () => {
    process.env["VERCEL_URL"] = "deployment.vercel.app";
    process.env["CRON_SECRET"] = "s3cret";
    const calls = stubFetch();

    await triggerRenderWorker();
    expect(calls[0]!.url).toBe("https://deployment.vercel.app/api/cron/wa-render-worker?depth=0");
  });

  it("tolerates a trailing slash on the configured base URL", async () => {
    process.env["PUBLIC_BASE_URL"] = "https://example.test/";
    process.env["CRON_SECRET"] = "s3cret";
    const calls = stubFetch();

    await triggerRenderWorker();
    expect(calls[0]!.url).toBe("https://example.test/api/cron/wa-render-worker?depth=0");
  });

  it("treats an abort as success — the request left, we just stopped waiting", async () => {
    process.env["PUBLIC_BASE_URL"] = "https://example.test";
    process.env["CRON_SECRET"] = "s3cret";
    stubFetch(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });

    expect(await triggerRenderWorker()).toBe(true);
  });

  it("reports a genuine network failure without throwing at the caller", async () => {
    process.env["PUBLIC_BASE_URL"] = "https://example.test";
    process.env["CRON_SECRET"] = "s3cret";
    stubFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    // A caller is always on a path a customer is waiting on: this must resolve,
    // never reject, because a missed trigger costs latency and cron still runs.
    await expect(triggerRenderWorker()).resolves.toBe(false);
    quiet.mockRestore();
  });
});
