import type { AtsType, JobStatus, RawJob } from "../types";
import { getConfig } from "../config";
import {
  insertJobs,
  appliedTodayCount,
  nextQueuedJobs,
  updateJobStatus,
  updateJobAts,
  startRun,
  finishRun,
} from "../db";
import type { Browser } from "@cloudflare/puppeteer";
import { searchAllSources } from "./sources";
import { searchBrowserBoards } from "./sources/browser-boards";
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

  // One browser session shared by the whole run (discovery + applying):
  // Browser Rendering rate-limits new browser launches per minute
  let browser: Browser | null = null;
  const getBrowser = async (): Promise<Browser> => {
    if (!browser || !browser.isConnected()) {
      browser = await launchBrowser(env.BROWSER);
    }
    return browser;
  };

  try {
    // 1. DISCOVER - only when the queue needs topping up. Search each source
    // for the configured terms, keep only relevant + applyable jobs, and
    // discard everything else without storing it.
    const queueDepth = await queuedCount(env.DB);
    if (queueDepth < QUEUE_TARGET) {
      // API-backed sources first; browser-driven boards (searched via the
      // headless browser: keyword entry + remote filters) top up the rest
      const rawJobs = await searchAllSources(config.searchTerms);
      // Browser boards only when APIs came back thin - saves browser time
      if (rawJobs.length < 30) {
        const browserJobs = await getBrowser()
          .then((b) => searchBrowserBoards(b, config.searchTerms))
          .catch((err) => {
            console.log(JSON.stringify({ event: "browser_discovery_failed", err: String(err) }));
            return [];
          });
        rawJobs.push(...browserJobs);
      }

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

        // Cheap resolve first (works when the board's HTML embeds ATS links)
        if (ats === "unknown" && resolveBudget > 0) {
          resolveBudget--;
          const resolved = await resolveApplyUrl(job.url);
          if (resolved) {
            ats = resolved.ats;
            applyUrl = resolved.applyUrl;
          }
        }

        if (ats === "workable") {
          toInsert.push({ ...job, applyUrl, ats, status: "needs_review", skipReason: "workable adapter pending", priority });
        } else {
          // Queue even when the ATS is still unknown - the applier navigates
          // the listing in the real browser to find the apply link, which
          // beats plain fetch (boards 403 it or render links with JS)
          toInsert.push({ ...job, applyUrl, ats, status: "queued", priority });
          queued++;
        }
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
      // Keep pulling from the queue until this run lands its quota of real
      // applications (dead ends don't count against the daily budget)
      let attempts = 0;
      const maxAttempts = batchSize * 3;

      while (stats.applied < batchSize && attempts < maxAttempts) {
        const batch = await nextQueuedJobs(env.DB, batchSize - stats.applied);
        if (batch.length === 0) break;
        attempts += batch.length;

        for (const job of batch) {
          await updateJobStatus(env.DB, job.id, "applying");
        }

        const results = await applyToJobs(env, await getBrowser(), batch);
        for (const [jobId, result] of results) {
          if (result.resolvedAts && result.resolvedApplyUrl) {
            await updateJobAts(env.DB, jobId, result.resolvedAts, result.resolvedApplyUrl);
          }
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
      }
    } else {
      console.log(JSON.stringify({ event: "daily_budget_reached", appliedToday }));
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

async function queuedCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
