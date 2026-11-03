/**
 * Kamino Lend (klend): every obligation the owner has, across every market, plus
 * repay / withdraw / deposit / close (repay-with-collateral) transaction builders.
 */
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import {
  KaminoAction, KaminoMarket, KaminoObligation, VanillaObligation, PROGRAM_ID, U64_MAX,
  getCurrentLedgerInstant, getRepayWithCollIxs,
} from "@kamino-finance/klend-sdk";
import { none, type Instruction } from "@solana/kit";
import type { LedgerInstant } from "@kamino-finance/klend-sdk/dist/utils/ledger";
import Decimal from "decimal.js";
import type { Action, BuiltAction, Ctx, Leg, Metric, Position } from "@/lib/core/types";
import { buildTx, connection, lookupTables, num, pct, priorityFee, riskFromHealth, usd } from "@/lib/core/solana";
import { KLEND_PROGRAM, MAIN_MARKET, addr, family, fromWeb3, kitRpc, marketsMeta, n, signer, slotDurationMs, toBaseUnits, toWeb3All, walletBalance } from "./common";
import { jupiterSwapper } from "./jupiter";

const OBLIGATION_SIZE = 3344; // 8-byte discriminator + Obligation layout
const TAG_NAMES: Record<number, string> = { 0: "Lend", 1: "Multiply", 2: "Lending", 3: "Leverage", 4: "Multiply", 5: "Lending", 6: "Leverage" };
const isLeveraged = (tag: number) => tag === 1 || tag === 3 || tag === 4 || tag === 6;

interface RawLeg { reserve: string; mint: string; symbol: string; decimals: number; amount: number }
export interface LendRaw {
  type: "obligation";
  market: string;
  marketName: string;
  obligation: string;
  tag: number;
  lookupTable?: string;
  deposits: RawLeg[];
  borrows: RawLeg[];
  [k: string]: unknown;
}

// ---------- reads ----------

async function loadMarkets(addresses: string[]) {
  const rpc = kitRpc();
  const ms = await slotDurationMs();
  return KaminoMarket.loadMultiple(rpc, addresses.map(addr), ms);
}

export async function lendPositions(owner: string, ctx: Ctx): Promise<Position[]> {
  const accts = await ctx.connection.getProgramAccounts(new PublicKey(KLEND_PROGRAM), {
    filters: [{ dataSize: OBLIGATION_SIZE }, { memcmp: { offset: 64, bytes: owner } }],
  });
  if (!accts.length) return [];
  const marketOf = (d: Buffer) => new PublicKey(d.subarray(32, 64)).toBase58();
  const marketAddrs = [...new Set(accts.map((a) => marketOf(a.account.data)))];
  const rpc = kitRpc();
  const [markets, meta, li] = await Promise.all([loadMarkets(marketAddrs), marketsMeta(), getCurrentLedgerInstant(rpc)]);

  const out: Position[] = [];
  for (const a of accts) {
    const ob = KaminoObligation.fromAccountData(markets, addr(a.pubkey.toBase58()), a.account.data, li);
    if (!ob) continue;
    const market = markets.get(addr(marketOf(a.account.data)));
    if (!market) continue;
    const deposits = ob.getDeposits(), borrows = ob.getBorrows();
    if (!deposits.length && !borrows.length) continue;
    const m = meta.get(market.getAddress());
    const marketName = (m?.name ?? "Kamino market").replace(/ Market$/, "") + " market";
    const p = toPosition(owner, ob, market, li, marketName, m?.lookupTable);
    if (p && (p.valueUsd > 0.01 || p.legs.some((l) => l.side === "borrow"))) out.push(p);
  }
  return out;
}

