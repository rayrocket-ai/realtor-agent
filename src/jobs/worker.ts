import { claimNextJob, completeJob, failJob, failJobPermanently, enqueue } from "./queue.js";
import { handlers } from "./handlers/index.js";

const TICK_MS = 15_000;

let timer: NodeJS.Timeout | undefined;
let draining = false;

export function startWorker(): void {
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  void tick();
  console.log("[jobs] worker started (tick every %ds)", TICK_MS / 1000);
}

export function stopWorker(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

export async function tick(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    // Drain everything currently due, one job at a time.
    for (;;) {
      const job = await claimNextJob();
      if (!job) break;
      await runJob(job.id, job.type, job.payload ?? {});
    }
  } catch (err) {
    console.error("[jobs] tick error:", err);
  } finally {
    draining = false;
  }
}

async function runJob(id: string, type: string, payload: Record<string, unknown>): Promise<void> {
  const handler = handlers[type];
  if (!handler) {
    console.error(`[jobs] no handler for job type "${type}"`);
    await failJobPermanently(id, `no handler for type ${type}`);
    return;
  }
  try {
    await handler(payload);
    await completeJob(id);
  } catch (err) {
    const message = (err as Error).stack ?? String(err);
    console.error(`[jobs] job ${type}/${id} failed:`, message);
    const status = await failJob(id, message);
    if (status === "failed" && type !== "notify-realtor") {
      // Terminal failure — tell the realtor (unless the notifier itself is broken).
      await enqueue({
        type: "notify-realtor",
        payload: {
          subject: `realtor-agent: background job "${type}" failed`,
          body: `Job ${id} (${type}) failed after retries.\n\nPayload: ${JSON.stringify(payload)}\n\nError:\n${message.slice(0, 2000)}`,
        },
      }).catch(() => {});
    }
  }
}
