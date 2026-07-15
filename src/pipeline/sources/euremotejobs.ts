import type { RawJob } from "../../types";

/**
 * euremotejobs.com runs WP Job Manager, which exposes an RSS feed that
 * accepts a search_keywords param. We query per term and parse with regex
 * (no DOM parser in Workers).
 */
export async function fetchEuRemoteJobs(searchTerms: string[]): Promise<RawJob[]> {
  const feeds = await Promise.allSettled(
    searchTerms.map((term) =>
      fetch(
        `https://euremotejobs.com/?feed=job_feed&search_keywords=${encodeURIComponent(term)}`,
        { headers: { "User-Agent": "Mozilla/5.0 (compatible; auto-job-apps/1.0)" } }
      ).then((res) => (res.ok ? res.text() : ""))
    )
  );

  const jobs: RawJob[] = [];
  const items = feeds
    .filter((f): f is PromiseFulfilledResult<string> => f.status === "fulfilled")
    .flatMap((f) => f.value.split("<item>").slice(1));
  for (const item of items) {
    const title = extract(item, "title");
    const link = extract(item, "link");
    if (!title || !link) continue;
    // WP Job Manager titles are often "Job Title - Company"
    const parts = title.split(/\s+[-–]\s+/);
    jobs.push({
      url: link,
      source: "euremotejobs",
      title: parts[0]?.trim() ?? title,
      company: parts.length > 1 ? parts[parts.length - 1].trim() : undefined,
      location: extract(item, "job_listing:location") ?? "Remote (EU)",
      description: stripCdata(extract(item, "description") ?? "")
        .replace(/<[^>]+>/g, " ")
        .slice(0, 4000),
    });
  }
  return jobs;
}

function extract(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return match ? stripCdata(match[1]).trim() : undefined;
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}
