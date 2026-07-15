import type { RawJob } from "../../types";
import { fetchRemotive } from "./remotive";
import { fetchHimalayas } from "./himalayas";
import { fetchWorkingNomads } from "./workingnomads";
import { fetchEuRemoteJobs } from "./euremotejobs";

const SOURCES: Record<string, () => Promise<RawJob[]>> = {
  remotive: fetchRemotive,
  himalayas: fetchHimalayas,
  workingnomads: fetchWorkingNomads,
  euremotejobs: fetchEuRemoteJobs,
  // Planned: remotefront, hiringcafe, dailyremote, workew, remoteleaf
};

/** Fetch all sources in parallel; a failing source never kills the run. */
export async function fetchAllSources(): Promise<RawJob[]> {
  const results = await Promise.allSettled(
    Object.entries(SOURCES).map(async ([name, fn]) => {
      const jobs = await fn();
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
