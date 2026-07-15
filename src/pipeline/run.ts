import type { AtsType, JobStatus, RawJob } from "../types";
import { getConfig } from "../config";
import {
  insertJobs,
  appliedTodayCount,
  nextQueuedJobs,
  updateJobStatus,
  startRun,
  finishRun,
} from "../db";
import { searchAllSources } from "./sources";
import { searchBrowserBoards } from "./sources/browser-boards";
import { filterJob, termPriority } from "./filter";
import { classifyAtsFromUrl, resolveApplyUrl } from "./classify";
import { applyToJobs } from "./apply";

export interface PipelineEnv {
  DB: D1Database;
  CONFIG: KVNamespace;
  FILES: R2Bucket;
  BROWSER: Fetcher;
  AI: Ai;
  DEEPSEEK_API_KEY?: string;
}

/** Max applications attempted per 30-min run (spreads volume across the day). */
const PER_RUN_CAP = 5;
/** Skip discovery entirely while this many jobs are already queued. */
const QUEUE_TARGET = 20;
/** Max listing URLs to resolve to ATS apply URLs per run (keeps runs fast). */
const RESOLVE_CAP = 25;

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

  try {
    // 1. DISCOVER - only when the queue needs topping up. Search each source
    // for the configured terms, keep only relevant + applyable jobs, and
    // discard everything else without storing it.
    const queueDepth = await queuedCount(env.DB);
    if (queueDepth < QUEUE_TARGET) {
      // API-backed sources first; browser-driven boards (searched via the
      // headless browser: keyword entry + remote filters) top up the rest
      const rawJobs = await searchAllSources(config.searchTerms);
      const browserJobs = await searchBrowserBoards(env.BROWSER, config.searchTerms).catch(
        (err) => {
          console.log(JSON.stringify({ event: "browser_discovery_failed", err: String(err) }));
          return [];
        }
      );
      rawJobs.push(...browserJobs);

      // Highest-priority term matches get queued (and applied) first
      rawJobs.sort(
        (a, b) =>
          termPriority(a.title, config.searchTerms) - termPriority(b.title, config.searchTerms)
      );

      const toInsert: (RawJob & { ats: AtsType; status: JobStatus; skipReason?: string; priority?: number })[] = [];
      let resolveBudget = RESOLVE_CAP;
      let queued = queueDepth;

      for (const job of rawJobs) {
        if (queued >= QUEUE_TARGET) break;

        const filter = filterJob(job, config);
        if (!filter.pass) continue; // discard - don't waste D1 rows on misses
        const priority = termPriority(job.title, config.searchTerms);

        let ats = classifyAtsFromUrl(job.applyUrl ?? job.url);
        let applyUrl = job.applyUrl;

        if (ats === "unknown" && resolveBudget > 0) {
          resolveBudget--;
          const resolved = await resolveApplyUrl(job.url);
          if (resolved) {
            ats = resolved.ats;
            applyUrl = resolved.applyUrl;
          }
        }

        if (ats === "ashby" || ats === "greenhouse" || ats === "lever") {
          toInsert.push({ ...job, applyUrl, ats, status: "queued", priority });
          queued++;
        } else if (ats === "workable") {
          toInsert.push({ ...job, applyUrl, ats, status: "needs_review", skipReason: "workable adapter pending", priority });
        }
        // unknown ATS: discard silently - relevant-but-unapplyable jobs were
        // flooding the review queue; revisit when more adapters exist
      }

      stats.discovered = await insertJobs(env.DB, toInsert);
      console.log(
        JSON.stringify({ event: "discovery_done", fetched: rawJobs.length, inserted: stats.discovered, queueDepth: queued })
      );
    } else {
      console.log(JSON.stringify({ event: "discovery_skipped", queueDepth }));
    }

    // 2. APPLY - respect the daily budget, drain the queue in batches
    const appliedToday = await appliedTodayCount(env.DB);
    const remainingToday = Math.max(0, config.dailyCap - appliedToday);
    const batchSize = Math.min(PER_RUN_CAP, remainingToday);

    if (batchSize > 0) {
      const batch = await nextQueuedJobs(env.DB, batchSize);
      for (const job of batch) {
        await updateJobStatus(env.DB, job.id, "applying");
      }

      const results = await applyToJobs(env, batch);
      for (const [jobId, result] of results) {
        await updateJobStatus(env.DB, jobId, result.status, {
          skipReason: result.reason,
          error: result.status === "failed" ? result.reason : undefined,
          answersJson: result.answers ? JSON.stringify(result.answers) : undefined,
          screenshotKey: result.screenshotKey,
        });
        if (result.status === "applied") stats.applied++;
        else if (result.status === "failed") stats.failed++;
        else stats.skipped++;
      }
    } else {
      console.log(JSON.stringify({ event: "daily_budget_reached", appliedToday }));
    }

    await finishRun(env.DB, runId, stats);
  } catch (err) {
    await finishRun(env.DB, runId, stats, `run error: ${String(err)}`);
    throw err;
  }

  return stats;
}

async function queuedCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
