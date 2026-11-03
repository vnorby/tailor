/**
 * Numeric facts about a wallet and each position, used as the variable scope for
 * generated UI formulas. Pure — runs on the server (to tell the model what it can
 * reference) and in the browser (to evaluate the formulas against live data).
 */
import type { Position, Snapshot } from "@/lib/core/types";
import type { Scope } from "./expr";

const SOL_MINT = "So11111111111111111111111111111111111111112";
export const symKey = (s: string) => s.replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || "TOKEN";

export function globalFacts(snap: Snapshot): Scope {
  const sol = snap.tokens.find((t) => t.mint === SOL_MINT);
  const tokensUsd = snap.tokens.reduce((s, t) => s + (t.valueUsd ?? 0), 0);
  const g: Scope = {
    netWorth: snap.netWorthUsd,
    walletUsd: tokensUsd,
    positionsUsd: snap.positions.reduce((s, p) => s + (p.kind === "order" ? 0 : p.valueUsd), 0),
    openPnl: snap.positions.reduce((s, p) => s + (p.pnlUsd ?? 0), 0),
    positionCount: snap.positions.length,
    solPrice: sol?.priceUsd ?? NaN,
    solBalance: sol?.amount ?? 0,
  };
  for (const t of snap.tokens.slice(0, 30)) {
    const k = symKey(t.symbol);
    if (!(`wallet_${k}` in g)) { g[`wallet_${k}`] = t.amount; g[`wallet_${k}_usd`] = t.valueUsd ?? NaN; if (t.priceUsd) g[`price_${k}`] = t.priceUsd; }
  }
  return g;
}

export function positionFacts(p: Position): Scope {
  const f: Scope = {
    value: p.valueUsd,
    pnl: p.pnlUsd ?? NaN,
    urgency: p.risk.score,
    health: p.risk.healthPct ?? NaN,
    liqPrice: p.risk.liqPrice ?? NaN,
    markPrice: p.risk.markPrice ?? NaN,
  };
  let supply = 0, borrow = 0, size = 0, notional = 0;
  for (const l of p.legs) {
    const k = symKey(l.symbol);
    const pre = l.side === "borrow" ? "borrow" : l.side === "supply" ? "supply" : l.side;
    f[`${pre}_${k}`] = (f[`${pre}_${k}`] ?? 0) + l.amount;
    f[`${pre}_${k}_usd`] = (f[`${pre}_${k}_usd`] ?? 0) + l.valueUsd;
    if (l.amount > 0 && l.valueUsd > 0) f[`price_${k}`] = l.valueUsd / l.amount;
    if (l.apy != null) f[`apy_${k}`] = l.apy;
    if (l.side === "borrow") borrow += l.valueUsd;
    else if (l.side === "supply" || l.side === "stake" || l.side === "lp" || l.side === "hold") supply += l.valueUsd;
    if (l.side === "long" || l.side === "short") { size += l.side === "short" ? -l.amount : l.amount; notional += l.valueUsd; }
  }
  f.supplyUsd = supply; f.borrowUsd = borrow;
  if (supply > 0) f.ltv = borrow / supply;
  if (notional) { f.size = size; f.notional = notional; f.isLong = size > 0 ? 1 : 0; }
  if (f.liqPrice && f.markPrice) f.liqDistance = Math.abs(f.markPrice - f.liqPrice) / f.markPrice;
  // Adapters put protocol-specific numbers in raw (entryPrice, liqLtv, leverage…): expose them all.
  for (const [k, v] of Object.entries(p.raw ?? {})) if (typeof v === "number" && isFinite(v)) f[k] = v;
  if (f.entryPrice == null && typeof p.raw?.entryPrice === "number") f.entryPrice = p.raw.entryPrice as number;
  return f;
}

export function scopeFor(snap: Snapshot, positionId?: string): Scope {
  const g = globalFacts(snap);
  const p = positionId ? snap.positions.find((x) => x.id === positionId) : undefined;
  return p ? { ...g, ...positionFacts(p) } : g;
}
