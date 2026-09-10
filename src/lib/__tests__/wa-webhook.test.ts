import { describe, expect, it } from "vitest";

import { extractDeliveryStatuses } from "@/lib/wa-webhook.server";

describe("WhatsApp delivery statuses", () => {
  it("extracts a status-only callback with its Meta timestamp and diagnostics", () => {
    const statuses = extractDeliveryStatuses({
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  {
                    id: "wamid.outbound-1",
                    status: "delivered",
                    timestamp: "1789056000",
                    recipient_id: "61400000000",
                    pricing: { billable: true, category: "service" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(statuses).toEqual([
      {
        waMessageId: "wamid.outbound-1",
        status: "delivered",
        eventAt: "2026-09-10T16:00:00.000Z",
        recipientId: "61400000000",
        details: { pricing: { billable: true, category: "service" } },
      },
    ]);
  });

  it("ignores malformed lifecycle entries instead of inventing message ids", () => {
    expect(
      extractDeliveryStatuses({
        entry: [{ changes: [{ value: { statuses: [{ status: "read", timestamp: "1" }] } }] }],
      }),
    ).toEqual([]);
  });
});
