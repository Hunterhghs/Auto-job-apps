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
    // Jitter the start inside the cron window so activity isn't clockwork
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
} satisfies ExportedHandler<Env>;