function toPosition(owner: string, ob: KaminoObligation, market: KaminoMarket, li: LedgerInstant, marketName: string, lookupTable?: string): Position | null {
  const s = ob.refreshedStats;
  const tag = ob.obligationTag;
  const mk = (pos: ReturnType<KaminoObligation["getDeposits"]>[number], side: "supply" | "borrow"): { leg: Leg; raw: RawLeg } | null => {
    const r = market.getReserveByAddress(pos.reserveAddress);
    if (!r) return null;
    const amount = n(pos.amount.div(pos.mintFactor));
    const apy = side === "supply" ? r.totalSupplyAPY(li) : r.totalBorrowAPY(li);
    const symbol = r.symbol;
    const mint = r.getLiquidityMint();
    return {
      leg: { side, symbol, mint, amount, valueUsd: n(pos.marketValueRefreshed), apy: Number.isFinite(apy) ? apy : undefined },
      raw: { reserve: r.address, mint, symbol, decimals: r.getMintDecimals(), amount },
    };
  };
  const dep = ob.getDeposits().map((d) => mk(d, "supply")).filter((x): x is NonNullable<typeof x> => !!x);
  const bor = ob.getBorrows().map((d) => mk(d, "borrow")).filter((x): x is NonNullable<typeof x> => !!x);
  const legs = [...dep.map((x) => x.leg), ...bor.map((x) => x.leg)];

  const supplied = n(s.userTotalDeposit), borrowed = n(s.userTotalBorrow);
  const net = n(s.netAccountValue);
  const ltv = n(s.loanToValue), liqLtv = n(s.liquidationLtv);
  const leverage = net > 0 ? supplied / net : 0;
  const earn = dep.reduce((t, x) => t + x.leg.valueUsd * (x.leg.apy ?? 0), 0) - bor.reduce((t, x) => t + x.leg.valueUsd * (x.leg.apy ?? 0), 0);
  const netApy = net > 0 ? earn / net : 0;

  const uniq = (a: string[]) => [...new Set(a)];
  const dSyms = uniq(dep.map((x) => x.leg.symbol)), bSyms = uniq(bor.map((x) => x.leg.symbol));
  const leveraged = isLeveraged(tag);
  const title = leveraged && dSyms.length && bSyms.length
    ? `${dSyms.join("+")}/${bSyms.join("+")} ${TAG_NAMES[tag]} · ${leverage.toFixed(1)}x`
    : bSyms.length ? `${dSyms.join(" + ") || "—"} → borrowing ${bSyms.join(" + ")}` : `Lending ${dSyms.join(" + ")}`;

  // ---- risk ----
  let risk: Position["risk"];
  if (borrowed > 0 && liqLtv > 0) {
    const buffer = Math.max(0, 1 - ltv / liqLtv); // relative move of collateral vs debt that triggers liquidation
    const fams = new Set([...dSyms, ...bSyms].map(family));
    const correlated = fams.size === 1;
    const health = Math.min(100, buffer * 100 * (correlated ? 4 : 2));
    let extra: { liqPrice?: number; markPrice?: number } = {};
    let reason = `LTV ${pct(ltv)} vs ${pct(liqLtv)} liquidation`;
    if (dep.length === 1 && bor.length === 1) {
      const c = dep[0].leg, d = bor[0].leg;
      const cr = market.getReserveByAddress(addr(dep[0].raw.reserve))!, dr = market.getReserveByAddress(addr(bor[0].raw.reserve))!;
      const pc = n(cr.getOracleMarketPrice()), pd = n(dr.getOracleMarketPrice());
      // LTV is linear in each price, so liquidation is at price × (ltv / liqLtv) for collateral (inverse for debt).
      // Using the program's own LTV keeps elevation-group / borrow-factor rules consistent.
      const k = ltv / liqLtv;
      if (c.amount > 0 && pc > 0 && pd > 0 && k > 0) {
        if (family(d.symbol) === "usd" && family(c.symbol) !== "usd") {
          extra = { liqPrice: pc * k, markPrice: pc };
          reason += ` · liquidates if ${c.symbol} < ${usd(extra.liqPrice!)}`;
        } else if (family(c.symbol) === "usd" && family(d.symbol) !== "usd") {
          extra = { liqPrice: pd / k, markPrice: pd };
          reason += ` · liquidates if ${d.symbol} > ${usd(extra.liqPrice!)}`;
        } else {
          extra = { liqPrice: (pc / pd) * k, markPrice: pc / pd };
          reason += ` · liquidates if ${c.symbol}/${d.symbol} < ${num(extra.liqPrice!, 4)}`;
        }
      }
    } else {
      reason += ` · collateral can fall ${pct(buffer, 0)} vs debt`;
    }
    risk = riskFromHealth(health, reason, extra);
  } else {
    risk = { level: "ok", score: Math.min(20, Math.round(Math.log10(Math.max(net, 1)) * 3)) };
  }

  // ---- metrics ----
  const metrics: Metric[] = [];
  const lstColl = dSyms.some((x) => family(x) === "sol" && x.toUpperCase() !== "SOL");
  metrics.push({ label: `${borrowed > 0 ? "Net APY" : "Supply APY"}${lstColl ? " (excl. staking)" : ""}`, value: pct(netApy, 2), tone: netApy >= 0 ? "pos" : "neg" });
  if (borrowed > 0) {
    metrics.push({ label: "LTV", value: `${pct(ltv)} / ${pct(liqLtv)}`, tone: risk.level === "danger" ? "neg" : risk.level === "watch" ? "warn" : undefined });
    if (leveraged) metrics.push({ label: "Leverage", value: `${leverage.toFixed(2)}x` });
    metrics.push({ label: "Borrowed", value: usd(borrowed), tone: "muted" });
  } else {
    metrics.push({ label: "Supplied", value: usd(supplied) });
  }
  if (risk.liqPrice) metrics.push({ label: "Liq. price", value: risk.liqPrice < 10 ? num(risk.liqPrice, 4) : usd(risk.liqPrice), tone: "warn" });

  // ---- actions ----
  const actions: Action[] = [];
  if (dep.length === 1 && bor.length === 1) {
    actions.push({ id: "close", label: leveraged ? "Close position" : "Repay with collateral & close", intent: "close", danger: true });
  }
  const dupe = (sym: string, list: typeof bor) => list.filter((x) => x.raw.symbol === sym).length > 1;
  for (const b of bor) actions.push({
    id: `repay:${b.raw.reserve}`, label: `Repay ${b.raw.symbol}${dupe(b.raw.symbol, bor) ? ` (${pct(b.leg.apy ?? 0)} APY)` : ""}`, intent: "repay",
    fields: [{ name: "amount", label: `Amount (${b.raw.symbol})`, kind: "amount", unit: b.raw.symbol, max: b.raw.amount }],
  });
  for (const d of dep) actions.push({
    id: `withdraw:${d.raw.reserve}`, label: `Withdraw ${d.raw.symbol}`, intent: "withdraw", danger: borrowed > 0,
    fields: [{ name: "amount", label: `Amount (${d.raw.symbol})`, kind: "amount", unit: d.raw.symbol, max: d.raw.amount }],
  });
  if (dep.length) actions.push({
    id: "deposit", label: "Deposit more", intent: "deposit",
    fields: [
      ...(dep.length > 1 ? [{ name: "reserve", label: "Asset", kind: "select" as const, options: dep.map((d) => ({ value: d.raw.reserve, label: d.raw.symbol })), default: dep[0].raw.reserve }] : []),
      { name: "amount", label: dep.length > 1 ? "Amount" : `Amount (${dep[0].raw.symbol})`, kind: "amount" as const, unit: dep.length > 1 ? undefined : dep[0].raw.symbol },
    ],
  });

  const raw: LendRaw = {
    type: "obligation", market: market.getAddress(), marketName, obligation: ob.obligationAddress, tag, lookupTable,
    deposits: dep.map((x) => x.raw), borrows: bor.map((x) => x.raw), owner,
  };
  return {
    id: `kamino:${ob.obligationAddress}`,
    protocol: "kamino",
    kind: "lending",
    title,
    subtitle: `${marketName} · ${leveraged ? `${TAG_NAMES[tag]}${tag >= 4 ? " (fixed rate)" : ""}` : borrowed > 0 ? "Borrow" : "Supply"}`,
    valueUsd: net,
    legs, metrics, risk, actions,
    url: leveraged ? "https://kamino.com/multiply" : "https://kamino.com/borrow",
    raw,
    updatedAt: Date.now(),
  };
}

