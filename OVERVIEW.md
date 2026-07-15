# Auto Job App — Project Overview

An autonomous job-application agent that runs continuously for months, discovers remote Business/Analyst/Writing roles in the US & EU, and applies to **10–25 jobs per day** on behalf of Hunter Hughes — targeting simple, single-page application forms. Deployed on **Cloudflare Workers** from a **GitHub repo**, with a **live web dashboard** for monitoring progress.

---

## 1. Goal

| Item | Value |
|---|---|
| Daily volume | 10–25 applications/day (configurable) |
| Duration | Months of unattended operation |
| Job types | Business Analyst, Market Research, Strategy, Writing/Content, Consulting, gig/digital-economy roles |
| Seniority | Entry and mid level (bachelor's degree) |
| Geography | Remote — US & EU |
| Form targets | Simple 1-page ATS applications (Ashby, Greenhouse, Lever, Workable) |
| Compensation | $40,000–$110,000 salary · $20–$75/hr for contract/freelance gigs |

**Job sources** (more can be added anytime):

1. [euremotejobs.com](https://euremotejobs.com)
2. [remotefront.com](https://www.remotefront.com)
3. [hiringcafe.com](https://hiringcafe.com)
4. [workingnomads.com/jobs](https://www.workingnomads.com/jobs)
5. [dailyremote.com](https://dailyremote.com)
6. [workew.com](https://workew.com)
7. [remoteleaf.com](https://remoteleaf.com)
8. [remotive.com](https://remotive.com)
9. [himalayas.app](https://himalayas.app)

## 2. Applicant Profile

Sourced from `Hunter_Hughes_Resume.pdf` plus demographic details provided by the user. Stored as a single structured profile (JSON) that powers every form fill.

- **Name:** Hunter Hughes
- **Location:** Chapel Hill, NC (US-based, remote)
- **Email:** hunterhughesr@outlook.com · **Phone:** (919) 360-3499
- **Headline:** Business Analyst · Founder & CEO of H Heuristics LLC (market research & advisory)
- **Highlights:** 40+ Upwork engagements ($30K+, Top Rated, 100% JSS), 84+ published market intelligence reports, ~2,100-subscriber economic advisory Substack, BSBA Management (Magna Cum Laude, App State), CFI BIDA® & FTIP™, SAS Statistical Business Analyst
- **Work authorization:** US citizen, authorized to work in the US without sponsorship
- **Education:** Bachelor's degree (BSBA Management) — targets entry and mid-level roles
- **Salary expectations:** $40,000–$110,000 annual · $20–$75/hr for contract/freelance work
- **Links:** Upwork — [upwork.com/freelancers/hunterhughes](https://www.upwork.com/freelancers/hunterhughes?mp_source=share) · Personal website — [hheuristics.com](https://www.hheuristics.com)
- **Voluntary EEO answers:** White, male, heterosexual, he/him, non-veteran, no disability (used only where forms ask; any field can be switched to "decline to answer")
- **Assets:** Resume PDF (stored in R2), reusable cover-letter template with per-job AI customization, Upwork/website/Substack URLs

## 3. Architecture (Cloudflare Stack)

```
GitHub repo ──(CI: wrangler deploy)──► Cloudflare Workers

┌─────────────────────────────────────────────────────────┐
│  Cron Trigger (every ~30–60 min, jittered)              │
│    1. SCRAPER    — pull new listings from sources       │
│    2. FILTER     — match against role/geo/keyword rules │
│    3. CLASSIFIER — detect ATS type, score "easy apply"  │
│    4. QUEUE      — dedupe, rate-limit to daily budget   │
│    5. APPLIER    — Browser Rendering (Puppeteer) fills  │
│                    & submits the form; AI answers       │
│                    custom questions & tailors cover      │
│                    letter (Workers AI / external LLM)   │
│    6. LOGGER     — write outcome + screenshot to D1/R2  │
└─────────────────────────────────────────────────────────┘

Dashboard (Worker static assets + API) ◄── D1 (SQLite)
Resume & screenshots ◄── R2        Config/state ◄── KV
```

**Cloudflare services used**

- **Workers + Cron Triggers** — scheduling and all pipeline logic; runs spread across the day with random jitter so activity looks human.
- **Browser Rendering API** (Puppeteer for Workers) — loads the ATS page, uploads the resume, fills fields, answers dropdowns/radios (work auth, EEO), submits, and captures a confirmation screenshot.
- **D1** — database of record: jobs discovered, applications submitted, statuses, errors, daily counters.
- **R2** — resume PDF(s), generated cover letters, per-application confirmation screenshots.
- **KV** — runtime config (daily cap, keyword rules, pause switch) editable from the dashboard without redeploying.
- **Workers AI (or OpenAI/Anthropic API)** — generates answers to free-text questions ("Why do you want to work here?", salary expectations) and tailors the cover letter to each job description.

## 4. Application Strategy

**Targeted ATS platforms (the "simple 1-page" forms):**

1. **Ashby** (`jobs.ashbyhq.com`) — like the Chainalysis form: name, email, resume upload, phone, LinkedIn, yes/no authorization questions.
2. **Greenhouse** (`boards.greenhouse.io` / embedded) — first/last name, email, phone, resume, plus a few custom text questions.
3. **Lever** (`jobs.lever.co`) and **Workable** — same pattern.

Each ATS gets a **form adapter**: a field-mapping layer that knows that platform's DOM structure, plus an AI fallback that reads unrecognized labels and maps them to profile fields or generates an answer. Applications that can't be completed confidently (CAPTCHA, multi-step login walls, unanswerable required questions) are **skipped and flagged for manual review** in the dashboard rather than submitted badly.

**Filtering rules (configurable):**
- Title/keyword match: analyst, research, strategy, writing, content, consulting, operations, etc.
- Seniority: entry and mid level; skip roles requiring a master's/PhD or 8+ years of experience.
- Remote-only; US or EU eligible.
- Salary window: $40K–$110K annual or $20–$75/hr; exclude staffing-agency reposts; dedupe by company+title and by canonical ATS URL (never apply to the same job twice — enforced in D1).

**Job-board account integrations (Indeed, ZipRecruiter — later phase):**

Hunter can register accounts on Indeed and ZipRecruiter so the bot can use their "Easy Apply"/"1-Click Apply" flows. This is technically possible (stored session cookies + Browser Rendering) but comes with caveats: both platforms use aggressive bot detection and CAPTCHAs, logins expire and need periodic manual refresh, and automated applying violates their terms of service (account ban risk). The plan: build the direct-ATS pipeline first (Phases 1–5), then add these as an opt-in module where sessions are refreshed manually via the dashboard when they expire, and any CAPTCHA-blocked application drops into the needs-review queue.

## 5. Dashboard (Live Website)

Served by the same Worker at the root domain. Views:

- **Today** — applications submitted vs. daily budget, live pipeline status, last run time.
- **History** — searchable table of every application: company, role, source, ATS, date, status (submitted / skipped / failed / needs-review), link to confirmation screenshot.
- **Needs Review** — jobs the bot couldn't finish, with the reason, so Hunter can apply manually or teach the bot a new answer.
- **Charts** — applications/day over time, breakdown by ATS and source, skip/failure reasons.
- **Controls** — pause/resume, daily cap slider, keyword rules editor, canned answers library (all backed by KV).
- Simple auth (Cloudflare Access or a passcode) since it exposes personal data.

## 6. Operating Safeguards

- **Rate limiting & jitter** — hard daily cap, randomized run times, human-like typing delays via Puppeteer to avoid bot detection.
- **Never double-apply** — canonical job URL hashing in D1.
- **Quality gate** — required questions must map to a known profile answer or a high-confidence AI answer; otherwise skip to review queue.
- **Proof of submission** — confirmation-page screenshot stored in R2 for every application.
- **Email monitoring (later phase)** — optional Cloudflare Email Routing inbox to catch verification emails and recruiter replies.
- **Kill switch** — one-click pause from the dashboard.

## 7. Roadmap

| Phase | Deliverable |
|---|---|
| **1. Foundation** | Repo scaffold, Wrangler config, D1 schema, profile JSON, resume in R2, CI deploy from GitHub |
| **2. Discovery** | Scrapers for the 9 job sources (starting with euremotejobs.com and remotive.com, which have the cleanest structures), filter rules, job queue in D1 |
| **3. Applier** | Browser Rendering integration; Ashby + Greenhouse adapters; AI answer engine; screenshot logging |
| **4. Dashboard** | Live site: today/history/review/controls views |
| **5. Hardening** | Jitter, retries, error alerting, needs-review workflow, Lever/Workable adapters |
| **6. Scale** | Remaining job sources, Indeed/ZipRecruiter easy-apply module, email monitoring, response tracking (interviews landed) |

**Repo:** [github.com/Hunterhghs/Auto-job-apps](https://github.com/Hunterhghs/Auto-job-apps)

## 8. Open Items (need from Hunter)

- LinkedIn profile URL (if one should be included on applications — many forms have a dedicated field).
- Cover letter: one strong base template to start from (or the bot drafts one for approval).
- Cloudflare account to deploy under (and API token for CI deploys from GitHub).
- Indeed/ZipRecruiter account credentials — only when we reach the easy-apply module in Phase 6.

## 9. Honest Constraints

- Some applications sit behind CAPTCHAs, account logins (Workday, LinkedIn Easy Apply), or multi-page wizards — those are out of scope for auto-submit and go to the review queue instead. Indeed/ZipRecruiter easy apply is the exception, planned as an opt-in module in Phase 6 with the caveats noted in section 4.
- Automated applying violates some job boards' terms of service; sticking to direct ATS forms (Ashby/Greenhouse/Lever) and human-like pacing minimizes risk, but it can't be eliminated.
- Cloudflare Browser Rendering has session/time limits on paid plans; the daily volume of 10–25 fits comfortably within them.
