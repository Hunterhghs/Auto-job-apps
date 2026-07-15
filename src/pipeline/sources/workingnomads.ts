import type { RawJob } from "../../types";

interface WorkingNomadsJob {
  url: string;
  title: string;
  company_name: string;
  category_name: string;
  location: string;
  description?: string;
}

const CATEGORIES = new Set([
  "Marketing",
  "Sales",
  "Writing",
  "Finance",
  "Consulting",
  "Management",
  "Legal",
  "Administration",
]);

export async function fetchWorkingNomads(): Promise<RawJob[]> {
  const res = await fetch("https://www.workingnomads.com/api/exposed_jobs/", {
    headers: { "User-Agent": "auto-job-apps/1.0" },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as WorkingNomadsJob[];
  return data
    .filter((j) => CATEGORIES.has(j.category_name))
    .map((j) => ({
      url: j.url,
      source: "workingnomads",
      company: j.company_name,
      title: j.title,
      location: j.location || "Remote",
      description: j.description?.replace(/<[^>]+>/g, " ").slice(0, 4000),
    }));
}
