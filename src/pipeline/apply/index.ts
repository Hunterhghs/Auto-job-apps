import puppeteer from "@cloudflare/puppeteer";
import type { ApplyResult, JobRow } from "../../types";
import { fillAndSubmit } from "./generic";
import { sleep, jitter } from "./formkit";

interface ApplierEnv {
  BROWSER: Fetcher;
  AI: Ai;
  FILES: R2Bucket;
  DEEPSEEK_API_KEY?: string;
}

/** Ashby application forms live at <job-url>/application */
function toApplicationUrl(job: JobRow): string {
  const url = job.apply_url ?? job.url;
  if (job.ats === "ashby" && !/\/application\/?$/.test(url)) {
    return url.replace(/\/?$/, "/application");
  }
  if (job.ats === "lever" && !/\/apply\/?$/.test(url)) {
    return url.replace(/\/?$/, "/apply");
  }
  return url;
}

/**
 * Apply to a batch of jobs in one browser session. Returns results by job id.
 */
export async function applyToJobs(
  env: ApplierEnv,
  jobs: JobRow[]
): Promise<Map<number, ApplyResult>> {
  const results = new Map<number, ApplyResult>();
  if (jobs.length === 0) return results;

  const browser = await puppeteer.launch(env.BROWSER);
  try {
    for (const job of jobs) {
      const page = await browser.newPage();
      try {
        await page.setUserAgent(
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
        );
        await page.setViewport({ width: 1280, height: 1600 });
        await page.goto(toApplicationUrl(job), {
          waitUntil: "networkidle2",
          timeout: 45_000,
        });
        await sleep(jitter(1500, 3500));

        const result = await fillAndSubmit(page, env, job);

        // Store proof-of-outcome screenshot for every attempt
        try {
          const shot = (await page.screenshot({ fullPage: true })) as Buffer;
          const key = `screenshots/${job.id}-${Date.now()}.png`;
          await env.FILES.put(key, shot, {
            httpMetadata: { contentType: "image/png" },
          });
          result.screenshotKey = key;
        } catch (err) {
          console.log(JSON.stringify({ event: "screenshot_failed", job: job.id, err: String(err) }));
        }

        results.set(job.id, result);
        console.log(
          JSON.stringify({ event: "apply_result", job: job.id, company: job.company, status: result.status, reason: result.reason })
        );
      } catch (err) {
        results.set(job.id, { status: "failed", reason: String(err) });
        console.log(JSON.stringify({ event: "apply_error", job: job.id, err: String(err) }));
      } finally {
        await page.close();
      }
      // Human-like gap between applications within a session
      await sleep(jitter(8_000, 20_000));
    }
  } finally {
    await browser.close();
  }
  return results;
}
