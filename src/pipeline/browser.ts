import puppeteer, { type Browser } from "@cloudflare/puppeteer";

/**
 * Launch a Browser Rendering session with exponential-backoff retry on
 * the new-browsers-per-minute rate limit (429). keep_alive holds the
 * session open across the whole pipeline run so discovery and applying
 * share one browser.
 *
 * Cloudflare free tier: 2 new browsers/min, 2 concurrent.
 * We wait 65-95s between attempts with jitter so retries span multiple
 * rate-limit windows.
 */
export async function launchBrowser(binding: Fetcher): Promise<Browser> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await puppeteer.launch(binding, { keep_alive: 600_000 });
    } catch (err) {
      lastErr = err;
      if (String(err).includes("429")) {
        const waitMs = 65_000 + Math.floor(Math.random() * 30_000);
        console.log(JSON.stringify({ event: "browser_rate_limited", attempt, waitMs }));
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
