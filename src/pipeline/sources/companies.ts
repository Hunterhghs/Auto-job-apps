import type { RawJob } from "../../types";

/**
 * Company watchlist — KV-backed registry of companies per ATS platform.
 * Falls back to hardcoded defaults when KV is empty. Companies can be
 * added/removed via the dashboard without redeploying.
 */

export interface CompanyEntry {
  slug: string;
  ats: string;
  added: string;   // ISO date
  lastSeen: number; // job count last crawl, -1 if never crawled
}

const WATCHLIST_KEY = "company-watchlist";

/** Default seed lists per ATS — used when KV is empty. */
export const DEFAULT_COMPANIES: Record<string, string[]> = {
  greenhouse: [
    "stripe", "datadog", "mongodb", "samsara", "cloudflare", "brex", "roblox",
    "airbnb", "reddit", "affirm", "elastic", "figma", "twilio", "klaviyo",
    "lyft", "flexport", "asana", "ripple", "quince", "intercom", "fivetran",
    "instacart", "rubrik", "nuro", "stackadapt", "taboola", "securityscorecard",
    "gusto", "chime", "peloton", "humaninterest", "duolingo", "checkr", "mercury",
    "tekion", "discord", "marqeta", "dropbox", "everlaw", "simplisafe", "gofundme",
    "stockx", "gemini", "cockroachlabs", "project44", "contentful", "kalshi",
    "webflow", "khanacademy", "uplift", "nextdoor", "udacity", "sendbird",
    "pagerduty", "starburst", "smartrent", "stitchfix", "rumble", "relocity",
    "circleci", "synack", "truelayer", "udemy",
  ],
  ashby: [
    "snowflake", "maintainx", "notion", "ramp", "plaid", "cursor", "openai",
    "replit", "langchain", "perplexity", "deepgram", "clickup", "thumbtack",
    "temporal", "supabase", "benchling", "sentry", "speak", "talentful",
    "kalshi", "miro", "strava", "confluent", "sandboxaq", "paddle", "overjet",
    "ditto", "linear", "radiant", "semgrep", "warp", "incident", "trulioo",
    "posthog", "parallel", "sequence", "middesk", "revenuecat", "photoroom",
    "patreon", "zapier", "zilch", "honeybook", "mintlify", "playground",
    "surveymonkey", "insitro", "lunar", "camber", "signoz", "terranova",
    "planera", "seon", "protege", "substack", "granica", "netbird", "infisical",
    "endex", "nylas", "railway", "tourlane", "percona", "readme",
  ],
};

/**
 * Get the company list for a given ATS. Tries KV first, falls back to
 * hardcoded defaults. Returns deduplicated slugs.
 */
export async function getCompanies(
  kv: KVNamespace,
  ats: string
): Promise<string[]> {
  try {
    const raw = await kv.get(`${WATCHLIST_KEY}:${ats}`);
    if (raw) {
      const entries = JSON.parse(raw) as CompanyEntry[];
      if (entries.length > 0) {
        return [...new Set(entries.map((e) => e.slug))];
      }
    }
  } catch { /* fall through to defaults */ }
  return DEFAULT_COMPANIES[ats] ?? [];
}

/**
 * Add a company to the watchlist for a given ATS.
 * Returns the updated company list.
 */
export async function addCompany(
  kv: KVNamespace,
  ats: string,
  slug: string
): Promise<string[]> {
  const entries = await loadEntries(kv, ats);
  const existing = entries.find((e) => e.slug === slug);
  if (!existing) {
    entries.push({ slug, ats, added: new Date().toISOString(), lastSeen: -1 });
    await saveEntries(kv, ats, entries);
  }
  return entries.map((e) => e.slug);
}

/**
 * Remove a company from the watchlist.
 */
export async function removeCompany(
  kv: KVNamespace,
  ats: string,
  slug: string
): Promise<string[]> {
  const entries = await loadEntries(kv, ats);
  const filtered = entries.filter((e) => e.slug !== slug);
  await saveEntries(kv, ats, filtered);
  return filtered.map((e) => e.slug);
}

/**
 * Get all watchlist entries for the dashboard.
 */
export async function getWatchlist(
  kv: KVNamespace
): Promise<Record<string, CompanyEntry[]>> {
  const result: Record<string, CompanyEntry[]> = {};
  for (const ats of Object.keys(DEFAULT_COMPANIES)) {
    result[ats] = await loadEntries(kv, ats);
  }
  return result;
}

async function loadEntries(kv: KVNamespace, ats: string): Promise<CompanyEntry[]> {
  try {
    const raw = await kv.get(`${WATCHLIST_KEY}:${ats}`);
    if (raw) return JSON.parse(raw) as CompanyEntry[];
  } catch { /* fall through */ }
  // Seed from defaults if KV is empty
  const slugs = DEFAULT_COMPANIES[ats] ?? [];
  return slugs.map((slug) => ({
    slug,
    ats,
    added: new Date().toISOString(),
    lastSeen: -1,
  }));
}

async function saveEntries(
  kv: KVNamespace,
  ats: string,
  entries: CompanyEntry[]
): Promise<void> {
  await kv.put(`${WATCHLIST_KEY}:${ats}`, JSON.stringify(entries));
}
