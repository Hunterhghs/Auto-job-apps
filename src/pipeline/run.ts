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
import { fetchAllSources } from "./sources";
import { filterJob } from "./filter";
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
const PER_RUN_CAP = 3;
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
    // 1. DISCOVER: fetch sources, filter, resolve ATS, queue in D1
    const rawJobs = await fetchAllSources();
    const toInsert: (RawJob & { ats: AtsType; status: JobStatus; skipReason?: string })[] = [];
    let resolveBudget = RESOLVE_CAP;

    for (const job of rawJobs) {
      const filter = filterJob(job, config);
      if (!filter.pass) {
        toInsert.push({ ...job, ats: "unknown", status: "skipped", skipReason: filter.reason });
        continue;
      }

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

      if (ats === "unknown") {
        toInsert.push({ ...job, ats, status: "needs_review", skipReason: "unsupported or undetected ATS" });
      } else if (ats === "workable") {
        // Workable adapter not built yet; park for manual review
        toInsert.push({ ...job, applyUrl, ats, status: "needs_review", skipReason: "workable adapter pending" });
      } else {
        toInsert.push({ ...job, applyUrl, ats, status: "queued" });
      }
    }

    stats.discovered = await insertJobs(env.DB, toInsert);
    console.log(JSON.stringify({ event: "discovery_done", fetched: rawJobs.length, inserted: stats.discovered }));

    // 2. APPLY: respect daily budget, apply to a small batch this run
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
