import puppeteer, { type Browser } from "@cloudflare/puppeteer";

/**
 * Launch a Browser Rendering session with retry on the new-browsers-per-
 * minute rate limit (429). keep_alive holds the session open across the
 * whole pipeline run so discovery and applying share one browser.
 */
export async function launchBrowser(binding: Fetcher): Promise<Browser> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await puppeteer.launch(binding, { keep_alive: 600_000 });
    } catch (err) {
      lastErr = err;
      if (String(err).includes("429")) {
        console.log(JSON.stringify({ event: "browser_rate_limited", attempt }));
        await new Promise((r) => setTimeout(r, 65_000));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