// ---------- builds ----------

async function loadForBuild(raw: LendRaw) {
  const rpc = kitRpc();
  const [market, li] = await Promise.all([KaminoMarket.load(rpc, addr(raw.market), await slotDurationMs()), getCurrentLedgerInstant(rpc)]);
  if (!market) throw new Error("Couldn't load the Kamino market.");
  const ob = await KaminoObligation.load(market, addr(raw.obligation), li);
  if (!ob) throw new Error("Obligation not found — it may have been closed.");
  return { rpc, market, li, ob };
}

async function compile(owner: string, ixs: readonly Instruction[], lutAddrs: string[]): Promise<string> {
  const luts = await lookupTables(lutAddrs.filter(Boolean));
  return buildTx(owner, toWeb3All(ixs), { luts, cuLimit: 1_000_000 });
}

/** Amount param → base units, or U64_MAX when the user asked for (≈) everything. */
function amountOrAll(param: string | undefined, max: number, decimals: number): { amount: string; all: boolean } {
  if (!param || param.trim().toLowerCase() === "max") return { amount: U64_MAX, all: true };
  const ui = Number(param);
  if (!(ui > 0)) throw new Error("Enter an amount greater than zero.");
  if (max > 0 && ui >= max * 0.9999) return { amount: U64_MAX, all: true };
  return { amount: toBaseUnits(param, decimals), all: false };
}

