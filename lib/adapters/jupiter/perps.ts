/**
 * Jupiter Perpetuals via perps-api.jup.ag. Positions, close/decrease/withdraw
 * collateral and TP/SL all return "legacy" request transactions (the keeper fills
 * them a few seconds later) that go through a normal RPC sendTransaction.
 * Anything the API flags `requireKeeperSignature` must go via Jupiter's own
 * /transaction/execute, so we refuse to build it.
 */
import type { Action, BuiltAction, Position } from "@/lib/core/types";
import { num, pct, riskFromHealth, usd } from "@/lib/core/solana";
import { BTC, ETH, KNOWN, PERPS, SOL, USDC, jfetch, n } from "./http";

interface ApiTpsl { positionRequestPubkey: string; requestType: "tp" | "sl"; triggerPriceUsd?: string; triggerPrice?: string; sizePercentage?: string }
interface ApiPosition {
  positionPubkey: string; side: "long" | "short";
  marketMint?: string; assetMint?: string; collateralMint: string;
  size?: string; sizeUsd?: string; sizeUsdDelta?: string; sizeTokenAmount?: string;
  collateral?: string; collateralUsd?: string; value?: string; valueUsd?: string;
  leverage?: string; entryPrice?: string; entryPriceUsd?: string; markPrice?: string; markPriceUsd?: string;
  liquidationPrice?: string; liquidationPriceUsd?: string;
  pnlAfterFeesUsd?: string; pnlChangePctAfterFees?: string; pnlAfterFeesPct?: string; totalFeesUsd?: string; borrowFeesUsd?: string;
  tpslRequests?: ApiTpsl[]; createdTime?: number;
}
interface ApiLimitOrder {
  positionRequestPubkey: string; positionPubkey?: string; side: "long" | "short";
  marketMint?: string; custody?: string; collateralMint?: string; inputMint?: string;
  sizeUsdDelta?: string; sizeUsd?: string; collateralUsd?: string; triggerPrice?: string | null; triggerPriceUsd?: string;
  liquidationPriceUsd?: string; executed?: boolean; openTime?: string | number; collateralTokenAmount?: string;
}
interface TxResp { serializedTxBase64?: string | null; requireKeeperSignature?: boolean | null; transactionType?: string; message?: string; quote?: Record<string, string> }

/** USD value from a field that's either "1234.56" (formatted) or "1234560000" (6-dp raw). */
const usdField = (formatted?: string, raw?: string) => formatted != null ? n(formatted) : n(raw) / 1e6;
const sym = (mint?: string) => (mint && KNOWN[mint]?.symbol) || mint?.slice(0, 4) || "?";
const appUrl = (mint?: string) => `https://jup.ag/perps/${sym(mint).toLowerCase()}`;
const toRaw6 = (x: number) => BigInt(Math.round(x * 1e6)).toString();

function txOrThrow(r: TxResp, what: string): string {
  if (r.requireKeeperSignature) throw new Error(`Jupiter requires its own keeper co-signature for ${what}; do it on jup.ag.`);
  if (!r.serializedTxBase64) throw new Error(r.message ?? `Jupiter returned no transaction for ${what}.`);
  return r.serializedTxBase64;
}

export async function perpPositions(owner: string): Promise<Position[]> {
  const res = await jfetch<{ dataList?: ApiPosition[] }>(`${PERPS}/positions?walletAddress=${owner}`);
  const list = res.dataList ?? [];
  // Collateral withdrawal limits (one cheap call per position, parallel; best-effort).
  const limits = await Promise.all(list.map((p) =>
    jfetch<{ maxCollateralWithdrawalUsd?: string }>(`${PERPS}/positions/collateral-limits?positionPubkey=${p.positionPubkey}&inputMint=${p.collateralMint}`, { retries: 0, timeoutMs: 5000 })
      .then((l) => n(l.maxCollateralWithdrawalUsd) / 1e6).catch(() => undefined)));
  return list.map((p, i) => perpToPosition(p, limits[i]));
}

