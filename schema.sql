-- Auto Job Apps - D1 schema
-- Apply with: wrangler d1 execute auto-job-apps --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url_hash TEXT NOT NULL UNIQUE,          -- sha-256 of canonical job URL (dedupe)
  url TEXT NOT NULL,                      -- job listing URL on the source board
  apply_url TEXT,                         -- direct ATS application URL
  source TEXT NOT NULL,                   -- remotive | himalayas | workingnomads | euremotejobs | ...
  company TEXT,
  title TEXT NOT NULL,
  location TEXT,
  salary TEXT,
  ats TEXT,                               -- ashby | greenhouse | lever | workable | unknown
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | applying | applied | skipped | failed | needs_review | dismissed
  skip_reason TEXT,
  error TEXT,
  answers_json TEXT,                      -- answers submitted / AI-generated content
  screenshot_key TEXT,                    -- R2 key of confirmation screenshot
  priority INTEGER NOT NULL DEFAULT 99,   -- search-term rank; lower applies first
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_applied_at ON jobs(applied_at);
CREATE INDEX IF NOT EXISTS idx_jobs_discovered_at ON jobs(discovered_at);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  trigger TEXT NOT NULL DEFAULT 'cron',   -- cron | manual
  discovered INTEGER NOT NULL DEFAULT 0,
  applied INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);
