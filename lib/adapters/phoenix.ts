/**
 * Phoenix perpetuals (Phoenix "Rise" exchange, perp-api.phoenix.trade).
 * Reads the trader state + per-subaccount margin views over Phoenix's public
 * REST API; builds close / cancel / withdraw instructions with @ellipsis-labs/rise.
 *
 * Layout: subaccount 0 is the cross-margin account (one "account" card holding
 * cash collateral + withdraw, plus one perp card per position valued at its uPnL);
 * subaccounts ≥1 are isolated (one perp card per position valued at the
 * subaccount's equity). Resting limit orders get one "order" card per market.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createPhoenixClient, getPhoenixTraderSubaccountAddress, OrderFlags, Side, type PhoenixClient } from "@ellipsis-labs/rise";
import type { Action, Adapter, BuiltAction, Position } from "@/lib/core/types";
import { buildTx, num, pct, riskFromHealth, rpcUrl, usd, USDC_MINT } from "@/lib/core/solana";

const API = process.env.PHOENIX_API_URL ?? "https://perp-api.phoenix.trade";
const APP = "https://app.phoenix.trade";

// ---------- REST shapes (only the fields we use) ----------
interface Amt { value: number; decimals: number; ui: string }
interface ViewPosition {
  symbol: string; positionSize: Amt; entryPrice: Amt; unrealizedPnl: Amt; positionValue: Amt;
  maintenanceMargin: Amt; initialMargin: Amt; liquidationPrice: Amt; unsettledFunding: Amt; accumulatedFunding: Amt;
  takeProfitPrice?: Amt | null; stopLossPrice?: Amt | null;
}
interface ViewOrder { price: Amt; side: string | number; orderSequenceNumber: string; tradeSizeRemaining: Amt; initialTradeSize: Amt; isReduceOnly: boolean; isStopLoss?: boolean }
interface TraderView {
  traderKey: string; traderPdaIndex: number; traderSubaccountIndex: number; state?: string;
  collateralBalance: Amt; portfolioValue: Amt; withdrawableQuoteCollateral?: Amt; maintenanceMargin: Amt; unrealizedPnl: Amt;
  riskState?: string; riskTier?: string;
  positions: ViewPosition[]; limitOrders: Record<string, ViewOrder[]>;
  spotCollaterals?: { symbol: string; balance: Amt; notional: Amt }[];
}
interface StateSnapshot {
  traderPdaIndex: number;
  snapshot: { subaccounts: { subaccountIndex: number; collateral: string; positions?: unknown[]; orders?: { orders?: unknown[] }[]; spotCollaterals?: { balance: string }[] }[] };
}

const n = (a?: Amt | null) => (a ? Number(a.ui) : 0);

async function getJson<T>(path: string): Promise<T | null> {
  const r = await fetch(`${API}${path}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Phoenix API ${r.status} ${path}`);
  return (await r.json()) as T;
}

let client: PhoenixClient | null = null;
const phoenix = () => (client ??= createPhoenixClient({ apiUrl: API, rpcUrl: rpcUrl(), ws: false }));

/** @solana/kit instruction → web3.js instruction. AccountRole: bit0 = writable, bit1 = signer. */
type KitIx = { programAddress: string; accounts?: readonly { address: string; role: number }[]; data?: ArrayLike<number> };
function toWeb3(ix: KitIx): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: (ix.accounts ?? []).map((a) => ({ pubkey: new PublicKey(a.address), isSigner: (a.role & 2) !== 0, isWritable: (a.role & 1) !== 0 })),
    data: Buffer.from(ix.data ?? []),
  });
}

const sideOf = (s: string | number) => (s === 0 || /bid|buy/i.test(String(s)) ? "bid" : "ask");

