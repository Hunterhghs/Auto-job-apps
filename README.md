# Auto Job Apps

Autonomous job-application agent on Cloudflare Workers. Discovers remote Business/Analyst/Writing roles from job boards, filters them, and auto-applies to simple single-page ATS forms (Ashby, Greenhouse, Lever) — 10–25 per day, for months, with a live dashboard.

See [OVERVIEW.md](./OVERVIEW.md) for the full design.

> **Note:** this repo contains personal application data (`profile/profile.json`). Keep it **private**.

## How it works

Every 30 minutes a cron trigger runs the pipeline:

1. **Discover** — fetch listings from Remotive, Himalayas, Working Nomads, and EU Remote Jobs.
2. **Filter** — keyword/seniority/location screen (entry & mid-level, remote US/EU).
3. **Classify** — resolve each listing to its ATS (Ashby / Greenhouse / Lever); unsupported ATSes go to the review queue.
4. **Apply** — Browser Rendering (Puppeteer) opens the form, fills it from `profile/profile.json`, answers custom questions with DeepSeek (Workers AI fallback), uploads the resume from R2, submits, and stores a confirmation screenshot.
5. **Log** — everything lands in D1 and shows up on the dashboard.

A hard daily cap (default 15, max 3 per run) plus randomized delays keep volume human-like. Jobs the bot can't finish confidently are flagged `needs_review` instead of being submitted badly — you can retry or dismiss them from the dashboard.

## One-time setup

```bash
npm install

# 1. Create the Cloudflare resources
npx wrangler d1 create auto-job-apps        # put database_id into wrangler.jsonc
npx wrangler kv namespace create CONFIG     # put id into wrangler.jsonc
npx wrangler r2 bucket create auto-job-apps

# 2. Apply the database schema
npm run db:schema:remote

# 3. Upload the resume
npx wrangler r2 object put auto-job-apps/resume/Hunter_Hughes_Resume.pdf \
  --file ~/Downloads/Hunter_Hughes_Resume.pdf

# 4. Secrets
npx wrangler secret put DASHBOARD_PASSCODE   # dashboard login
npx wrangler secret put DEEPSEEK_API_KEY     # AI answers & cover letters

# 5. Deploy
npm run deploy
```

For CI deploys, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions secrets — every push to `main` then deploys automatically.

Requires a Workers **Paid** plan (Browser Rendering + cron + D1).

## Dashboard

The Worker serves the dashboard at its root URL. Sign in with your `DASHBOARD_PASSCODE` to see:

- applications submitted today vs. the daily cap, total applied, queue depth
- a 30-day applications-per-day chart
- a searchable history of every job with status, reason, and confirmation screenshot
- a needs-review queue with retry/dismiss actions
- controls: pause/resume, run-now, daily cap, include/exclude keywords

## Local development

```bash
npm run types        # generate Env types from wrangler.jsonc
npm run dev          # local dev server (uses .dev.vars for secrets)
npm run db:schema:local
```

## Project layout

```
src/
  index.ts              Worker entry: fetch (dashboard) + scheduled (pipeline)
  config.ts             KV-backed runtime config
  db.ts                 D1 queries
  ai.ts                 DeepSeek / Workers AI answer engine
  profile.ts            applicant profile + known answers
  pipeline/
    run.ts              orchestrator (discover -> filter -> classify -> apply)
    filter.ts           keyword/seniority/location screening
    classify.ts         ATS detection + apply-URL resolution
    sources/            job board scrapers
    apply/              Browser Rendering form-filling (Ashby/Greenhouse/Lever)
  dashboard/api.ts      dashboard REST API (Hono)
public/                 dashboard website
profile/profile.json    applicant data (PII - keep repo private)
schema.sql              D1 schema
```