function perpToPosition(p: ApiPosition, maxWithdrawUsd?: number): Position {
  const market = p.marketMint ?? p.assetMint;
  const asset = sym(market);
  const sizeUsd = usdField(p.size ?? (p.sizeUsd?.includes(".") ? p.sizeUsd : undefined), p.sizeUsdDelta ?? p.sizeUsd);
  const sizeRaw = p.sizeUsdDelta ?? toRaw6(sizeUsd);
  const collateralUsd = usdField(p.collateral, p.collateralUsd);
  const pnl = n(p.pnlAfterFeesUsd);
  const value = p.value != null ? n(p.value) : collateralUsd + pnl;
  const entry = n(p.entryPrice ?? p.entryPriceUsd);
  const mark = n(p.markPrice ?? p.markPriceUsd);
  const liq = n(p.liquidationPrice ?? p.liquidationPriceUsd);
  const lev = n(p.leverage) || (collateralUsd ? sizeUsd / collateralUsd : 0);
  const dec = KNOWN[market ?? ""]?.decimals ?? 9;
  const sizeTokens = n(p.sizeTokenAmount) / 10 ** dec;

  const dist = liq > 0 && mark > 0 ? (p.side === "long" ? (mark - liq) / mark : (liq - mark) / mark) : 1;
  const health = Math.max(0, dist) / 0.5 * 100; // 50%+ away from liquidation = fully safe
  const risk = liq > 0
    ? riskFromHealth(health, dist <= 0 ? `Mark ${usd(mark)} is past liquidation ${usd(liq)}` : `${pct(dist)} from liquidation price ${usd(liq)}`, { liqPrice: liq, markPrice: mark })
    : { level: "ok" as const, score: 10, reason: "No liquidation price", markPrice: mark };

  const collSym = sym(p.collateralMint);
  const receiveOpts = [...new Set([collSym, "USDC", asset].filter((s) => ["SOL", "ETH", "BTC", "USDC"].includes(s)))].map((s) => ({ value: s, label: s }));
  const tpsl = (p.tpslRequests ?? []).map((t) => ({ pubkey: t.positionRequestPubkey, type: t.requestType, price: n(t.triggerPriceUsd ?? (t.triggerPrice ? n(t.triggerPrice) / 1e6 : 0)), pctOfSize: n(t.sizePercentage, 100) }));
  const tp = tpsl.find((t) => t.type === "tp"), sl = tpsl.find((t) => t.type === "sl");

  const actions: Action[] = [
    { id: "close", label: "Close position", intent: "close", danger: true, fields: [{ name: "receive", label: "Receive", kind: "select", default: receiveOpts[0]?.value ?? "USDC", options: receiveOpts }] },
    { id: "reduce", label: "Reduce size", intent: "reduce", fields: [{ name: "percent", label: "Close %", kind: "percent", max: 100, default: "50" }, { name: "receive", label: "Receive", kind: "select", default: receiveOpts[0]?.value ?? "USDC", options: receiveOpts }] },
    ...(maxWithdrawUsd && maxWithdrawUsd > 1 ? [{ id: "withdraw-collateral", label: "Withdraw collateral", intent: "withdraw" as const, fields: [{ name: "amount", label: "Amount", kind: "amount" as const, unit: "USD", max: Math.floor(maxWithdrawUsd * 100) / 100 }, { name: "receive", label: "Receive", kind: "select" as const, default: receiveOpts[0]?.value ?? "USDC", options: receiveOpts }] }] : []),
    { id: "set-tpsl", label: tp || sl ? "Add TP / SL" : "Set TP / SL", intent: "other", fields: [
      { name: "tp", label: "Take profit price", kind: "price", unit: "USD" },
      { name: "sl", label: "Stop loss price", kind: "price", unit: "USD" },
    ] },
    ...(tpsl.length ? [{ id: "cancel-tpsl", label: "Cancel TP / SL", intent: "cancel" as const, fields: [{ name: "request", label: "Order", kind: "select" as const, default: tpsl[0].pubkey, options: tpsl.map((t) => ({ value: t.pubkey, label: `${t.type.toUpperCase()} @ ${usd(t.price)}` })) }] }] : []),
  ];

  return {
    id: `jupiter:${p.positionPubkey}`,
    protocol: "jupiter", kind: "perp",
    title: `${asset}-PERP ${p.side === "long" ? "Long" : "Short"}`,
    subtitle: `Jupiter Perps · ${num(lev, 1)}x · ${collSym} collateral`,
    valueUsd: value, pnlUsd: pnl,
    legs: [{ side: p.side, symbol: asset, mint: market, amount: sizeTokens, valueUsd: sizeUsd }],
    metrics: [
      { label: "Size", value: usd(sizeUsd, 0) },
      { label: "Leverage", value: `${num(lev, 1)}x`, tone: lev >= 20 ? "warn" as const : undefined },
      { label: "Entry / Mark", value: `${usd(entry)} / ${usd(mark)}` },
      { label: "Liq. price", value: liq ? usd(liq) : "—", tone: risk.level === "danger" ? "neg" as const : risk.level === "watch" ? "warn" as const : undefined },
      { label: "PnL", value: `${usd(pnl)} (${num(n(p.pnlChangePctAfterFees ?? p.pnlAfterFeesPct), 1)}%)`, tone: pnl >= 0 ? "pos" as const : "neg" as const },
      ...(tp || sl ? [{ label: "TP / SL", value: `${tp ? usd(tp.price) : "—"} / ${sl ? usd(sl.price) : "—"}`, tone: "muted" as const }] : []),
    ].slice(0, 6) as Position["metrics"],
    risk, actions, url: appUrl(market),
    raw: { kind: "perp", positionPubkey: p.positionPubkey, side: p.side, marketMint: market ?? null, collateralMint: p.collateralMint, sizeUsdRaw: sizeRaw, sizeUsd, collateralUsd, entryPrice: entry, markPrice: mark, liqPrice: liq, tpsl },
    updatedAt: Date.now(),
  };
}

