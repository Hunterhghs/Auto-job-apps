import type { RawJob } from "../../types";

/**
 * Direct Greenhouse API search — queries individual company boards for
 * analyst roles. Every result has a known ATS form (Greenhouse) so the
 * apply pipeline can fill it immediately without ATS resolution.
 */

// Verified active Greenhouse companies (tested 2026-07-16).
// Sorted by total job count; companies with 10+ jobs kept.
// Dead/404 companies removed: doordash, rippling, notion, zapier, lawnstarter, retool, dbt-labs, pachama, tryfinch, plaid.
const GREENHOUSE_COMPANIES = [
  // 200+ jobs
  "stripe",          // 526
  "datadog",         // 420
  "mongodb",         // 387
  "samsara",         // 312
  "cloudflare",      // 271
  "brex",            // 252
  "roblox",          // 233
  "airbnb",          // 198
  "reddit",          // 193
  "affirm",          // 175
  "elastic",         // 170
  "figma",           // 167
  "twilio",          // 165
  "klaviyo",         // 159
  "lyft",            // 157
  "flexport",        // 149
  "asana",           // 147
  "ripple",          // 140
  "quince",          // 139
  "intercom",        // 137
  "fivetran",        // 132
  "instacart",       // 125
  // 50-200 jobs
  "rubrik",          // 103
  "nuro",            // 92
  "stackadapt",      // 87
  "taboola",         // 83
  "securityscorecard", // 76
  "gusto",           // 75
  "chime",           // 70
  "peloton",         // 65
  "humaninterest",   // 63
  "duolingo",        // 62
  "checkr",          // 61
  "mercury",         // 58
  "tekion",          // 58
  "discord",         // 52
  // 20-50 jobs
  "marqeta",         // 41
  "dropbox",         // 40
  "everlaw",         // 33
  "simplisafe",      // 31
  "gofundme",        // 31
  "stockx",          // 31
  "gemini",          // 33
  "cockroachlabs",   // 35
  "project44",       // 28
  "contentful",      // 28
  "kalshi",          // 27
  "webflow",         // 26
  "khanacademy",     // 24
  "uplift",          // 22
  "nextdoor",        // 16
  "udacity",         // 16
  "sendbird",        // 17
  "pagerduty",       // 17
  "starburst",       // 15
  "smartrent",       // 14
  "stitchfix",       // 13
  "rumble",          // 13
  "relocity",        // 12
  "circleci",        // 10
  "synack",          // 10
  "truelayer",       // 9
  "udemy",           // 8
];

/** Query each Greenhouse board for analyst jobs matching search terms. */
export async function fetchGreenhouseDirect(searchTerms: string[]): Promise<RawJob[]> {
  const terms = searchTerms.map((t) => t.toLowerCase());
  const jobs: RawJob[] = [];
  const seen = new Set<string>();

  // Query boards in parallel, 4 at a time (avoid rate limiting)
  const chunks = chunk(GREENHOUSE_COMPANIES, 4);

  for (const chunk of chunks) {
    const results = await Promise.allSettled(
      chunk.map(async (slug) => {
        try {
          const res = await fetch(
            `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
            { headers: { "User-Agent": "auto-job-apps/1.0" } }
          );
          if (!res.ok) return [];
          const data = (await res.json()) as {
            jobs?: {
              id: number;
              title: string;
              company_name: string;
              absolute_url: string;
              location?: { name: string };
            }[];
          };

          const matches: RawJob[] = [];
          for (const j of data.jobs ?? []) {
            const titleLower = j.title.toLowerCase();

            // Title must contain at least one search term
            if (!terms.some((t) => titleLower.includes(t))) continue;

            // Filter out senior/irrelevant roles
            if (/senior|sr\.|staff|principal|director|vp|vice president|head of|chief|lead|engineer|software|developer|counsel|attorney|legal/i.test(titleLower)) {
              continue;
            }

            const url = j.absolute_url || `https://boards.greenhouse.io/${slug}/jobs/${j.id}`;
            const key = url.split("?")[0].toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);

            const loc = j.location?.name || "Remote";

            // Location filter: US, EU, Remote
            const locLower = loc.toLowerCase();
            if (!/\b(usa?|united states|americas?|north america|eu|europe|emea|worldwide|anywhere|global|remote|canada|uk|ireland|germany|poland|netherlands|france|spain)\b/.test(locLower)) {
              continue;
            }

            matches.push({
              url,
              applyUrl: url,
              source: "greenhouse-direct",
              company: j.company_name || slug.charAt(0).toUpperCase() + slug.slice(1),
              title: j.title,
              location: loc,
            });
          }
          return matches;
        } catch {
          return [];
        }
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled") jobs.push(...r.value);
    }
  }

  return jobs;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
