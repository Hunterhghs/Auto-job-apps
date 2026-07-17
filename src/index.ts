import { api, type ApiEnv } from "./dashboard/api";
import { runPipeline } from "./pipeline/run";

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

  async scheduled(_controller, env, ctx): Promise<void> {
    const delayMs = Math.floor(Math.random() * 4 * 60 * 1000);
    ctx.waitUntil(
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        try {
          const stats = await runPipeline(env, "cron");
          console.log(JSON.stringify({ event: "run_complete", ...stats }));
        } catch (err) {
          console.log(JSON.stringify({ event: "run_failed", err: String(err) }));
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
        // Store in KV with 5-min TTL. Keyed by recipient so multiple
        // concurrent applications don't collide.
        const key = `verify:${message.to}`;
        await env.CONFIG.put(key, code, { expirationTtl: 300 });
        console.log(JSON.stringify({ event: "email_code_stored", to: message.to }));
      }
    } catch (err) {
      console.log(JSON.stringify({ event: "email_parse_failed", err: String(err) }));
    }
  },
} satisfies ExportedHandler<Env>;
