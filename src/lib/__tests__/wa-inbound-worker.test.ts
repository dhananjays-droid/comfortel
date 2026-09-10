import { afterEach, describe, expect, it } from "vitest";

import { handleInboundWorkerTick } from "@/lib/wa-inbound-worker.server";

const ORIGINAL_SECRET = process.env["CRON_SECRET"];
afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env["CRON_SECRET"];
  else process.env["CRON_SECRET"] = ORIGINAL_SECRET;
});

function request(authorization?: string): Request {
  return new Request("https://example.com/api/cron/wa-inbound-worker", {
    headers: authorization ? { authorization } : {},
  });
}

describe("WhatsApp inbound worker auth", () => {
  it("rejects calls when CRON_SECRET is not configured", async () => {
    delete process.env["CRON_SECRET"];
    await expect(handleInboundWorkerTick(request("Bearer anything"))).resolves.toMatchObject({
      status: 401,
    });
  });

  it("rejects a missing or incorrect bearer token", async () => {
    process.env["CRON_SECRET"] = "test-secret";
    await expect(handleInboundWorkerTick(request())).resolves.toMatchObject({ status: 401 });
    await expect(handleInboundWorkerTick(request("Bearer wrong"))).resolves.toMatchObject({
      status: 401,
    });
  });
});
