import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { getConfig, setConfig } from "../config";
import { runPipeline, discoverOnly, type PipelineEnv } from "../pipeline/run";
import type { AppConfig } from "../types";

export interface ApiEnv extends PipelineEnv {
  DASHBOARD_PASSCODE?: string;
}

type HonoEnv = { Bindings: ApiEnv };

const SESSION_COOKIE = "aja_session";

async function sessionToken(passcode: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`aja-session:${passcode}`)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.byteLength !== bBytes.byteLength) return false;
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
}

export const api = new Hono<HonoEnv>().basePath("/api");

api.post("/login", async (c) => {
  const { passcode } = await c.req.json<{ passcode?: string }>();
  const expected = c.env.DASHBOARD_PASSCODE;
  if (!expected || !passcode || !timingSafeEqualStr(passcode, expected)) {
    return c.json({ ok: false, error: "invalid passcode" }, 401);
  }
  setCookie(c, SESSION_COOKIE, await sessionToken(expected), {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
  return c.json({ ok: true });
});

// All routes below require a valid session
api.use("*", async (c, next) => {
  if (c.req.path === "/api/login") return next();
  const expected = c.env.DASHBOARD_PASSCODE;
  const cookie = getCookie(c, SESSION_COOKIE);
  if (!expected || !cookie || !timingSafeEqualStr(cookie, await sessionToken(expected))) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  await next();
});

api.get("/stats", async (c) => {
  const db = c.env.DB;
  const [today, total, byStatus, daily, lastRun, recentRuns] = await Promise.all([
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM jobs WHERE status='applied' AND date(applied_at)=date('now')`
      )
      .first<{ n: number }>(),
    db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status='applied'`).first<{ n: number }>(),
    db
      .prepare(`SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`)
      .all<{ status: string; n: number }>(),
    db
      .prepare(
        `SELECT date(applied_at) AS day, COUNT(*) AS n FROM jobs
         WHERE status='applied' AND applied_at >= date('now', '-30 days')
         GROUP BY day ORDER BY day`
      )
      .all<{ day: string; n: number }>(),
    db
      .prepare(`SELECT * FROM runs ORDER BY id DESC LIMIT 1`)
      .first<Record<string, unknown>>(),
    db
      .prepare(
        `SELECT started_at, applied, skipped, failed FROM runs
         WHERE date(started_at)=date('now') ORDER BY id`
      )
      .all<{ started_at: string; applied: number; skipped: number; failed: number }>(),
  ]);
  const config = await getConfig(c.env.CONFIG);
  return c.json({
    appliedToday: today?.n ?? 0,
    appliedTotal: total?.n ?? 0,
    dailyCap: config.dailyCap,
    paused: config.paused,
    byStatus: Object.fromEntries(byStatus.results.map((r) => [r.status, r.n])),
    daily: daily.results,
    lastRun,
    recentRuns: recentRuns.results,
  });
});

api.get("/applications", async (c) => {
  const status = c.req.query("status");
  const q = c.req.query("q");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10), 500);

  let sql = `SELECT id, source, company, title, location, salary, ats, status,
                    skip_reason, error, url, apply_url, screenshot_key,
                    discovered_at, applied_at
             FROM jobs WHERE 1=1`;
  const binds: unknown[] = [];
  if (status) {
    sql += ` AND status = ?`;
    binds.push(status);
  }
  if (q) {
    sql += ` AND (company LIKE ? OR title LIKE ?)`;
    binds.push(`%${q}%`, `%${q}%`);
  }
  sql += ` ORDER BY COALESCE(applied_at, discovered_at) DESC LIMIT ?`;
  binds.push(limit);

  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({ applications: results });
});

api.post("/jobs/:id/dismiss", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  await c.env.DB.prepare(`UPDATE jobs SET status='dismissed' WHERE id=?`).bind(id).run();
  return c.json({ ok: true });
});

api.post("/jobs/:id/requeue", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  await c.env.DB
    .prepare(`UPDATE jobs SET status='queued', error=NULL, skip_reason=NULL WHERE id=?`)
    .bind(id)
    .run();
  return c.json({ ok: true });
});

api.get("/config", async (c) => {
  return c.json(await getConfig(c.env.CONFIG));
});

api.put("/config", async (c) => {
  const patch = await c.req.json<Partial<AppConfig>>();
  const next = await setConfig(c.env.CONFIG, patch);
  return c.json(next);
});

api.post("/run", async (c) => {
  // Manual trigger: discovery only (fast, no browser). The cron applies
  // discovered jobs because browser-based form filling needs the 15-min
  // CPU window that only cron triggers get.
  c.executionCtx.waitUntil(
    discoverOnly(c.env).catch((err) =>
      console.log(JSON.stringify({ event: "manual_discover_failed", err: String(err) }))
    )
  );
  return c.json({ ok: true, started: true });
});

api.get("/screenshot/:key{.+}", async (c) => {
  const key = c.req.param("key");
  const obj = await c.env.FILES.get(key);
  if (!obj) return c.text("not found", 404);
  return new Response(obj.body, {
    headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600" },
  });
});

// Queue board — available jobs filtered from today's batch
api.get("/queue-board", async (c) => {
  const db = c.env.DB;
  const { results } = await db
    .prepare(
      `SELECT id, company, title, source, ats, location, status, skip_reason, discovered_at
       FROM jobs
       WHERE date(discovered_at) = date('now')
         AND status IN ('queued', 'applying')
       ORDER BY priority ASC, discovered_at ASC
       LIMIT 50`
    )
    .all();
  return c.json({ jobs: results });
});

// Company watchlist
api.get("/watchlist", async (c) => {
  const { getWatchlist } = await import("../pipeline/sources/companies");
  const watchlist = await getWatchlist(c.env.CONFIG);
  // Merge with defaults for display
  const all: Record<string, { slug: string; ats: string; count: number }[]> = {};
  for (const [ats, entries] of Object.entries(watchlist)) {
    all[ats] = entries.map((e) => ({ slug: e.slug, ats: e.ats, count: e.lastSeen }));
  }
  return c.json({ watchlist: all });
});

// Daily job listings — every discovered job today with clickable URLs
api.get("/daily-jobs", async (c) => {
  const db = c.env.DB;
  const { results } = await db
    .prepare(
      `SELECT id, company, title, url, apply_url, source, ats, location, status, discovered_at
       FROM jobs
       WHERE date(discovered_at) = date('now')
       ORDER BY priority ASC, discovered_at DESC
       LIMIT 200`
    )
    .all();
  return c.json({ jobs: results });
});
