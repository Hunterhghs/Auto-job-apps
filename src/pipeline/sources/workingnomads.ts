import type { RawJob } from "../../types";

interface WorkingNomadsJob {
  url: string;
  title: string;
  company_name: string;
  category_name: string;
  location: string;
  description?: string;
}

/** Working Nomads has no search API; keep only title matches on search terms. */
export async function fetchWorkingNomads(searchTerms: string[]): Promise<RawJob[]> {
  const res = await fetch("https://www.workingnomads.com/api/exposed_jobs/", {
    headers: { "User-Agent": "auto-job-apps/1.0" },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as WorkingNomadsJob[];
  const terms = searchTerms.map((t) => t.toLowerCase());

  return data
    .filter((j) => {
      const title = j.title.toLowerCase();
      return terms.some((t) => title.includes(t));
    })
    .map((j) => ({
      url: j.url,
      source: "workingnomads",
      company: j.company_name,
      title: j.title,
      location: j.location || "Remote",
      description: j.description?.replace(/<[^>]+>/g, " ").slice(0, 4000),
    }));
}
