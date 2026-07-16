import type { AtsType } from "../types";

export function classifyAtsFromUrl(url: string | undefined): AtsType {
  if (!url) return "unknown";
  const u = url.toLowerCase();
  if (u.includes("ashbyhq.com")) return "ashby";
  if (u.includes("greenhouse.io") || u.includes("grnh.se")) return "greenhouse";
  if (u.includes("lever.co")) return "lever";
  if (u.includes("workable.com")) return "workable";
  if (u.includes("breezy.hr")) return "breezy";
  if (u.includes("jazz.co")) return "jazzhr";
  if (u.includes("smartrecruiters.com")) return "smartrecruiters";
  if (u.includes("bamboohr.com")) return "bamboohr";
  if (u.includes("recruitee.com")) return "recruitee";
  if (u.includes("jobs.personio.com")) return "personio";
  if (u.includes("teamtailor.com")) return "teamtailor";
  return "unknown";
}

/**
 * Follow a job board listing to find the underlying ATS application URL.
 * Many boards link out to known ATS platforms; we fetch the listing page
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
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" },
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
    [/https?:\/\/[^"'\s<>]*\.breezy\.hr\/[^"'\s<>]+/i, "breezy"],
    [/https?:\/\/(?:apply\.)?jazz\.co\/[^"'\s<>]+/i, "jazzhr"],
    [/https?:\/\/jobs\.smartrecruiters\.com\/[^"'\s<>]+/i, "smartrecruiters"],
    [/https?:\/\/[^"'\s<>]*\.bamboohr\.com\/[^"'\s<>]+/i, "bamboohr"],
    [/https?:\/\/[^"'\s<>]*\.recruitee\.com\/[^"'\s<>]+/i, "recruitee"],
    [/https?:\/\/[^"'\s<>]*\.jobs\.personio\.com\/[^"'\s<>]+/i, "personio"],
    [/https?:\/\/[^"'\s<>]*\.teamtailor\.com\/[^"'\s<>]+/i, "teamtailor"],
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
