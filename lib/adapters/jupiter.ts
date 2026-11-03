/**
 * Jupiter adapter: Perps positions (+ TP/SL, limit orders), Trigger v1 limit
 * orders, Recurring v1 DCA, JLP in the wallet, JLP loans, Jupiter Lend Earn +
 * Borrow, and the `jupiterSwap` SwapProvider used by the shared swap tool.
 * Every source is fetched independently; one failing never hides the others.
 */
import type { Adapter, BuiltAction, Ctx, Position } from "@/lib/core/types";
import { num, pct, usd } from "@/lib/core/solana";
import { JLP, PERPS, SOL, USDC, jfetch, n } from "./jupiter/http";
import { buildPerp, buildPerpLimitCancel, perpLimitOrders, perpPositions } from "./jupiter/perps";
import { buildOrderCancel, recurringOrders, triggerOrders } from "./jupiter/orders";
import { borrowPositions, buildBorrow, buildEarnWithdraw, buildLoan, earnPositions, jlpLoans } from "./jupiter/lend";
import { jupiterSwap } from "./jupiter/swap";

export { jupiterSwap };

let jlpInfo: { at: number; price: number; apy: number; aum: number } | null = null;
async function getJlpInfo() {
  if (jlpInfo && Date.now() - jlpInfo.at < 60_000) return jlpInfo;
  const j = await jfetch<{ jlpPriceUsdFormatted?: string; jlpPriceUsd?: string; jlpApyPct?: string; aumUsdFormatted?: string }>(`${PERPS}/jlp-info`);
  jlpInfo = { at: Date.now(), price: n(j.jlpPriceUsdFormatted) || n(j.jlpPriceUsd) / 1e6, apy: n(j.jlpApyPct) / 100, aum: n(j.aumUsdFormatted) };
  return jlpInfo;
}

async function jlpHolding(ctx: Ctx): Promise<Position[]> {
  const t = ctx.tokens.find((x) => x.mint === JLP);
  if (!t || t.amount <= 0) return [];
  const info = await getJlpInfo().catch(() => null);
  const price = info?.price || t.priceUsd || 0;
  const value = t.amount * price;
  const opts = [{ value: "USDC", label: "USDC" }, { value: "SOL", label: "SOL" }];
  return [{
    id: "jupiter:jlp", protocol: "jupiter", kind: "vault",
    title: "JLP", subtitle: "Jupiter Liquidity Provider · perps LP basket",
    valueUsd: value,
    legs: [{ side: "hold", symbol: "JLP", mint: JLP, amount: t.amount, valueUsd: value, apy: info?.apy }],
    metrics: [
      { label: "Holding", value: `${num(t.amount, 2)} JLP` },
      { label: "Price", value: usd(price, 4) },
      ...(info?.apy ? [{ label: "APY", value: pct(info.apy), tone: "pos" as const }] : []),
      ...(info?.aum ? [{ label: "Pool AUM", value: usd(info.aum, 0), tone: "muted" as const }] : []),
    ],
    risk: { level: "ok", score: Math.min(20, Math.round(Math.log10(1 + value) * 3)), reason: "Earns perps fees; exposed to SOL/ETH/BTC and trader PnL" },
    actions: [{ id: "jlp-sell", label: "Sell JLP", intent: "withdraw", fields: [
      { name: "amount", label: "Amount", kind: "amount", unit: "JLP", max: t.amount, default: String(t.amount) },
      { name: "receive", label: "Receive", kind: "select", default: "USDC", options: opts },
    ] }],
    url: "https://jup.ag/perps-earn",
    raw: { kind: "jlp", amount: t.amount, decimals: t.decimals, price, claimsMints: [JLP] },
    updatedAt: Date.now(),
  }];
}

async function buildJlpSell(owner: string, pos: Position, params: Record<string, string>): Promise<BuiltAction> {
  const raw = pos.raw as { amount: number; decimals: number; price: number };
  const amt = Math.min(Number(params.amount), raw.amount);
  if (!(amt > 0)) throw new Error("Enter an amount greater than zero.");
  const outMint = params.receive === "SOL" ? SOL : USDC;
  const atomic = amt >= raw.amount ? BigInt(Math.floor(raw.amount * 10 ** raw.decimals)).toString() : BigInt(Math.floor(amt * 10 ** raw.decimals)).toString();
  const q = await jupiterSwap.quote(owner, JLP, outMint, atomic, 50);
  if (!q) throw new Error("No Jupiter route for JLP right now.");
  const out = Number(q.outAmount) / 10 ** (outMint === SOL ? 9 : 6);
  return {
    txs: [await q.build()],
    summary: `Sell ${num(amt, 4)} JLP (~${usd(amt * raw.price)}) for ~${num(out, 4)} ${params.receive === "SOL" ? "SOL" : "USDC"} via Jupiter${q.route ? ` (${q.route})` : ""}.`,
    warnings: q.priceImpactPct && q.priceImpactPct > 0.5 ? [`Price impact ${q.priceImpactPct.toFixed(2)}%.`] : undefined,
  };
}

export const jupiterAdapter: Adapter = {
  protocol: "jupiter",
  name: "Jupiter",

  async positions(owner, ctx) {
    const jlpPrice = () => getJlpInfo().then((i) => i.price).catch(() => ctx.tokens.find((t) => t.mint === JLP)?.priceUsd ?? 0);
    const sources: Promise<Position[]>[] = [
      perpPositions(owner),
      perpLimitOrders(owner),
      triggerOrders(owner, ctx),
      recurringOrders(owner, ctx),
      earnPositions(owner),
      borrowPositions(owner),
      jlpHolding(ctx),
      jlpPrice().then((p) => jlpLoans(owner, p)),
    ];
    const results = await Promise.allSettled(sources);
    const out = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    // Only surface an error if nothing at all came back and something broke.
    if (!out.length && failed.length === results.length) throw new Error(String(failed[0].reason?.message ?? failed[0].reason));
    return out;
  },

  async build(owner, position, actionId, params, ctx) {
    const kind = (position.raw as { kind?: string } | undefined)?.kind;
    switch (kind) {
      case "perp": return buildPerp(owner, position, actionId, params);
      case "perp-limit": return buildPerpLimitCancel(position);
      case "trigger": case "recurring": return buildOrderCancel(owner, position);
      case "earn": return buildEarnWithdraw(owner, position, params);
      case "borrow": return buildBorrow(owner, position, actionId, params, ctx);
      case "loan": return buildLoan(owner, position, actionId, params);
      case "jlp": return buildJlpSell(owner, position, params);
    }
    throw new Error(`Unknown Jupiter position kind ${kind}`);
  },
};
