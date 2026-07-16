import type { Browser, Page } from "@cloudflare/puppeteer";
import type { RawJob } from "../../types";

/**
 * Browser-driven discovery for job boards without a usable API. The headless
 * browser opens the board's search page for a term (or types into its search
 * UI), waits for results to render, and harvests job links - preferring
 * direct ATS links (Ashby/Greenhouse/Lever/Workable) when the board exposes
 * them.
 */

interface BrowserBoard {
  name: string;
  /** Build the search-results URL for a term (remote-only filters baked in). */
  searchUrl: (term: string) => string;
  /** CSS selector that indicates results have rendered. */
  resultsSelector: string;
  /** Optional: type into a search box instead of URL param (SPA boards). */
  typeSearch?: { inputSelector: string };
}

// Free boards with working search only. DailyRemote and Remote Leaf are
// subscription-gated; Remote Front's search proved unreliable - excluded.
const BOARDS: BrowserBoard[] = [
  {
    name: "hiringcafe",
    searchUrl: (term) =>
      `https://hiring.cafe/?searchState=${encodeURIComponent(
        JSON.stringify({ searchQuery: term, workplaceTypes: ["Remote"] })
      )}`,
    resultsSelector: "a[href]",
  },
  {
    name: "workew",
    searchUrl: (term) => `https://workew.com/?s=${encodeURIComponent(term)}`,
    resultsSelector: "article a[href], .job_listing a[href]",
  },
];

const ATS_HREF =
  /(jobs\.ashbyhq\.com|boards\.greenhouse\.io|job-boards\.greenhouse\.io|jobs\.(?:eu\.)?lever\.co|apply\.workable\.com)/i;

/** Max boards visited per run and terms per board, to bound browser time. */
const BOARDS_PER_RUN = 2;
const TERMS_PER_BOARD = 3;

export async function searchBrowserBoards(
  browser: Browser,
  searchTerms: string[]
): Promise<RawJob[]> {
  const terms = searchTerms.slice(0, TERMS_PER_BOARD);
  if (terms.length === 0) return [];

  // Rotate which boards run each 30-min window so all get coverage over a day
  const start = Math.floor(Date.now() / (30 * 60 * 1000)) % BOARDS.length;
  const boards = [...BOARDS, ...BOARDS].slice(start, start + BOARDS_PER_RUN);

  const jobs: RawJob[] = [];
  for (const board of boards) {
    for (const term of terms) {
      try {
        const found = await searchBoard(browser, board, term);
        jobs.push(...found);
        console.log(
          JSON.stringify({ event: "browser_board_searched", board: board.name, term, count: found.length })
        );
      } catch (err) {
        console.log(
          JSON.stringify({ event: "browser_board_failed", board: board.name, term, err: String(err) })
        );
      }
    }
  }
  return jobs;
}

async function searchBoard(
  browser: Browser,
  board: BrowserBoard,
  term: string
): Promise<RawJob[]> {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1280, height: 1200 });
    await page.goto(board.searchUrl(term), {
      waitUntil: "networkidle2",
      timeout: 30_000,
    });

    if (board.typeSearch) {
      await page.type(board.typeSearch.inputSelector, term, { delay: 60 });
      await page.keyboard.press("Enter");
      await new Promise((r) => setTimeout(r, 4000));
    }

    try {
      await page.waitForSelector(board.resultsSelector, { timeout: 10_000 });
    } catch {
      return []; // no results rendered
    }
    // Let lazy content settle
    await new Promise((r) => setTimeout(r, 1500));

    const links = await page.evaluate(() => {
      const out: { href: string; text: string }[] = [];
      for (const a of document.querySelectorAll("a[href]")) {
        const href = (a as { href: string }).href;
        const text = (a.textContent ?? "").replace(/\s+/g, " ").trim();
        if (href && text.length > 3 && text.length < 160) out.push({ href, text });
      }
      return out;
    });

    const seen = new Set<string>();
    const jobs: RawJob[] = [];
    for (const link of links) {
      // Keep direct ATS links; they skip the resolve step entirely
      if (!ATS_HREF.test(link.href)) continue;
      const key = link.href.split("?")[0];
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push({
        url: link.href,
        applyUrl: link.href,
        source: board.name,
        title: link.text,
        location: "Remote",
      });
    }

    // Fallback: board-internal job detail links (resolved to ATS later)
    if (jobs.length === 0) {
      const internal = links.filter(
        (l) =>
          /\/(remote-job|job|jobs|position)s?\//i.test(l.href) &&
          l.href.startsWith(new URL(board.searchUrl(term)).origin)
      );
      for (const link of internal.slice(0, 15)) {
        const key = link.href.split("?")[0];
        if (seen.has(key)) continue;
        seen.add(key);
        jobs.push({
          url: link.href,
          source: board.name,
          title: link.text,
          location: "Remote",
        });
      }
    }
    return jobs;
  } finally {
    await page.close();
  }
}
