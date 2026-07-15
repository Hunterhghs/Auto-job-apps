import type { RawJob } from "../../types";

interface HimalayasJob {
  title: string;
  companyName?: string;
  companySlug?: string;
  applicationLink?: string;
  guid?: string;
  locationRestrictions?: string[];
  minSalary?: number;
  maxSalary?: number;
  description?: string;
}

/**
 * Himalayas has no search API, so we pull one page and keep only jobs whose
 * title matches a search term. The API sometimes returns junk records with
 * companyName literally set to "name" - we fall back to the company slug.
 */
export async function fetchHimalayas(searchTerms: string[]): Promise<RawJob[]> {
  const res = await fetch("https://himalayas.app/jobs/api?limit=100", {
    headers: { "User-Agent": "auto-job-apps/1.0" },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { jobs: HimalayasJob[] };
  const terms = searchTerms.map((t) => t.toLowerCase());

  return (data.jobs ?? [])
    .filter((j) => {
      if (!j.guid && !j.applicationLink) return false;
      const title = j.title.toLowerCase();
      return terms.some((t) => title.includes(t));
    })
    .map((j) => ({
      url: j.guid ?? j.applicationLink!,
      applyUrl: j.applicationLink,
      source: "himalayas",
      company: cleanCompany(j),
      title: j.title,
      location: j.locationRestrictions?.join(", ") || "Worldwide",
      salary:
        j.minSalary && j.maxSalary
          ? `$${j.minSalary}-$${j.maxSalary}`
          : undefined,
      description: j.description?.replace(/<[^>]+>/g, " ").slice(0, 4000),
    }));
}

function cleanCompany(j: HimalayasJob): string | undefined {
  const name = j.companyName?.trim();
  if (name && name.toLowerCase() !== "name") return name;
  if (j.companySlug) {
    return j.companySlug
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
  return undefined;
}
