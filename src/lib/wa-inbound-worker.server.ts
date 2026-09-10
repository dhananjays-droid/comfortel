/** Processes the durable WhatsApp inbox outside Meta's webhook request. */

import { timingSafeEqual } from "node:crypto";

import { decryptPhone } from "@/lib/wa-phone-crypto.server";
import {
  claimInboundJobs,
  completeInboundJob,
  retryOrFailInboundJob,
  triggerInboundWorker,
  type QueuedInboundJob,
} from "@/lib/wa-inbound-queue.server";
import { processQueuedInbound } from "@/lib/wa-webhook.server";

const BATCH_SIZE = 5;

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function authenticated(request: Request): boolean {
  const secret = process.env["CRON_SECRET"];
  if (!secret) return false;
  return safeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`);
}

async function processJob(job: QueuedInboundJob): Promise<void> {
  try {
    const customerName = job.customer_name;
    await processQueuedInbound({
      sessionKey: job.session_key,
      phone: decryptPhone(job.customer_phone_enc),
      waMessageId: job.wa_message_id,
      event: job.event,
      ...(customerName ? { customerName } : {}),
    });
    await completeInboundJob(job.id);
  } catch (error) {
    console.error("WhatsApp inbound job failed", { id: job.id, attempt: job.attempt, error });
    await retryOrFailInboundJob(job, error);
  }
}

export async function runInboundBatch(): Promise<{ claimed: number; chained: boolean }> {
  const jobs = await claimInboundJobs(BATCH_SIZE);
  await Promise.all(jobs.map(processJob));
  const chained = jobs.length > 0 ? await triggerInboundWorker() : false;
  return { claimed: jobs.length, chained };
}

export async function handleInboundWorkerTick(request: Request): Promise<Response> {
  if (!authenticated(request)) return new Response("Unauthorized", { status: 401 });

  try {
    const result = await runInboundBatch();
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    console.error("WhatsApp inbound worker tick failed", error);
    return new Response(JSON.stringify({ error: "worker failed" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