export async function buildLend(owner: string, position: Position, actionId: string, params: Record<string, string>): Promise<BuiltAction> {
  const raw = position.raw as LendRaw;
  if (raw?.type !== "obligation") throw new Error("Not a Kamino obligation.");
  const { market, li, ob } = await loadForBuild(raw);
  const own = signer(owner);
  const common = { kaminoMarket: market, owner: own, obligation: ob, useV2Ixs: true, scopeRefreshConfig: undefined, currentLedgerInstant: li, includeAtaIxs: true };
  const marketLut = raw.lookupTable ? [raw.lookupTable] : [];
  const [kind, reserveId] = actionId.split(":");

  if (kind === "repay" || kind === "withdraw") {
    const leg = (kind === "repay" ? raw.borrows : raw.deposits).find((l) => l.reserve === reserveId);
    if (!leg) throw new Error("That asset is no longer in this position.");
    // Use the live amount (interest accrues) as the "max" reference.
    const live = kind === "repay" ? ob.getBorrowByReserve(addr(leg.reserve)) : ob.getDepositByReserve(addr(leg.reserve));
    const max = live ? n(live.amount.div(live.mintFactor)) : leg.amount;
    const { amount, all } = amountOrAll(params.amount, max, leg.decimals);
    if (kind === "repay") {
      const need = all ? max * 1.0001 : Number(params.amount);
      const have = await walletBalance(connection(), owner, leg.mint);
      if (have < need) throw new Error(`You hold ${num(have, 6)} ${leg.symbol} but this repay needs ${num(need, 6)} ${leg.symbol}. Swap for more ${leg.symbol} first${raw.deposits.length === 1 && raw.borrows.length === 1 ? ", or use Close (repays with collateral)" : ""}.`);
    }
    const action = kind === "repay"
      ? await KaminoAction.buildRepayTxns({ ...common, amount, reserveAddress: addr(leg.reserve) })
      : await KaminoAction.buildWithdrawTxns({ ...common, amount, reserveAddress: addr(leg.reserve) });
    const tx = await compile(owner, KaminoAction.actionToIxs(action), [...action.luts, ...marketLut]);
    const what = all ? `all ${leg.symbol}` : `${params.amount} ${leg.symbol}`;
    const warnings: string[] = [];
    if (kind === "repay" && all) warnings.push(`Repaying everything needs slightly more than ${num(max, 6)} ${leg.symbol} in your wallet (interest accrues every slot).`);
    if (kind === "withdraw" && raw.borrows.length) warnings.push("Withdrawing collateral raises your LTV; the program rejects withdrawals that would exceed the borrow limit.");
    return { txs: [tx], summary: kind === "repay" ? `Repay ${what} on Kamino (${raw.marketName}).` : `Withdraw ${what} from Kamino (${raw.marketName}).`, warnings };
  }

  if (kind === "deposit") {
    const leg = raw.deposits.find((l) => l.reserve === (params.reserve || raw.deposits[0]?.reserve));
    if (!leg) throw new Error("Pick an asset to deposit.");
    if (!(Number(params.amount) > 0)) throw new Error("Enter an amount greater than zero.");
    await ensureBalance(owner, leg.mint, leg.symbol, Number(params.amount));
    const action = await KaminoAction.buildDepositTxns({ ...common, amount: toBaseUnits(params.amount, leg.decimals), reserveAddress: addr(leg.reserve) });
    const tx = await compile(owner, KaminoAction.actionToIxs(action), [...action.luts, ...marketLut]);
    return { txs: [tx], summary: `Deposit ${params.amount} ${leg.symbol} into your Kamino position (${raw.marketName}).` };
  }

  if (kind === "close") {
    if (raw.deposits.length !== 1 || raw.borrows.length !== 1) throw new Error("One-click close only works for single-collateral, single-debt positions — repay and withdraw each asset instead.");
    const coll = raw.deposits[0], debt = raw.borrows[0];
    const live = ob.getBorrowByReserve(addr(debt.reserve));
    const repayUi = live ? live.amount.div(live.mintFactor) : new Decimal(debt.amount);
    const slippageBps = Number(params.slippageBps) > 0 ? Number(params.slippageBps) : 30;
    const fee = await priorityFee([raw.obligation, coll.reserve, debt.reserve]);
    let lastErr: unknown;
    // Jupiter routes vary in account count; shrink the route until the whole close fits in one tx.
    for (const maxAccounts of [28, 20, 14, 8]) {
      const jup = jupiterSwapper(owner, { [coll.mint]: coll.decimals, [debt.mint]: debt.decimals }, slippageBps, maxAccounts);
      let res;
      try {
        res = await getRepayWithCollIxs({
          kaminoMarket: market, debtReserveAddress: addr(debt.reserve), collReserveAddress: addr(coll.reserve), owner: own, obligation: ob,
          referrer: none(), currentLedgerInstant: li, repayAmount: new Decimal(repayUi.toString()), isClosingPosition: true,
          // Flash-loan ixs encode absolute ix indexes, so the compute budget must be part of the SDK's ix list.
          budgetAndPriorityFeeIxs: [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee }),
          ].map(fromWeb3),
          scopeRefreshIx: [], logger: () => {}, useV2Ixs: true, slippagePct: new Decimal(slippageBps / 100),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          quoter: jup.quoter as any, swapper: jup.swapper as any,
        });
      } catch (e) { lastErr = e; continue; }
      for (const r of res) {
        try {
          const luts = [...r.lookupTables.map((t) => t.address as string), ...jup.luts, ...marketLut];
          const tx = await compile(owner, r.ixs, luts);
          const size = Buffer.from(tx, "base64").length;
          if (size > 1232) { lastErr = new Error(`transaction is ${size} bytes (max 1232)`); continue; }
          return {
            txs: [tx],
            summary: `Close your ${coll.symbol}/${debt.symbol} position: flash-repay ${num(n(repayUi), 4)} ${debt.symbol} by swapping ${coll.symbol} via Jupiter, then withdraw the remaining ${coll.symbol} to your wallet.`,
            warnings: [`Swap slippage up to ${(slippageBps / 100).toFixed(2)}%. Sign promptly — the quote is only valid for a short time.`],
          };
        } catch (e) { lastErr = e; }
      }
    }
    throw new Error(`Couldn't fit the close into one transaction: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}. Repay and withdraw separately instead.`);
  }

  throw new Error(`Unknown Kamino action ${actionId}`);
}

