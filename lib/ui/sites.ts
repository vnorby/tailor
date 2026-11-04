import type { Protocol } from "@/lib/core/types";

/** Sites Tailor knows: what to surface when the user is on one. Matched by registrable domain. */
const SITES: { domains: string[]; name: string; protocols: Protocol[]; tools: string[] }[] = [
  { domains: ["kamino.finance", "kamino.com"], name: "Kamino", protocols: ["kamino"], tools: ["kamino-deposit"] },
  { domains: ["jup.ag"], name: "Jupiter", protocols: ["jupiter"], tools: ["swap"] },
  { domains: ["drift.trade"], name: "Drift", protocols: ["drift"], tools: [] },
  { domains: ["marginfi.com"], name: "marginfi", protocols: ["marginfi"], tools: ["marginfi-deposit"] },
  { domains: ["phoenix.trade"], name: "Phoenix", protocols: ["phoenix"], tools: [] },
  { domains: ["dflow.net"], name: "DFlow", protocols: ["dflow"], tools: ["swap"] },
  { domains: ["sanctum.so", "jito.network", "marinade.finance"], name: "Staking", protocols: ["lst", "stake"], tools: ["stake-sol", "stake-native"] },
];

export interface SiteInfo { host: string; name?: string; protocols: Protocol[]; tools: string[] }

export function siteFor(origin: string): SiteInfo | null {
  let host: string;
  try { host = new URL(origin).hostname; } catch { return null; }
  const s = SITES.find((x) => x.domains.some((d) => host === d || host.endsWith(`.${d}`)));
  return { host: host.replace(/^www\./, ""), name: s?.name, protocols: s?.protocols ?? [], tools: s?.tools ?? [] };
}
