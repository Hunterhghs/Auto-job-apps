import type { AppConfig } from "./types";

const CONFIG_KEY = "app-config";

export const DEFAULT_CONFIG: AppConfig = {
  paused: false,
  dailyCap: 15,
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