async function ensureBalance(owner: string, mint: string, symbol: string, need: number) {
  const have = await walletBalance(connection(), owner, mint);
  if (have < need) throw new Error(`You hold ${num(have, 6)} ${symbol}; not enough to deposit ${num(need, 6)}.`);
}

// ---------- tool: deposit into the Main market ----------

export const DEPOSIT_ASSETS = ["USDC", "SOL", "USDT", "JitoSOL", "JupSOL", "cbBTC", "PYUSD", "USDG", "mSOL", "JTO", "JUP"];

export async function buildDepositTool(owner: string, params: Record<string, string>): Promise<BuiltAction> {
  const rpc = kitRpc();
  const [market, li, meta] = await Promise.all([KaminoMarket.load(rpc, addr(MAIN_MARKET), await slotDurationMs()), getCurrentLedgerInstant(rpc), marketsMeta()]);
  if (!market) throw new Error("Couldn't load the Kamino Main market.");
  const sym = params.asset || "USDC";
  const reserve = market.getFloatRateReserveBySymbol(sym) ?? market.getReserves().find((r) => r.symbol.toUpperCase() === sym.toUpperCase());
  if (!reserve) throw new Error(`Kamino Main market has no ${sym} reserve.`);
  if (!(Number(params.amount) > 0)) throw new Error("Enter an amount greater than zero.");
  await ensureBalance(owner, reserve.getLiquidityMint(), reserve.symbol, Number(params.amount));
  const own = signer(owner);
  const existing = await market.getObligationByWallet(addr(owner), new VanillaObligation(PROGRAM_ID));
  const action = await KaminoAction.buildDepositTxns({
    kaminoMarket: market, amount: toBaseUnits(params.amount, reserve.getMintDecimals()), reserveAddress: reserve.address, owner: own,
    obligation: existing ?? new VanillaObligation(PROGRAM_ID), useV2Ixs: true, scopeRefreshConfig: undefined, currentLedgerInstant: li,
    includeAtaIxs: true, initUserMetadata: { skipInitialization: false, skipLutCreation: true },
  });
  const lut = meta.get(MAIN_MARKET)?.lookupTable;
  const tx = await compile(owner, KaminoAction.actionToIxs(action), [...action.luts, ...(lut ? [lut] : [])]);
  const apy = reserve.totalSupplyAPY(li);
  return {
    txs: [tx], summary: `Supply ${params.amount} ${reserve.symbol} to Kamino Lend (Main market) at ~${pct(apy, 2)} APY.`,
    warnings: existing ? undefined : ["First Kamino deposit: also creates your Kamino account (~0.02 SOL refundable rent)."],
  };
}
