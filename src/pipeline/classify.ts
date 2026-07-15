import type { AtsType } from "../types";

export function classifyAtsFromUrl(url: string | undefined): AtsType {
  if (!url) return "unknown";
  const u = url.toLowerCase();
  if (u.includes("ashbyhq.com")) return "ashby";
  if (u.includes("greenhouse.io") || u.includes("grnh.se")) return "greenhouse";
  if (u.includes("lever.co")) return "lever";
  if (u.includes("workable.com")) return "workable";
  return "unknown";
}

/**
 * Follow a job board listing to find the underlying ATS application URL.
 * Many boards link out to Ashby/Greenhouse/Lever; we fetch the listing page
 * and look for known ATS URLs in the HTML.
 */
export async function resolveApplyUrl(
  listingUrl: string
): Promise<{ applyUrl: string; ats: AtsType } | null> {
  // The listing URL itself may already be an ATS link
  const direct = classifyAtsFromUrl(listingUrl);
  if (direct !== "unknown") return { applyUrl: listingUrl, ats: direct };

  let html: string;
  try {
    const res = await fetch(listingUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; auto-job-apps/1.0)" },
      redirect: "follow",
    });
    if (!res.ok) return null;
    // Listing pages are small; cap read at ~500KB to be safe
    html = (await res.text()).slice(0, 500_000);
  } catch {
    return null;
  }

  const patterns: [RegExp, AtsType][] = [
    [/https?:\/\/jobs\.ashbyhq\.com\/[^"'\s<>]+/i, "ashby"],
    [/https?:\/\/(?:boards|job-boards)\.greenhouse\.io\/[^"'\s<>]+/i, "greenhouse"],
    [/https?:\/\/jobs\.(?:eu\.)?lever\.co\/[^"'\s<>]+/i, "lever"],
    [/https?:\/\/apply\.workable\.com\/[^"'\s<>]+/i, "workable"],
  ];

  for (const [regex, ats] of patterns) {
    const match = html.match(regex);
    if (match) {
      const applyUrl = match[0].replace(/&amp;/g, "&");
      return { applyUrl, ats };
    }
  }
  return null;
}