const RECEIVE_MINT: Record<string, string> = { SOL, ETH, BTC, USDC };

export async function buildPerp(owner: string, pos: Position, actionId: string, params: Record<string, string>): Promise<BuiltAction> {
  const raw = pos.raw as { positionPubkey: string; side: string; marketMint: string; collateralMint: string; sizeUsdRaw: string; sizeUsd: number; tpsl: { pubkey: string; type: string; price: number }[] };
  const desiredMint = RECEIVE_MINT[params.receive ?? ""] ?? raw.collateralMint;
  const recvSym = sym(desiredMint);
  const asset = sym(raw.marketMint);

  if (actionId === "close" || actionId === "reduce") {
    const p = actionId === "close" ? 100 : Math.min(100, Math.max(0, Number(params.percent)));
    if (!(p > 0)) throw new Error("Enter a percentage between 1 and 100.");
    const entire = p >= 100;
    const sizeDelta = entire ? "0" : (BigInt(raw.sizeUsdRaw) * BigInt(Math.round(p * 100)) / BigInt(10000)).toString();
    const r = await jfetch<TxResp>(`${PERPS}/positions/decrease`, { body: { positionPubkey: raw.positionPubkey, entirePosition: entire, sizeUsdDelta: sizeDelta, collateralUsdDelta: "0", desiredMint, maxSlippageBps: "200" } });
    const out = r.quote?.transferAmountUsd ? ` (~${usd(n(r.quote.transferAmountUsd))} back in ${recvSym})` : "";
    return {
      txs: [txOrThrow(r, "this decrease")],
      summary: entire ? `Close your ${asset} ${raw.side} at market${out}.` : `Close ${p}% (${usd(raw.sizeUsd * p / 100, 0)}) of your ${asset} ${raw.side}${out}.`,
      warnings: ["Jupiter Perps fills this as a request: a keeper executes it within a few seconds at the oracle price (max 2% slippage)."],
    };
  }
  if (actionId === "withdraw-collateral") {
    const amt = Number(params.amount);
    if (!(amt > 0)) throw new Error("Enter a USD amount greater than zero.");
    const r = await jfetch<TxResp>(`${PERPS}/positions/decrease`, { body: { positionPubkey: raw.positionPubkey, entirePosition: false, sizeUsdDelta: "0", collateralUsdDelta: toRaw6(amt), desiredMint, maxSlippageBps: "200" } });
    const lev = r.quote?.leverage ? ` New leverage ~${num(n(r.quote.leverage), 1)}x, liquidation ${usd(n(r.quote.liquidationPriceUsd))}.` : "";
    return { txs: [txOrThrow(r, "collateral withdrawal")], summary: `Withdraw ${usd(amt)} of collateral from your ${asset} ${raw.side} as ${recvSym}.${lev}`, warnings: ["Withdrawing collateral raises leverage and moves your liquidation price closer."] };
  }
  if (actionId === "set-tpsl") {
    const tpsl: Record<string, unknown>[] = [];
    for (const type of ["tp", "sl"] as const) {
      const price = Number(params[type]);
      if (params[type] && price > 0) tpsl.push({ requestType: type, triggerPrice: toRaw6(price), desiredMint: raw.collateralMint, entirePosition: true, sizeUsdDelta: "0" });
    }
    if (!tpsl.length) throw new Error("Enter a take-profit and/or stop-loss price.");
    const r = await jfetch<TxResp>(`${PERPS}/tpsl`, { body: { owner, positionPubkey: raw.positionPubkey, transactionType: "legacy", tpsl } });
    const parts = tpsl.map((t) => `${(t.requestType as string).toUpperCase()} at ${usd(n(t.triggerPrice) / 1e6)}`).join(" and ");
    return { txs: [txOrThrow(r, "TP/SL")], summary: `Set ${parts} to close your whole ${asset} ${raw.side}.` };
  }
  if (actionId === "cancel-tpsl") {
    const req = raw.tpsl.find((t) => t.pubkey === params.request) ?? (raw.tpsl.length === 1 ? raw.tpsl[0] : undefined);
    if (!req) throw new Error("Pick the TP / SL order to cancel.");
    const r = await jfetch<TxResp>(`${PERPS}/tpsl`, { method: "DELETE", body: { positionRequestPubkey: req.pubkey } });
    return { txs: [txOrThrow(r, "TP/SL cancel")], summary: `Cancel the ${req.type.toUpperCase()} at ${usd(req.price)} on your ${asset} ${raw.side}.` };
  }
  throw new Error(`Unknown perps action ${actionId}`);
}

