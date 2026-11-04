/**
 * Background position alerts. Every few minutes, read each account's positions (addresses
 * only, so it works while the wallet is locked) and notify when something needs the user:
 * risk worsening, a risky position staying in danger, a loan or perp disappearing
 * (possibly liquidated), or an open order going away (filled or cancelled).
 */
import { getMeta } from "./vault";

interface Pos { id: string; title: string; protocol: string; kind: string; valueUsd: number; borrows: boolean; risk: { level: "ok" | "watch" | "danger"; score: number; reason?: string } }
interface Seen { level: Pos["risk"]["level"]; title: string; kind: string; borrows: boolean; notifiedAt?: number }
type State = Record<string, Record<string, Seen>>; // owner → positionId → last seen

const RANK = { ok: 0, watch: 1, danger: 2 } as const;
const RENOTIFY_MS = 2 * 60 * 60 * 1000;
const PROTOCOL: Record<string, string> = { kamino: "Kamino", jupiter: "Jupiter", drift: "Drift", marginfi: "marginfi", phoenix: "Phoenix", dflow: "DFlow", stake: "Stake", lst: "Liquid staking", wallet: "Wallet" };

export async function alertsEnabled() { const { alerts } = await chrome.storage.local.get("alerts"); return alerts !== false; }

function notify(id: string, title: string, message: string) {
  void chrome.notifications.create(id, { type: "basic", iconUrl: "icons/128.png", title, message, priority: 2 });
}

export async function checkAlerts() {
  if (!(await alertsEnabled())) return;
  const meta = await getMeta();
  if (!meta.accounts.length) return;
  const { alertState } = await chrome.storage.local.get("alertState");
  const state: State = (alertState as State | undefined) ?? {};
  const now = Date.now();
  for (const acct of meta.accounts.slice(0, 6)) {
    let positions: Pos[];
    try {
      const r = await fetch(`${meta.apiBase}/api/alerts?owner=${acct.address}`);
      if (!r.ok) continue;
      positions = ((await r.json()) as { positions: Pos[] }).positions;
    } catch { continue; }
    const first = !state[acct.address];
    const prev = state[acct.address] ?? {};
    const next: Record<string, Seen> = {};
    const label = meta.accounts.length > 1 ? ` · ${acct.name}` : "";
    for (const p of positions) {
      const was = prev[p.id];
      const seen: Seen = { level: p.risk.level, title: p.title, kind: p.kind, borrows: p.borrows, notifiedAt: was?.notifiedAt };
      const worse = !was ? p.risk.level === "danger" : RANK[p.risk.level] > RANK[was.level];
      const stillDanger = was?.level === "danger" && p.risk.level === "danger" && now - (was.notifiedAt ?? 0) > RENOTIFY_MS;
      if ((worse && (!first || p.risk.level === "danger")) || stillDanger) {
        notify(`risk:${acct.address}:${p.id}:${now}`, `${p.risk.level === "danger" ? "At risk" : "Keep an eye on"}: ${p.title}${label}`, `${PROTOCOL[p.protocol] ?? p.protocol}. ${p.risk.reason ?? "Risk went up."}`);
        seen.notifiedAt = now;
      }
      next[p.id] = seen;
    }
    if (!first) {
      for (const [id, was] of Object.entries(prev)) {
        if (next[id]) continue;
        if (was.kind === "order") notify(`gone:${acct.address}:${id}:${now}`, `Order filled or cancelled${label}`, was.title);
        else if (was.borrows && was.level !== "ok") notify(`gone:${acct.address}:${id}:${now}`, `Position closed${label}`, `${was.title} is gone. If you didn't close it, it may have been liquidated.`);
      }
    }
    state[acct.address] = next;
  }
  await chrome.storage.local.set({ alertState: state });
}

export function startAlerts() {
  void chrome.alarms.create("alerts", { periodInMinutes: 5, delayInMinutes: 1 });
}

export async function openWallet() {
  try { const w = await chrome.windows.getLastFocused(); if (w.id != null) { await chrome.sidePanel.open({ windowId: w.id }); return; } } catch { /* needs a user gesture in some versions */ }
  await chrome.windows.create({ url: "sidepanel.html", type: "popup", width: 420, height: 760 });
}
