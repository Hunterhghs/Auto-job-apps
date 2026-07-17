import type { Browser, Page } from "@cloudflare/puppeteer";
import type { ApplyResult, AtsType, JobRow } from "../../types";
import { classifyAtsFromUrl } from "../classify";
import { fillAndSubmit } from "./generic";
import { sleep, jitter } from "./formkit";

interface ApplierEnv {
  BROWSER: Fetcher;
  AI: Ai;
  FILES: R2Bucket;
  CONFIG?: KVNamespace;
  DEEPSEEK_API_KEY?: string;
}

/** Ashby application forms live at <job-url>/application */
function toApplicationUrl(ats: AtsType | null, url: string): string {
  if (ats === "ashby" && !/\/application\/?$/.test(url)) {
    return url.replace(/\/?$/, "/application");
  }
  if (ats === "lever" && !/\/apply\/?$/.test(url)) {
    return url.replace(/\/?$/, "/apply");
  }
  return url;
}

const ATS_LINK =
  /https?:\/\/(jobs\.ashbyhq\.com|boards\.greenhouse\.io|job-boards\.greenhouse\.io|grnh\.se|jobs\.(?:eu\.)?lever\.co|apply\.workable\.com|[^"'\s<>]*\.breezy\.hr|(?:apply\.)?jazz\.co|jobs\.smartrecruiters\.com|[^"'\s<>]*\.bamboohr\.com|[^"'\s<>]*\.recruitee\.com|[^"'\s<>]*\.jobs\.personio\.com|[^"'\s<>]*\.teamtailor\.com)[^"'\s<>]*/i;

/**
 * For listings where the ATS is unknown: load the board's job page in the
 * real browser (so JS-rendered apply buttons exist), find the outbound
 * apply link, and follow it to the actual ATS. Returns the resolved ATS
 * page URL or null.
 */
async function resolveInBrowser(
  page: Page,
  listingUrl: string
): Promise<{ ats: AtsType; url: string } | null> {
  await page.goto(listingUrl, { waitUntil: "networkidle2", timeout: 45_000 });
  await sleep(jitter(1500, 3000));

  // 0. Board redirect links (e.g. workingnomads.com/job/go/...) can land
  //    directly on the ATS page
  const landedAts = classifyAtsFromUrl(page.url());
  if (landedAts !== "unknown") {
    return { ats: landedAts, url: page.url() };
  }

  // 1. Direct ATS hrefs anywhere in the rendered DOM
  const direct = await page.evaluate(() => {
    const hrefs: string[] = [];
    for (const a of document.querySelectorAll("a[href]")) {
      hrefs.push((a as { href: string }).href);
    }
    return hrefs;
  });
  for (const href of direct) {
    const match = href.match(ATS_LINK);
    if (match) {
      const ats = classifyAtsFromUrl(match[0]);
      if (ats !== "unknown") return { ats, url: match[0] };
    }
  }

  // 2. Follow the most prominent "Apply" link (boards often use their own
  //    redirect URLs that 403 plain fetches but work in a real browser)
  const applyHref = await page.evaluate(() => {
    const anchors = [...document.querySelectorAll("a[href]")] as {
      href: string;
      textContent: string | null;
    }[];
    const apply = anchors.find((a) =>
      /apply|application/i.test(a.textContent ?? "")
    );
    return apply?.href ?? null;
  });
  if (!applyHref || applyHref.startsWith("mailto:")) return null;

  try {
    await page.goto(applyHref, { waitUntil: "networkidle2", timeout: 45_000 });
    await sleep(2000);
    const finalUrl = page.url();
    const ats = classifyAtsFromUrl(finalUrl);
    if (ats !== "unknown") return { ats, url: finalUrl };
  } catch {
    return null;
  }
  return null;
}

/**
 * Apply to a batch of jobs in one browser session. Returns results by job id.
 */
export async function applyToJobs(
  env: ApplierEnv,
  browser: Browser,
  jobs: JobRow[]
): Promise<Map<number, ApplyResult>> {
  const results = new Map<number, ApplyResult>();
  if (jobs.length === 0) return results;

  for (const job of jobs) {
      const page = await browser.newPage();
      try {
        await page.setUserAgent(
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
        );
        await page.setViewport({ width: 1280, height: 1600 });

        // Unknown ATS: navigate the board listing to find the real ATS page
        let ats = job.ats;
        let applyUrl = job.apply_url ?? job.url;
        let resolved: { ats: AtsType; url: string } | null = null;
        if (!ats || ats === "unknown") {
          resolved = await resolveInBrowser(page, job.url);
          if (!resolved) {
            // ATS resolution failed, but the page is already loaded. Try to
            // fill the form on the current page — many boards embed the form
            // directly on the listing or use non-standard ATS platforms.
            const result = await fillAndSubmit(page, env, { ...job, ats: "unknown" });
            results.set(job.id, result);
            continue;
          }
          ats = resolved.ats;
          applyUrl = resolved.url;
        }

        await page.goto(toApplicationUrl(ats, applyUrl), {
          waitUntil: "networkidle2",
          timeout: 45_000,
        });
        await sleep(jitter(1500, 3500));

        const result = await fillAndSubmit(page, env, { ...job, ats });
        if (resolved) {
          result.resolvedAts = resolved.ats;
          result.resolvedApplyUrl = resolved.url;
        }

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
        await page.close().catch(() => {});
      }
      // Human-like gap between applications within a session
      await sleep(jitter(8_000, 20_000));
  }
  return results;
}
