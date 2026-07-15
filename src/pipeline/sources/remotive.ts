import type { RawJob } from "../../types";

interface RemotiveJob {
  url: string;
  title: string;
  company_name: string;
  candidate_required_location: string;
  salary: string;
  description: string;
  job_type: string;
}

/** Query Remotive's search endpoint per term instead of pulling full categories. */
export async function fetchRemotive(searchTerms: string[]): Promise<RawJob[]> {
  const jobs: RawJob[] = [];
  for (const term of searchTerms) {
    const res = await fetch(
      `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(term)}&limit=20`,
      { headers: { "User-Agent": "auto-job-apps/1.0" } }
    );
    if (!res.ok) continue;
    const data = (await res.json()) as { jobs: RemotiveJob[] };
    for (const j of data.jobs ?? []) {
      jobs.push({
        url: j.url,
        source: "remotive",
        company: j.company_name,
        title: j.title,
        location: j.candidate_required_location,
        salary: j.salary || undefined,
        description: j.description?.replace(/<[^>]+>/g, " ").slice(0, 4000),
      });
    }
  }
  return jobs;
}
