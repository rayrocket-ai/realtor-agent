import { pgPool } from "../db/client.js";
import type { Job } from "../db/schema.js";

export interface EnqueueOptions {
  type: string;
  payload?: Record<string, unknown>;
  runAt?: Date;
  /** When set, at most one *pending* job with this key exists; duplicates are ignored. */
  dedupeKey?: string;
}

export async function enqueue(opts: EnqueueOptions): Promise<void> {
  await pgPool().query(
    `INSERT INTO jobs (type, payload, run_at, dedupe_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (dedupe_key) WHERE status = 'pending' DO NOTHING`,
    [opts.type, JSON.stringify(opts.payload ?? {}), opts.runAt ?? new Date(), opts.dedupeKey ?? null],
  );
}

/** Claim one due pending job (FOR UPDATE SKIP LOCKED) and mark it running. */
export async function claimNextJob(): Promise<Job | null> {
  const res = await pgPool().query(
    `UPDATE jobs SET status = 'running'
     WHERE id = (
       SELECT id FROM jobs
       WHERE status = 'pending' AND run_at <= now()
       ORDER BY run_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, type, payload, run_at, status, attempts, last_error, dedupe_key, created_at`,
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    runAt: row.run_at,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
  } as Job;
}

export async function completeJob(id: string): Promise<void> {
  await pgPool().query(`UPDATE jobs SET status = 'done' WHERE id = $1`, [id]);
}

/** Mark a job permanently failed (no retries) — e.g. unknown job type. */
export async function failJobPermanently(id: string, error: string): Promise<void> {
  await pgPool().query(
    `UPDATE jobs SET status = 'failed', attempts = attempts + 1, last_error = $2 WHERE id = $1`,
    [id, error.slice(0, 4000)],
  );
}

const MAX_ATTEMPTS = 3;

/** Record a failure: retry with backoff up to MAX_ATTEMPTS, then mark failed. Returns final status. */
export async function failJob(id: string, error: string): Promise<"pending" | "failed"> {
  const res = await pgPool().query(
    `UPDATE jobs SET
       attempts = attempts + 1,
       last_error = $2,
       status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END,
       run_at = now() + (interval '60 seconds' * (attempts + 1))
     WHERE id = $1
     RETURNING status`,
    [id, error.slice(0, 4000), MAX_ATTEMPTS],
  );
  return res.rows[0]?.status ?? "failed";
}
