export type JobStatus =
  | "queued"
  | "applying"
  | "applied"
  | "skipped"
  | "failed"
  | "needs_review"
  | "dismissed";

export type AtsType = "ashby" | "greenhouse" | "lever" | "workable" | "unknown";

export interface RawJob {
  url: string;
  applyUrl?: string;
  source: string;
  company?: string;
  title: string;
  location?: string;
  salary?: string;
  description?: string;
}

export interface JobRow {
  id: number;
  url_hash: string;
  url: string;
  apply_url: string | null;
  source: string;
  company: string | null;
  title: string;
  location: string | null;
  salary: string | null;
  ats: AtsType | null;
  status: JobStatus;
  skip_reason: string | null;
  error: string | null;
  answers_json: string | null;
  screenshot_key: string | null;
  discovered_at: string;
  applied_at: string | null;
}

export interface AppConfig {
  paused: boolean;
  dailyCap: number;
  includeKeywords: string[];
  excludeKeywords: string[];
  salaryMinAnnual: number;
  salaryMaxAnnual: number;
  hourlyMin: number;
  hourlyMax: number;
}

export interface ApplyResult {
  status: Extract<JobStatus, "applied" | "skipped" | "failed" | "needs_review">;
  reason?: string;
  answers?: Record<string, string>;
  screenshotKey?: string;
}
