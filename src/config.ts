import type { AppConfig } from "./types";

const CONFIG_KEY = "app-config";

export const DEFAULT_CONFIG: AppConfig = {
  paused: false,
  dailyCap: 15,
  // Priority order: first term = highest priority. The queue drains
  // higher-priority matches first.
  searchTerms: [
    "analyst",
    "business analyst",
    "market research",
    "research analyst",
    "data analyst",
    "researcher",
    "content writer",
    "writer",
    "business intelligence",
    "strategy",
    "consultant",
  ],
  includeKeywords: [
    "analyst",
    "analytics",
    "research",
    "researcher",
    "strategy",
    "strategist",
    "writer",
    "writing",
    "content",
    "editor",
    "consultant",
    "consulting",
    "operations",
    "business",
    "market",
    "economist",
    "economic",
    "intelligence",
    "policy",
    "data",
  ],
  excludeKeywords: [
    "senior",
    "sr.",
    "staff",
    "principal",
    "director",
    "vp",
    "vice president",
    "head of",
    "chief",
    "lead",
    "phd",
    "intern",
    "unpaid",
    "engineer",
    "developer",
    "nurse",
    "physician",
    "sales development",
  ],
  salaryMinAnnual: 40000,
  salaryMaxAnnual: 110000,
  hourlyMin: 20,
  hourlyMax: 75,
};

export async function getConfig(kv: KVNamespace): Promise<AppConfig> {
  const stored = await kv.get<Partial<AppConfig>>(CONFIG_KEY, "json");
  return { ...DEFAULT_CONFIG, ...stored };
}

export async function setConfig(
  kv: KVNamespace,
  patch: Partial<AppConfig>
): Promise<AppConfig> {
  const current = await getConfig(kv);
  const next = { ...current, ...patch };
  await kv.put(CONFIG_KEY, JSON.stringify(next));
  return next;
}
