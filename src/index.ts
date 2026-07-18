import { api, type ApiEnv } from "./dashboard/api";
import { runPipeline, dailyScrape } from "./pipeline/run";

interface Env extends ApiEnv {
  ASSETS: Fetcher;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return api.fetch(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx): Promise<void> {
    const cron = (controller as { cron?: string }).cron ?? "";
    const delayMs = Math.floor(Math.random() * 4 * 60 * 1000);

    ctx.waitUntil(
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));

        if (cron.includes("6") || cron.includes("18")) {
          // Daily scraper — runs at 06:00 and 18:00 UTC
          try {
            const count = await dailyScrape(env);
            console.log(JSON.stringify({ event: "daily_scrape_complete", jobs: count }));
          } catch (err) {
            console.log(JSON.stringify({ event: "daily_scrape_failed", err: String(err) }));
          }
        } else {
          // Apply pipeline — every 10 min, pulls from D1 queue
          try {
            const stats = await runPipeline(env, "cron");
            console.log(JSON.stringify({ event: "run_complete", ...stats }));
          } catch (err) {
            console.log(JSON.stringify({ event: "run_failed", err: String(err) }));
          }
        }
      })()
    );
  },

  // Email handler — receives forwarded emails, extracts verification codes
  async email(message, env, ctx): Promise<void> {
    try {
      const raw = await new Response(message.raw).text();
      // Extract 4-8 digit verification code from email body
      const codeMatch = raw.match(/\b(\d{4,8})\b/);
      if (codeMatch) {
        const code = codeMatch[1];
        // Store under well-known key — only one application runs at a time
        await env.CONFIG.put("verify:last_code", code, { expirationTtl: 300 });
        console.log(JSON.stringify({ event: "email_code_stored", code: "****" }));
      }
    } catch (err) {
      console.log(JSON.stringify({ event: "email_parse_failed", err: String(err) }));
    }
  },
} satisfies ExportedHandler<Env>;
