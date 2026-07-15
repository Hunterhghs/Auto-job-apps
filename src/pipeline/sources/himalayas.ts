import type { RawJob } from "../../types";

interface HimalayasJob {
  title: string;
  companyName: string;
  applicationLink?: string;
  guid?: string;
  locationRestrictions?: string[];
  minSalary?: number;
  maxSalary?: number;
  description?: string;
}

export async function fetchHimalayas(): Promise<RawJob[]> {
  const res = await fetch("https://himalayas.app/jobs/api?limit=100", {
    headers: { "User-Agent": "auto-job-apps/1.0" },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { jobs: HimalayasJob[] };
  return (data.jobs ?? [])
    .filter((j) => j.guid || j.applicationLink)
    .map((j) => ({
      url: j.guid ?? j.applicationLink!,
      applyUrl: j.applicationLink,
      source: "himalayas",
      company: j.companyName,
      title: j.title,
      location: j.locationRestrictions?.join(", ") || "Worldwide",
      salary:
        j.minSalary && j.maxSalary
          ? `$${j.minSalary}-$${j.maxSalary}`
          : undefined,
      description: j.description?.replace(/<[^>]+>/g, " ").slice(0, 4000),
    }));
}
