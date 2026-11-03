/**
 * Jupiter Trigger (limit) v1 and Recurring (DCA) v1 orders. Both are plain
 * on-chain program accounts; the cancel endpoints return a single-signer tx we
 * can send through any RPC. (Trigger v2 is vault-based behind a JWT obtained by
 * signing a challenge, so it doesn't fit a read-from-address wallet yet.)
 */
import type { BuiltAction, Ctx, Position } from "@/lib/core/types";
import { num, pct, usd } from "@/lib/core/solana";
import { JUP, jfetch, n, tokenMeta } from "./http";

interface TriggerOrder {
  orderKey: string; inputMint: string; outputMint: string;
  rawMakingAmount: string; rawTakingAmount: string; rawRemainingMakingAmount: string; rawRemainingTakingAmount: string;
  expiredAt: string | null; createdAt: string; status: string; slippageBps?: string;
}
interface RecurringOrder {
  orderKey: string; inputMint: string; outputMint: string;
  rawInDeposited: string; rawInWithdrawn: string; rawInUsed: string; rawOutReceived: string; rawOutWithdrawn: string;
  rawInAmountPerCycle: string; cycleFrequency: string; rawMinOutAmount?: string; rawMaxOutAmount?: string;
  createdAt: string; userClosed?: boolean;
}

const every = (s: number) => s % 86400 === 0 ? (s === 86400 ? "daily" : `every ${s / 86400}d`) : s % 3600 === 0 ? (s === 3600 ? "hourly" : `every ${s / 3600}h`) : s % 60 === 0 ? `every ${s / 60} min` : `every ${s}s`;
const dur = (s: number) => s >= 86400 ? `${num(s / 86400, 1)}d` : s >= 3600 ? `${num(s / 3600, 1)}h` : `${Math.max(1, Math.round(s / 60))}m`;

export async function triggerOrders(owner: string, ctx: Ctx): Promise<Position[]> {
  const res = await jfetch<{ orders?: TriggerOrder[] }>(`${JUP}/trigger/v1/getTriggerOrders?user=${owner}&orderStatus=active`);
  const orders = (res.orders ?? []).filter((o) => o.status?.toLowerCase() === "open" || !o.status);
  if (!orders.length) return [];
  const mints = orders.flatMap((o) => [o.inputMint, o.outputMint]);
  const [meta, px] = await Promise.all([tokenMeta(mints, ctx.tokens, ctx.connection), ctx.prices(mints)]);
  const now = Date.now();
  return orders.map((o) => {
    const i = meta[o.inputMint], out = meta[o.outputMint];
    const making = n(o.rawMakingAmount) / 10 ** i.decimals, taking = n(o.rawTakingAmount) / 10 ** out.decimals;
    const remaining = n(o.rawRemainingMakingAmount) / 10 ** i.decimals;
    const filled = making > 0 ? 1 - remaining / making : 0;
    // Express the limit as "price of the token being bought/sold in USD-ish terms".
    const target = making > 0 ? taking / making : 0;               // out per in
    const market = px[o.inputMint] && px[o.outputMint] ? px[o.inputMint] / px[o.outputMint] : undefined;
    const away = market && target ? target / market - 1 : undefined; // +5% = needs in-token to rise 5%
    const exp = o.expiredAt ? Date.parse(o.expiredAt) : undefined;
    const expired = exp != null && exp <= now;
    const soon = exp != null && !expired && exp - now < 86_400_000;
    const valueUsd = remaining * (px[o.inputMint] ?? 0);
    const watch = filled > 0.0001 || expired || soon;
    return {
      id: `jupiter:${o.orderKey}`, protocol: "jupiter", kind: "order",
      title: `Limit ${i.symbol} → ${out.symbol}`,
      subtitle: `Jupiter Trigger · sell ${num(remaining)} ${i.symbol} for ${num(taking * (remaining / (making || 1)))} ${out.symbol}`,
      valueUsd,
      legs: [{ side: "hold", symbol: i.symbol, mint: o.inputMint, amount: remaining, valueUsd }],
      metrics: [
        { label: "Limit", value: `${num(target, 6)} ${out.symbol}/${i.symbol}` },
        ...(market ? [{ label: "Market", value: `${num(market, 6)}`, tone: "muted" as const }] : []),
        ...(away != null ? [{ label: "To fill", value: `${away >= 0 ? "+" : ""}${pct(away)}`, tone: Math.abs(away) < 0.02 ? "warn" as const : undefined }] : []),
        { label: "Filled", value: pct(filled, 0) },
        { label: "Expires", value: exp ? (expired ? "expired" : dur((exp - now) / 1000)) : "never", tone: expired || soon ? "warn" : "muted" },
      ],
      risk: watch
        ? { level: "watch", score: expired ? 55 : soon ? 50 : 40, reason: expired ? "Expired — cancel to reclaim funds" : soon ? "Expires within 24h" : `${pct(filled, 0)} filled` }
        : { level: "ok", score: Math.min(20, 5 + Math.round(Math.log10(1 + valueUsd) * 3)), reason: away != null ? `${pct(Math.abs(away))} from limit` : "Open" },
      actions: [{ id: "cancel-trigger", label: "Cancel order", intent: "cancel" }],
      url: "https://jup.ag/limit",
      raw: { kind: "trigger", orderKey: o.orderKey, inSym: i.symbol, outSym: out.symbol, remaining, filled },
      updatedAt: now,
    } satisfies Position;
  });
}

