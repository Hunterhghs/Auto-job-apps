import type { RawJob } from "../../types";
import { fetchGreenhouseDirect } from "./greenhouse-direct";
import { fetchAshbyDirect } from "./ashby-direct";
import { fetchRemotive } from "./remotive";
import { fetchHimalayas } from "./himalayas";
import { fetchWorkingNomads } from "./workingnomads";
import { fetchEuRemoteJobs } from "./euremotejobs";

// Priority order: direct ATS sources first (guaranteed modern forms),
// then API boards (may require ATS resolution).
const SOURCES: Record<string, (searchTerms: string[]) => Promise<RawJob[]>> = {
  "greenhouse-direct": fetchGreenhouseDirect,
  "ashby-direct": fetchAshbyDirect,
  himalayas: fetchHimalayas,
  // Secondary: board APIs that often need browser-based ATS resolution
  workingnomads: fetchWorkingNomads,
  remotive: fetchRemotive,
  euremotejobs: fetchEuRemoteJobs,
};

/**
 * Search all sources for the configured terms in parallel; a failing source
 * never kills the run.
 */
export async function searchAllSources(searchTerms: string[]): Promise<RawJob[]> {
  const results = await Promise.allSettled(
    Object.entries(SOURCES).map(async ([name, fn]) => {
      const jobs = await fn(searchTerms);
      console.log(JSON.stringify({ event: "source_fetched", source: name, count: jobs.length }));
      return jobs;
    })
  );
  return results
    .filter((r): r is PromiseFulfilledResult<RawJob[]> => {
      if (r.status === "rejected") {
        console.log(JSON.stringify({ event: "source_failed", err: String(r.reason) }));
        return false;
      }
      return true;
    })
    .flatMap((r) => r.value);
}
