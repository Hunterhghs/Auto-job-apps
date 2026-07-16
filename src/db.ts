import type { JobRow, JobStatus, RawJob } from "./types";

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Canonicalize a job URL for dedupe: strip query params, trailing slashes. */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Insert newly discovered jobs, ignoring duplicates. Returns count inserted. */
export async function insertJobs(
  db: D1Database,
  jobs: (RawJob & { ats: string; status: JobStatus; skipReason?: string; priority?: number })[]
): Promise<number> {
  let inserted = 0;
  for (const job of jobs) {
    const hash = await sha256Hex(canonicalUrl(job.applyUrl ?? job.url));
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO jobs
           (url_hash, url, apply_url, source, company, title, location, salary, ats, status, skip_reason, priority)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        hash,
        job.url,
        job.applyUrl ?? null,
        job.source,
        job.company ?? null,
        job.title,
        job.location ?? null,
        job.salary ?? null,
        job.ats,
        job.status,
        job.skipReason ?? null,
        job.priority ?? 99
      )
      .run();
    if (result.meta.changes > 0) inserted++;
  }
  return inserted;
}

export async function appliedTodayCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs
       WHERE status = 'applied' AND date(applied_at) = date('now')`
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function nextQueuedJobs(
  db: D1Database,
  limit: number
): Promise<JobRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM jobs
       WHERE status = 'queued'
       ORDER BY priority ASC, discovered_at ASC
       LIMIT ?`
    )
    .bind(limit)
    .all<JobRow>();
  return results;
}

/**
 * Crash recovery: jobs stuck in 'applying' from a previous run that died
 * (browser rate limit, worker eviction) go back to the queue.
 */
export async function requeueStaleApplying(db: D1Database): Promise<number> {
  const result = await db
    .prepare(`UPDATE jobs SET status = 'queued' WHERE status = 'applying'`)
    .run();
  return result.meta.changes;
}

export async function updateJobAts(
  db: D1Database,
  id: number,
  ats: string,
  applyUrl: string
): Promise<void> {
  await db
    .prepare(`UPDATE jobs SET ats = ?, apply_url = ? WHERE id = ?`)
    .bind(ats, applyUrl, id)
    .run();
}

export async function updateJobStatus(
  db: D1Database,
  id: number,
  status: JobStatus,
  fields: {
    skipReason?: string;
    error?: string;
    answersJson?: string;
    screenshotKey?: string;
  } = {}
): Promise<void> {
  await db
    .prepare(
      `UPDATE jobs SET
         status = ?,
         skip_reason = COALESCE(?, skip_reason),
         error = COALESCE(?, error),
         answers_json = COALESCE(?, answers_json),
         screenshot_key = COALESCE(?, screenshot_key),
         applied_at = CASE WHEN ? = 'applied' THEN datetime('now') ELSE applied_at END
       WHERE id = ?`
    )
    .bind(
      status,
      fields.skipReason ?? null,
      fields.error ?? null,
      fields.answersJson ?? null,
      fields.screenshotKey ?? null,
      status,
      id
    )
    .run();
}

export async function startRun(
  db: D1Database,
  trigger: "cron" | "manual"
): Promise<number> {
  const result = await db
    .prepare(`INSERT INTO runs (trigger) VALUES (?)`)
    .bind(trigger)
    .run();
  return result.meta.last_row_id;
}

export async function finishRun(
  db: D1Database,
  id: number,
  stats: { discovered: number; applied: number; skipped: number; failed: number },
  notes?: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE runs SET finished_at = datetime('now'),
         discovered = ?, applied = ?, skipped = ?, failed = ?, notes = ?
       WHERE id = ?`
    )
    .bind(
      stats.discovered,
      stats.applied,
      stats.skipped,
      stats.failed,
      notes ?? null,
      id
    )
    .run();
}