export async function recurringOrders(owner: string, ctx: Ctx): Promise<Position[]> {
  const url = (page: number) => `${JUP}/recurring/v1/getRecurringOrders?user=${owner}&orderStatus=active&recurringType=time&includeFailedTx=false&page=${page}`;
  const first = await jfetch<{ time?: RecurringOrder[]; all?: RecurringOrder[]; totalPages?: number }>(url(1));
  // First page only (10 orders): more pages cost extra rate-limited calls and blow the snapshot budget.
  const orders = (first.time ?? first.all ?? []).filter((o) => !o.userClosed);
  if (!orders.length) return [];
  const mints = orders.flatMap((o) => [o.inputMint, o.outputMint]);
  const [meta, px] = await Promise.all([tokenMeta(mints, ctx.tokens, ctx.connection), ctx.prices(mints)]);
  const now = Date.now();
  return orders.map((o) => {
    const i = meta[o.inputMint], out = meta[o.outputMint];
    const di = 10 ** i.decimals, dout = 10 ** out.decimals;
    const deposited = n(o.rawInDeposited) / di, used = n(o.rawInUsed) / di, withdrawn = n(o.rawInWithdrawn) / di;
    const remaining = Math.max(0, deposited - used - withdrawn);
    const perCycle = n(o.rawInAmountPerCycle) / di;
    const freq = n(o.cycleFrequency);
    const cyclesLeft = perCycle > 0 ? Math.ceil(remaining / perCycle - 1e-9) : 0;
    const totalCycles = perCycle > 0 ? Math.round(deposited / perCycle) : 0;
    const received = n(o.rawOutReceived) / dout;
    const avg = used > 0 ? received / used : undefined;
    const valueUsd = remaining * (px[o.inputMint] ?? 0);
    const nearEnd = cyclesLeft <= 1;
    return {
      id: `jupiter:${o.orderKey}`, protocol: "jupiter", kind: "order",
      title: `DCA ${i.symbol} → ${out.symbol}`,
      subtitle: `Jupiter Recurring · ${num(perCycle)} ${i.symbol} ${every(freq)}`,
      valueUsd,
      legs: [{ side: "hold", symbol: i.symbol, mint: o.inputMint, amount: remaining, valueUsd }],
      metrics: [
        { label: "Progress", value: `${totalCycles - cyclesLeft}/${totalCycles} buys` },
        { label: "Left", value: `${num(remaining)} ${i.symbol}` },
        { label: "Received", value: `${num(received)} ${out.symbol}` },
        ...(avg ? [{ label: "Avg price", value: `${num(avg, 6)} ${out.symbol}/${i.symbol}`, tone: "muted" as const }] : []),
        { label: "Ends in", value: cyclesLeft ? dur(cyclesLeft * freq) : "done", tone: nearEnd ? "warn" : "muted" },
      ],
      risk: nearEnd
        ? { level: "watch", score: 40, reason: cyclesLeft ? "Last buy pending" : "Finished — nothing left to swap" }
        : { level: "ok", score: Math.min(20, 5 + Math.round(Math.log10(1 + valueUsd) * 3)), reason: `${cyclesLeft} buys left` },
      actions: [{ id: "cancel-recurring", label: "Cancel DCA", intent: "cancel" }],
      url: "https://jup.ag/recurring",
      raw: { kind: "recurring", orderKey: o.orderKey, inSym: i.symbol, outSym: out.symbol, remaining, recurringType: "time" },
      updatedAt: now,
    } satisfies Position;
  });
}

export async function buildOrderCancel(owner: string, pos: Position): Promise<BuiltAction> {
  const raw = pos.raw as { kind: string; orderKey: string; inSym: string; outSym: string; remaining: number; recurringType?: string };
  if (raw.kind === "trigger") {
    const r = await jfetch<{ transaction?: string; error?: string }>(`${JUP}/trigger/v1/cancelOrder`, { body: { maker: owner, order: raw.orderKey, computeUnitPrice: "auto" } });
    if (!r.transaction) throw new Error(r.error ?? "Jupiter returned no cancel transaction.");
    return { txs: [r.transaction], summary: `Cancel your ${raw.inSym} → ${raw.outSym} limit order and return ${num(raw.remaining)} ${raw.inSym} to your wallet.` };
  }
  const r = await jfetch<{ transaction?: string; error?: string }>(`${JUP}/recurring/v1/cancelOrder`, { body: { user: owner, order: raw.orderKey, recurringType: raw.recurringType ?? "time" } });
  if (!r.transaction) throw new Error(r.error ?? "Jupiter returned no cancel transaction.");
  return { txs: [r.transaction], summary: `Cancel your ${raw.inSym} → ${raw.outSym} DCA and return the unspent ${num(raw.remaining)} ${raw.inSym}.` };
}