// ---------- perps limit orders ----------

export async function perpLimitOrders(owner: string): Promise<Position[]> {
  const res = await jfetch<{ dataList?: ApiLimitOrder[] }>(`${PERPS}/orders/limit?walletAddress=${owner}`);
  return (res.dataList ?? []).filter((o) => !o.executed).map((o) => {
    const market = o.marketMint ?? o.custody;
    const asset = sym(market);
    const size = usdField(o.sizeUsd?.includes(".") ? o.sizeUsd : undefined, o.sizeUsdDelta ?? o.sizeUsd);
    const coll = usdField(o.collateralUsd?.includes(".") ? o.collateralUsd : undefined, o.collateralUsd);
    const trig = o.triggerPriceUsd != null ? n(o.triggerPriceUsd) : n(o.triggerPrice) / 1e6;
    return {
      id: `jupiter:${o.positionRequestPubkey}`, protocol: "jupiter", kind: "order",
      title: `${asset}-PERP limit ${o.side}`, subtitle: `Jupiter Perps · trigger ${usd(trig)}`,
      valueUsd: coll, legs: [{ side: o.side, symbol: asset, mint: market, amount: trig ? size / trig : 0, valueUsd: size }],
      metrics: [{ label: "Trigger", value: usd(trig) }, { label: "Size", value: usd(size, 0) }, { label: "Collateral", value: usd(coll) }, ...(o.liquidationPriceUsd ? [{ label: "Liq. after fill", value: usd(usdField(o.liquidationPriceUsd.includes(".") ? o.liquidationPriceUsd : undefined, o.liquidationPriceUsd)) }] : [])],
      risk: { level: "ok", score: 15, reason: "Waiting for trigger price" },
      actions: [{ id: "cancel-limit", label: "Cancel order", intent: "cancel" }],
      url: appUrl(market),
      raw: { kind: "perp-limit", positionRequestPubkey: o.positionRequestPubkey, asset, side: o.side, triggerPrice: trig, claimsMints: [] },
      updatedAt: Date.now(),
    } satisfies Position;
  });
}

export async function buildPerpLimitCancel(pos: Position): Promise<BuiltAction> {
  const raw = pos.raw as { positionRequestPubkey: string; asset: string; side: string; triggerPrice: number };
  const r = await jfetch<TxResp>(`${PERPS}/orders/limit`, { method: "DELETE", body: { positionRequestPubkey: raw.positionRequestPubkey } });
  return { txs: [txOrThrow(r, "limit cancel")], summary: `Cancel your ${raw.asset} ${raw.side} limit order at ${usd(raw.triggerPrice)} and get the collateral back.` };
}
