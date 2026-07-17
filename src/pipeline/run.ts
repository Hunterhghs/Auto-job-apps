import type { AtsType, JobStatus, RawJob } from "../types";
import { getConfig, type AppConfig } from "../config";
import {
  insertJob,
  appliedTodayCount,
  updateJobStatus,
  updateJobAts,
  requeueStaleApplying,
  startRun,
  finishRun,
} from "../db";
import type { Browser } from "@cloudflare/puppeteer";
import { searchAllSources } from "./sources";
import { filterJob, termPriority } from "./filter";
import { classifyAtsFromUrl, resolveApplyUrl } from "./classify";
import { applyToJobs } from "./apply";
import { launchBrowser } from "./browser";

export interface PipelineEnv {
  DB: D1Database;
  CONFIG: KVNamespace;
  FILES: R2Bucket;
  BROWSER: Fetcher;
  AI: Ai;
  DEEPSEEK_API_KEY?: string;
}

/**
 * Scout-and-apply: each cron run discovers ONE job and applies to it
 * immediately. No queuing, no batching — one application at a time,
 * spread across the day in regular intervals.
 *
 * Cron runs every 15 min (96/day); daily cap (default 15) limits actual
 * applications. Scale cap to 25, 50, etc. as volume grows.
 */
export async function runPipeline(
  env: PipelineEnv,
  trigger: "cron" | "manual"
): Promise<{ discovered: number; applied: number; skipped: number; failed: number }> {
  const config = await getConfig(env.CONFIG);
  const stats = { discovered: 0, applied: 0, skipped: 0, failed: 0 };

  if (config.paused) {
    console.log(JSON.stringify({ event: "pipeline_paused" }));
    return stats;
  }

  const runId = await startRun(env.DB, trigger);

  // Recover any jobs stuck from a crashed run
  const requeued = await requeueStaleApplying(env.DB);
  if (requeued > 0) {
    console.log(JSON.stringify({ event: "stale_jobs_requeued", count: requeued }));
  }

  // Respect daily budget
  const appliedToday = await appliedTodayCount(env.DB);
  if (appliedToday >= config.dailyCap) {
    console.log(JSON.stringify({ event: "daily_budget_reached", appliedToday }));
    await finishRun(env.DB, runId, stats);
    return stats;
  }

  let browser: Browser | null = null;
  try {
    // 1. SCOUT — check suggestions board (D1) first, then fresh API sources
    let candidates = await getQueuedJobs(env.DB);
    if (candidates.length === 0) {
      candidates = await scoutCandidates(env, config);
      console.log(JSON.stringify({ event: "fresh_scout", count: candidates.length }));
      // Store ALL scouted jobs so the Daily Jobs page shows the full batch
      for (const job of candidates) {
        await insertJob(env.DB, { ...job, ats: job.ats ?? "unknown", status: "queued" as JobStatus, priority: 0 });
      }
    } else {
      console.log(JSON.stringify({ event: "queue_board_pull", count: candidates.length }));
    }

    if (candidates.length === 0) {
      console.log(JSON.stringify({ event: "no_jobs_found" }));
      await finishRun(env.DB, runId, stats);
      return stats;
    }

    browser = await launchBrowser(env.BROWSER);

    // 2. APPLY — try each candidate until one succeeds.
    // Skip and move to next on any failure; every interval lands an application.
    for (let i = 0; i < candidates.length; i++) {
      const job = candidates[i];
      stats.discovered++;

      console.log(JSON.stringify({
        event: "scouted",
        attempt: i + 1,
        company: job.company,
        title: job.title,
        source: job.source,
        ats: job.ats,
      }));

      const inserted = await insertJob(env.DB, {
        ...job,
        ats: job.ats ?? "unknown",
        status: "applying" as JobStatus,
        priority: 0,
      });

      const results = await applyToJobs(env, browser, [{
        id: inserted,
        url_hash: "",
        url: job.url,
        apply_url: job.applyUrl ?? null,
        source: job.source,
        company: job.company ?? null,
        title: job.title,
        location: job.location ?? null,
        salary: job.salary ?? null,
        ats: job.ats ?? null,
        status: "applying",
        skip_reason: null,
        error: null,
        answers_json: null,
        screenshot_key: null,
        discovered_at: new Date().toISOString(),
        applied_at: null,
      }]);

      for (const [_jobId, result] of results) {
        if (result.resolvedAts && result.resolvedApplyUrl) {
          await updateJobAts(env.DB, inserted, result.resolvedAts, result.resolvedApplyUrl);
        }
        await updateJobStatus(env.DB, inserted, result.status, {
          skipReason: result.reason,
          error: result.status === "failed" ? result.reason : undefined,
          answersJson: result.answers ? JSON.stringify(result.answers) : undefined,
          screenshotKey: result.screenshotKey,
        });

        if (result.status === "applied") {
          stats.applied++;
          console.log(JSON.stringify({ event: "applied", company: job.company, title: job.title }));
        } else if (result.status === "failed") {
          stats.failed++;
        } else {
          stats.skipped++;
        }
        console.log(JSON.stringify({
          event: "apply_attempt",
          company: job.company,
          status: result.status,
          reason: result.reason,
        }));
      }

      if (stats.applied > 0) break; // Success — move to next interval
    }

    await finishRun(env.DB, runId, stats);
  } catch (err) {
    await finishRun(env.DB, runId, stats, `run error: ${String(err)}`);
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return stats;
}

/**
 * Fetch all sources once and return every matching job, deduplicated
 * and sorted by priority. The caller iterates through one at a time.
 */
async function scoutCandidates(
  env: PipelineEnv,
  config: AppConfig
): Promise<(RawJob & { ats: AtsType; applyUrl?: string })[]> {
  const rawJobs = await searchAllSources(config.searchTerms);

  // Sort: priority first, then prefer less prominent companies (fewer total listings = higher success rate)
  rawJobs.sort(
    (a, b) =>
      termPriority(a.title, config.searchTerms) - termPriority(b.title, config.searchTerms)
  );

  const seenUrls = new Set<string>();
  const companyCounts = new Map<string, number>();
  const MAX_PER_COMPANY = 2; // No more than 2 jobs per company per batch
  const candidates: (RawJob & { ats: AtsType; applyUrl?: string })[] = [];

  for (const job of rawJobs) {
    const urlKey = job.url.split("?")[0].toLowerCase();
    if (seenUrls.has(urlKey)) continue;

    const filter = filterJob(job, config);
    if (!filter.pass) continue;

    // Enforce company diversity — cap at 2 per company
    const companyKey = (job.company ?? "unknown").toLowerCase();
    const count = companyCounts.get(companyKey) ?? 0;
    if (count >= MAX_PER_COMPANY) continue;

    seenUrls.add(urlKey);
    companyCounts.set(companyKey, count + 1);

    let ats = classifyAtsFromUrl(job.applyUrl ?? job.url);
    let applyUrl = job.applyUrl;

    if (ats === "unknown") {
      const resolved = await resolveApplyUrl(job.url);
      if (resolved) { ats = resolved.ats; applyUrl = resolved.applyUrl; }
    }

    candidates.push({ ...job, ats, applyUrl });
  }

  return candidates;
}

/** Pull highest-priority queued jobs from D1 (the suggestions board). */
async function getQueuedJobs(
  db: D1Database
): Promise<(RawJob & { ats: AtsType; applyUrl?: string })[]> {
  const { results } = await db
    .prepare(
      `SELECT url, apply_url, source, company, title, location, salary, ats
       FROM jobs WHERE status = 'queued'
       ORDER BY priority ASC, discovered_at ASC LIMIT 30`
    )
    .all<{ url: string; apply_url: string | null; source: string;
          company: string | null; title: string; location: string | null;
          salary: string | null; ats: string | null; }>();

  return results.map((r) => ({
    url: r.url,
    applyUrl: r.apply_url ?? undefined,
    source: r.source,
    company: r.company ?? undefined,
    title: r.title,
    location: r.location ?? undefined,
    salary: r.salary ?? undefined,
    ats: (r.ats as AtsType) ?? "unknown",
  }));
}

// ── dashboard discovery-only (kept for "Run now" button) ─────────────

export async function discoverOnly(
  env: PipelineEnv
): Promise<{ discovered: number }> {
  const config = await getConfig(env.CONFIG);
  if (config.paused) return { discovered: 0 };

  await requeueStaleApplying(env.DB);
  const runId = await startRun(env.DB, "manual");

  // Same scout logic but collect all passing jobs for the dashboard
  const rawJobs = await searchAllSources(config.searchTerms);
  rawJobs.sort(
    (a, b) =>
      termPriority(a.title, config.searchTerms) - termPriority(b.title, config.searchTerms)
  );

  let inserted = 0;
  for (const job of rawJobs) {
    const filter = filterJob(job, config);
    if (!filter.pass) continue;

    let ats = classifyAtsFromUrl(job.applyUrl ?? job.url);
    let applyUrl = job.applyUrl;

    if (ats === "unknown") {
      const resolved = await resolveApplyUrl(job.url);
      if (resolved) { ats = resolved.ats; applyUrl = resolved.applyUrl; }
    }

    const id = await insertJob(env.DB, {
      ...job, applyUrl, ats,
      status: "queued" as JobStatus,
      priority: termPriority(job.title, config.searchTerms),
    });
    if (id > 0) inserted++;
  }

  await finishRun(env.DB, runId, { discovered: inserted, applied: 0, skipped: 0, failed: 0 });
  return { discovered: inserted };
}
