import type { RawJob } from "../../types";

/**
 * Direct Ashby API scraper — queries individual company job boards for
 * business/analyst/writing roles. Every result maps to a known ATS (Ashby)
 * so the apply pipeline can fill immediately without ATS resolution.
 *
 * API: GET https://api.ashbyhq.com/posting-api/job-board/{company}
 * Public, no auth, no rate limit. Returns JSON with full job objects.
 */

const ASHBY_COMPANIES = [
  // 100+ jobs — highest volume companies
  "snowflake",       // 416
  "maintainx",       // 170
  "notion",          // 141
  "ramp",            // 126
  "plaid",           // 118
  "cursor",          // 117
  "openai",          // 710 (heavy engineering, large business dept too)
  "replit",          // 99
  "langchain",       // 98
  "perplexity",      // 84
  // 50-100 jobs
  "deepgram",        // 71
  "clickup",         // 64
  "thumbtack",       // 60
  "temporal",        // 58
  "supabase",        // 53
  "benchling",       // 51
  // 20-50 jobs
  "sentry",          // 48
  "speak",           // 43
  "talentful",       // 36
  "kalshi",          // 34
  "miro",            // 34
  "strava",          // 32
  "confluent",       // 31
  "sandboxaq",       // 31
  "paddle",          // 27
  "overjet",         // 26
  "ditto",           // 25
  "linear",          // 24
  "radiant",         // 23
  "semgrep",         // 22
  "warp",            // 22
  "incident",        // 21
  "trulioo",         // 21
  "posthog",         // 20
  "parallel",        // 20
  "sequence",        // 20
  "middesk",         // 20
  "revenuecat",      // 20
  "photoroom",       // 19
  "patreon",         // 18
  // 10-20 jobs — smaller but quality boards
  "zapier",          // 16
  "zilch",           // 16
  "honeybook",       // 15
  "mintlify",        // 15
  "playground",      // 15
  "surveymonkey",    // 15
  "insitro",         // 14
  "lunar",           // 14
  "camber",          // 14
  "signoz",          // 12
  "terranova",       // 12
  "planera",         // 12
  "seon",            // 12
  "protege",         // 12
  "substack",        // 11
  "granica",         // 10
  "netbird",         // 10
  // <10 jobs — niche but business-relevant
  "infisical",       // 8
  "endex",           // 8
  "nylas",           // 9
  "railway",         // 9
  "tourlane",        // 9
  "percona",         // 7
  "readme",          // 3
];

/** Query each Ashby board for matching jobs. */
export async function fetchAshbyDirect(searchTerms: string[]): Promise<RawJob[]> {
  const terms = searchTerms.map((t) => t.toLowerCase());
  const jobs: RawJob[] = [];
  const seen = new Set<string>();

  // Query boards in parallel, 4 at a time (polite crawling)
  const chunks = chunk(ASHBY_COMPANIES, 4);

  for (const chunk of chunks) {
    const results = await Promise.allSettled(
      chunk.map(async (slug) => {
        try {
          const res = await fetch(
            `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
            { headers: { "User-Agent": "auto-job-apps/1.0" } }
          );
          if (!res.ok) return [];
          const data = (await res.json()) as {
            jobs?: {
              id: string;
              title: string;
              department?: string;
              employmentType?: string;
              location?: string;
              isRemote?: boolean;
              workplaceType?: string;
              applyUrl?: string;
              descriptionPlain?: string;
              publishedAt?: string;
              address?: { postalAddress?: { addressCountry?: string } };
            }[];
          };

          const matches: RawJob[] = [];
          for (const j of data.jobs ?? []) {
            const titleLower = j.title.toLowerCase();

            // Title must contain at least one search term
            if (!terms.some((t) => titleLower.includes(t))) continue;

            // Filter out senior/irrelevant roles
            if (/\b(senior|sr\.|staff|principal|director|vp|vice president|head of|chief|lead|engineer|software|developer|counsel|attorney|legal|architect)\b/i.test(titleLower)) {
              continue;
            }

            // Filter out pure tech roles by department
            const dept = (j.department ?? "").toLowerCase();
            if (/\b(engineering|security|infrastructure|platform|devops|data engineering|sre)\b/i.test(dept)) {
              continue;
            }

            const url = j.applyUrl || `https://jobs.ashbyhq.com/${slug}/${j.id}`;
            const key = url.split("?")[0].toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);

            const loc = j.location || j.address?.postalAddress?.addressCountry || "Remote";

            // Location filter: US, EU, Remote, or explicitly remote-friendly
            const locLower = loc.toLowerCase();
            if (!/\b(usa?|united states|americas?|north america|eu|europe|emea|worldwide|anywhere|global|remote|canada|uk|ireland|germany|poland|netherlands|france|spain|italy|portugal|sweden|denmark|norway|finland|belgium|austria|switzerland|london|dublin|berlin|paris|amsterdam|remote|hybrid)\b/i.test(locLower) && !j.isRemote) {
              continue;
            }

            matches.push({
              url,
              applyUrl: url,
              source: "ashby-direct",
              company: companyName(slug),
              title: j.title,
              location: loc,
              description: j.descriptionPlain?.slice(0, 4000),
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

function companyName(slug: string): string {
  return slug
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
