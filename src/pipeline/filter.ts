import type { AppConfig, RawJob } from "../types";

export interface FilterResult {
  pass: boolean;
  reason?: string;
}

/** Title/keyword/seniority/location screen applied to every discovered job. */
export function filterJob(job: RawJob, config: AppConfig): FilterResult {
  const title = job.title.toLowerCase();
  const haystack = `${title} ${job.description?.toLowerCase() ?? ""}`;

  const excluded = config.excludeKeywords.find((k) =>
    title.includes(k.toLowerCase())
  );
  if (excluded) return { pass: false, reason: `excluded keyword: ${excluded}` };

  const included = config.includeKeywords.some((k) =>
    title.includes(k.toLowerCase())
  );
  if (!included) return { pass: false, reason: "no matching keyword in title" };

  // Seniority screen: skip roles demanding heavy experience or advanced degrees
  if (/\b(8|9|1\d)\+?\s*years/.test(haystack)) {
    return { pass: false, reason: "requires 8+ years experience" };
  }
  if (/\b(master'?s|mba|ph\.?d)\s+(degree\s+)?(is\s+)?required/.test(haystack)) {
    return { pass: false, reason: "requires advanced degree" };
  }

  // Location screen: keep US/EU/worldwide-friendly remote roles
  if (job.location) {
    const loc = job.location.toLowerCase();
    const usEuFriendly =
      /\b(usa?|united states|americas?|north america|eu|europe|emea|worldwide|anywhere|global|remote)\b/.test(
        loc
      ) || loc.trim() === "";
    if (!usEuFriendly) return { pass: false, reason: `location: ${job.location}` };
  }

  return { pass: true };
}

/**
 * Priority of a job = index of the first (highest-priority) search term its
 * title matches. Lower is better; jobs matching no term rank last.
 */
export function termPriority(title: string, searchTerms: string[]): number {
  const t = title.toLowerCase();
  const idx = searchTerms.findIndex((term) => t.includes(term.toLowerCase()));
  return idx === -1 ? searchTerms.length : idx;
}