export const phoenixAdapter: Adapter = {
  protocol: "phoenix",
  name: "Phoenix",

  async positions(owner) {
    const state = await getJson<StateSnapshot>(`/v1/trader/state/${owner}`);
    const subs = (state?.snapshot?.subaccounts ?? []).filter((s) =>
      Number(s.collateral) > 0 || (s.positions?.length ?? 0) > 0 || (s.orders ?? []).some((o) => (o.orders?.length ?? 0) > 0) ||
      (s.spotCollaterals ?? []).some((c) => Number(c.balance) > 0));
    if (!subs.length) return [];
    const pdaIndex = state?.traderPdaIndex ?? 0;
    const views = await Promise.all(subs.map(async (s) => {
      const key = await getPhoenixTraderSubaccountAddress({ authority: owner as never, traderPdaIndex: pdaIndex, subaccountIndex: s.subaccountIndex });
      return getJson<TraderView>(`/v1/view/trader/${key}`).catch(() => null);
    }));

    const out: Position[] = [];
    const now = Date.now();
    for (const v of views) {
      if (!v) continue;
      const sub = v.traderSubaccountIndex;
      const isolated = sub > 0;
      const equity = n(v.portfolioValue);
      const mm = n(v.maintenanceMargin);
      const health = equity > 0 ? ((equity - mm) / equity) * 100 : 0;
      const base = { traderPdaIndex: v.traderPdaIndex, subaccount: sub, traderKey: v.traderKey };

      for (const p of v.positions ?? []) {
        const size = n(p.positionSize);
        if (!size) continue;
        const long = size > 0;
        const entry = n(p.entryPrice);
        const mark = Math.abs(n(p.positionValue) / size);
        const liq = n(p.liquidationPrice);
        const notional = Math.abs(n(p.positionValue));
        const upnl = n(p.unrealizedPnl);
        const lev = equity > 0 ? notional / equity : 0;
        const distPct = liq > 0 && mark > 0 ? Math.abs(mark - liq) / mark : undefined;
        const reason = distPct != null ? `${(distPct * 100).toFixed(1)}% from liquidation (${usd(liq)}), margin health ${Math.round(health)}%` : `Margin health ${Math.round(health)}%`;
        // Health: worse of margin buffer and distance-to-liquidation (25% away ≈ fully safe).
        const h = Math.min(health, distPct != null ? (distPct / 0.25) * 100 : 100);
        const sym = p.symbol.replace(/-PERP$/, "");
        out.push({
          id: `phoenix:${v.traderKey}:${sym}`,
          protocol: "phoenix", kind: "perp",
          title: `${sym}-PERP ${long ? "Long" : "Short"}`,
          subtitle: `${isolated ? `Isolated #${sub}` : "Cross margin"} · ${lev.toFixed(1)}x`,
          valueUsd: isolated ? equity : upnl,
          pnlUsd: upnl,
          legs: [{ side: long ? "long" : "short", symbol: sym, amount: Math.abs(size), valueUsd: notional }],
          metrics: [
            { label: "Size", value: `${num(Math.abs(size))} ${sym}` },
            { label: "Entry", value: usd(entry) },
            { label: "Mark", value: usd(mark) },
            { label: "uPnL", value: usd(upnl), tone: upnl >= 0 ? "pos" : "neg" },
            { label: "Liq.", value: liq > 0 ? usd(liq) : "—", tone: distPct != null && distPct < 0.1 ? "warn" : undefined },
          ],
          risk: riskFromHealth(h, reason, { liqPrice: liq || undefined, markPrice: mark }),
          actions: [{
            id: "close", label: "Close position", intent: "close", danger: true,
            fields: [
              { name: "percent", label: "Close %", kind: "percent", max: 100, default: "100" },
              { name: "slippage", label: "Max slippage %", kind: "percent", default: "1" },
            ],
          }],
          url: `${APP}/trade/${sym}`,
          raw: { ...base, symbol: sym, size, entryPrice: entry, markPrice: mark, liqPrice: liq, isolated,
            takeProfit: p.takeProfitPrice ? n(p.takeProfitPrice) : null, stopLoss: p.stopLossPrice ? n(p.stopLossPrice) : null },
          updatedAt: now,
        });
      }

      for (const [symbol, orders] of Object.entries(v.limitOrders ?? {})) {
        if (!orders?.length) continue;
        const sym = symbol.replace(/-PERP$/, "");
        const rows = orders.map((o) => ({ side: sideOf(o.side), price: n(o.price), size: n(o.tradeSizeRemaining), seq: o.orderSequenceNumber, reduceOnly: o.isReduceOnly }));
        const notional = rows.reduce((s, r) => s + r.price * r.size, 0);
        const bids = rows.filter((r) => r.side === "bid"), asks = rows.filter((r) => r.side === "ask");
        out.push({
          id: `phoenix:${v.traderKey}:${sym}:orders`,
          protocol: "phoenix", kind: "order",
          title: `${sym}-PERP limit orders`,
          subtitle: `${rows.length} open · ${isolated ? `Isolated #${sub}` : "Cross margin"}`,
          valueUsd: 0, // margin for resting orders already sits in the account's collateral
          legs: rows.slice(0, 6).map((r) => ({ side: r.side === "bid" ? "long" : "short", symbol: sym, amount: r.size, valueUsd: r.size * r.price })),
          metrics: [
            { label: "Orders", value: String(rows.length) },
            ...(bids.length ? [{ label: "Best bid", value: usd(Math.max(...bids.map((r) => r.price))) }] : []),
            ...(asks.length ? [{ label: "Best ask", value: usd(Math.min(...asks.map((r) => r.price))) }] : []),
            { label: "Notional", value: usd(notional) },
          ],
          risk: { level: "ok", score: 10 },
          actions: [{ id: "cancel", label: "Cancel all orders", intent: "cancel" }],
          url: `${APP}/trade/${sym}`,
          raw: { ...base, symbol: sym, orders: rows },
          updatedAt: now,
        });
      }

      // Cash collateral: cross account card (withdraw), or idle isolated collateral (sweep + withdraw).
      const cash = n(v.collateralBalance);
      const spot = (v.spotCollaterals ?? []).filter((c) => n(c.balance) > 0);
      const spotUsd = spot.reduce((s, c) => s + n(c.notional), 0);
      const hasPos = (v.positions ?? []).some((p) => n(p.positionSize) !== 0);
      if (isolated && hasPos) continue; // already counted in the position's equity
      if (cash + spotUsd < 0.01) continue;
      const withdrawable = Math.max(0, Math.min(cash, v.withdrawableQuoteCollateral ? n(v.withdrawableQuoteCollateral) : cash));
      const actions: Action[] = withdrawable >= 0.01 ? [{
        id: "withdraw", label: isolated ? "Withdraw idle collateral" : "Withdraw USDC", intent: "withdraw",
        fields: [{ name: "amount", label: "Amount", kind: "amount", unit: "USDC", max: Math.floor(withdrawable * 1e6) / 1e6, default: String(Math.floor(withdrawable * 1e6) / 1e6) }],
      }] : [];
      out.push({
        id: `phoenix:${v.traderKey}:account`,
        protocol: "phoenix", kind: "other",
        title: isolated ? `Phoenix idle collateral #${sub}` : "Phoenix margin account",
        subtitle: hasPos ? `Equity ${usd(equity)} incl. uPnL ${usd(n(v.unrealizedPnl))}` : "No open positions",
        valueUsd: cash + spotUsd,
        legs: [
          { side: "supply", symbol: "USDC", mint: USDC_MINT, amount: cash, valueUsd: cash },
          ...spot.map((c) => ({ side: "supply" as const, symbol: c.symbol, amount: n(c.balance), valueUsd: n(c.notional) })),
        ],
        metrics: [
          { label: "Collateral", value: usd(cash) },
          { label: "Withdrawable", value: usd(withdrawable) },
          ...(hasPos ? [{ label: "Equity", value: usd(equity) }, { label: "Margin used", value: equity > 0 ? pct(mm / equity) : "—" }] : []),
        ],
        risk: hasPos ? riskFromHealth(health, `Margin health ${Math.round(health)}% (maintenance ${usd(mm)} of ${usd(equity)} equity)`) : { level: "ok", score: Math.min(20, Math.round(cash / 5000)) },
        actions,
        url: `${APP}/portfolio`,
        raw: { ...base, cash, withdrawable, isolated },
        updatedAt: now,
      });
    }
    return out;
  },

  async build(owner, position, actionId, params): Promise<BuiltAction> {
    const raw = position.raw as { traderPdaIndex: number; subaccount: number; symbol?: string; size?: number; markPrice?: number; orders?: unknown[]; withdrawable?: number; isolated?: boolean };
    const px = phoenix();
    const authority = owner as never;
    const traderPdaIndex = raw.traderPdaIndex ?? 0;
    const traderSubaccountIndex = raw.subaccount ?? 0;

    if (actionId === "cancel") {
      const ix = await px.ixs.buildCancelAll({ authority, symbol: raw.symbol as never, traderPdaIndex, traderSubaccountIndex });
      return { txs: [await buildTx(owner, [toWeb3(ix as KitIx)], { cuLimit: 400_000 })], summary: `Cancel ${raw.orders?.length ?? "all"} open ${raw.symbol}-PERP limit order(s) on Phoenix.` };
    }

    if (actionId === "close") {
      const size = raw.size ?? 0;
      const share = Math.min(100, Math.max(1, Number(params.percent ?? "100") || 100)) / 100;
      const slip = Math.min(10, Math.max(0.05, Number(params.slippage ?? "1") || 1)) / 100;
      const mark = raw.markPrice ?? 0;
      if (!size || !mark) throw new Error("Position is empty.");
      const long = size > 0;
      const market = await px.exchange.ready().then(() => px.exchange.market(`${raw.symbol}-PERP` as never) ?? px.exchange.market(raw.symbol as never));
      const lotDp = (market as { baseLotsDecimals?: number } | undefined)?.baseLotsDecimals ?? 2;
      const lotsTotal = Math.round(Math.abs(size) * 10 ** lotDp);
      const lots = share >= 1 ? lotsTotal : Math.max(1, Math.floor(lotsTotal * share));
      const baseUnits = (lots / 10 ** lotDp).toFixed(lotDp);
      const limit = long ? mark * (1 - slip) : mark * (1 + slip);
      const orderPacket = await px.ixs.orderPackets.buildMarketOrderPacket({
        symbol: raw.symbol!, side: long ? Side.Ask : Side.Bid, baseUnits, priceLimitUsd: limit.toFixed(6), orderFlags: OrderFlags.ReduceOnly,
      });
      const ix = await px.ixs.buildPlaceMarketOrder({ authority, symbol: raw.symbol as never, orderPacket, traderPdaIndex, traderSubaccountIndex });
      return {
        txs: [await buildTx(owner, [toWeb3(ix as KitIx)], { cuLimit: 600_000 })],
        summary: `${long ? "Sell" : "Buy"} ${baseUnits} ${raw.symbol} reduce-only at market (limit ${usd(limit)}) to close ${share >= 1 ? "the whole" : `${Math.round(share * 100)}% of the`} ${long ? "long" : "short"} on Phoenix.`,
        warnings: raw.isolated && share >= 1 ? ["Collateral stays in the isolated subaccount; withdraw it afterwards from the idle-collateral card."] : undefined,
      };
    }

    if (actionId === "withdraw") {
      const amt = Number(params.amount ?? raw.withdrawable ?? 0);
      if (!(amt > 0)) throw new Error("Enter an amount greater than zero.");
      if (raw.withdrawable != null && amt > raw.withdrawable + 1e-6) throw new Error(`At most ${raw.withdrawable} USDC is withdrawable.`);
      const amount = BigInt(Math.floor(amt * 1e6));
      const ixs: TransactionInstruction[] = [];
      if (traderSubaccountIndex > 0) {
        const sweep = await px.ixs.buildTransferCollateralChildToParent({ authority, traderPdaIndex, childSubaccountIndex: traderSubaccountIndex });
        ixs.push(toWeb3(sweep as KitIx));
      }
      const w = await px.ixs.buildWithdrawIxs({ authority, amount, traderPdaIndex });
      ixs.push(...w.instructions.map((ix) => toWeb3(ix as KitIx)));
      return { txs: [await buildTx(owner, ixs, { cuLimit: 600_000 })], summary: `Withdraw ${num(amt, 2)} USDC from Phoenix to your wallet${traderSubaccountIndex > 0 ? " (sweeping the isolated subaccount first)" : ""}.` };
    }

    throw new Error(`Unknown Phoenix action ${actionId}`);
  },
};
