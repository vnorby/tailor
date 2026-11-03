/**
 * Jupiter Lend (Earn jlTokens + Borrow vaults) via api.jup.ag/lend/v1, and JLP
 * loans (borrow USDC against JLP) via perps-api. All return ready unsigned txs.
 */
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import type { BuiltAction, Ctx, Position } from "@/lib/core/types";
import { buildTx, num, pct, riskFromHealth, usd } from "@/lib/core/solana";
import { JLP, JUP, PERPS, SOL, USDC, jfetch, n } from "./http";

const MIN_I128 = "-170141183460469231731687303715884105728";

interface LendToken { address: string; symbol: string; decimals: number; uiSymbol?: string; price?: string; logoUrl?: string }
interface EarnToken extends LendToken { assetAddress: string; asset: LendToken; supplyRate?: string; rewardsRate?: string; totalRate?: string }
interface EarnPos { token: EarnToken; ownerAddress: string; shares: string; underlyingAssets: string }
interface Vault { id: number; address: string; supplyToken: LendToken; borrowToken: LendToken; collateralFactor: string; liquidationThreshold: string; supplyRate: string; borrowRate: string; oraclePrice?: string; minimumBorrowing?: string }
interface BorrowPos { id: number; vaultId: number; address: string; supply: string; borrow: string; dustBorrow?: string; isLiquidated?: boolean; isSupplyPosition?: boolean; vault?: Vault }

const symOf = (t: LendToken) => (t.uiSymbol || t.symbol || "").replace(/^WSOL$/, "SOL");
const toAtomic = (ui: string | number, decimals: number) => {
  const [w, f = ""] = String(ui).trim().split(".");
  return (BigInt(w || "0") * BigInt(10) ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0")).toString();
};

// ---------- Earn ----------

export async function earnPositions(owner: string): Promise<Position[]> {
  const res = await jfetch<EarnPos[]>(`${JUP}/lend/v1/earn/positions?users=${owner}`);
  return (Array.isArray(res) ? res : []).filter((p) => n(p.shares) > 0).map((p) => {
    const t = p.token, a = t.asset;
    const amount = n(p.underlyingAssets) / 10 ** a.decimals;
    const price = n(a.price);
    const value = amount * price;
    const apy = n(t.totalRate) / 1e4;
    const sym = symOf(a);
    return {
      id: `jupiter:earn:${t.address}`, protocol: "jupiter", kind: "vault",
      title: `${sym} Earn`, subtitle: `Jupiter Lend · ${t.symbol}`,
      valueUsd: value,
      legs: [{ side: "supply", symbol: sym, mint: a.address, amount, valueUsd: value, apy }],
      metrics: [
        { label: "Deposited", value: `${num(amount)} ${sym}` },
        { label: "APY", value: pct(apy, 2), tone: "pos" },
        ...(n(t.rewardsRate) ? [{ label: "Rewards", value: pct(n(t.rewardsRate) / 1e4, 2), tone: "muted" as const }] : []),
      ],
      risk: { level: "ok", score: Math.min(15, Math.round(Math.log10(1 + value) * 3)) },
      actions: [{ id: "earn-withdraw", label: "Withdraw", intent: "withdraw", fields: [{ name: "amount", label: "Amount", kind: "amount", unit: sym, max: amount }] }],
      url: "https://jup.ag/lend/earn",
      raw: { kind: "earn", asset: a.address, assetDecimals: a.decimals, symbol: sym, jlMint: t.address, shares: p.shares, amount, claimsMints: [t.address] },
      updatedAt: Date.now(),
    } satisfies Position;
  });
}

export async function buildEarnWithdraw(owner: string, pos: Position, params: Record<string, string>): Promise<BuiltAction> {
  const raw = pos.raw as { asset: string; assetDecimals: number; symbol: string; shares: string; amount: number };
  const amt = Number(params.amount);
  if (!(amt > 0)) throw new Error("Enter an amount greater than zero.");
  const all = amt >= raw.amount * 0.9999;
  const r = all
    ? await jfetch<{ transaction?: string }>(`${JUP}/lend/v1/earn/redeem`, { body: { asset: raw.asset, signer: owner, shares: raw.shares } })
    : await jfetch<{ transaction?: string }>(`${JUP}/lend/v1/earn/withdraw`, { body: { asset: raw.asset, signer: owner, amount: toAtomic(params.amount, raw.assetDecimals) } });
  if (!r.transaction) throw new Error("Jupiter Lend returned no transaction.");
  return { txs: [r.transaction], summary: `Withdraw ${all ? `all ~${num(raw.amount)}` : num(amt)} ${raw.symbol} from Jupiter Lend Earn.`, warnings: raw.asset === SOL ? ["You'll receive wrapped SOL (WSOL); unwrap it in your wallet if needed."] : undefined };
}

// ---------- Borrow vaults ----------

export async function borrowPositions(owner: string): Promise<Position[]> {
  const res = await jfetch<BorrowPos[]>(`${JUP}/lend/v1/borrow/positions?users=${owner}`);
  const list = (Array.isArray(res) ? res : []).filter((p) => !p.isLiquidated && (n(p.supply) > 0 || n(p.borrow) > 0) && p.vault);
  return list.map((p) => {
    const v = p.vault!;
    const cs = symOf(v.supplyToken), ds = symOf(v.borrowToken);
    const coll = n(p.supply) / 10 ** v.supplyToken.decimals;
    const debt = n(p.borrow) / 10 ** v.borrowToken.decimals;
    const cp = n(v.supplyToken.price), dp = n(v.borrowToken.price);
    const collUsd = coll * cp, debtUsd = debt * dp;
    const ltv = collUsd > 0 ? debtUsd / collUsd : 0;
    const lt = n(v.liquidationThreshold) / 1000, maxLtv = n(v.collateralFactor) / 1000;
    const supplyApy = n(v.supplyRate) / 1e4, borrowApy = n(v.borrowRate) / 1e4;
    // Liquidation price of collateral (in debt-token terms × debt price) when LTV hits the threshold.
    const liqPrice = debt > 0 && coll > 0 && lt > 0 ? (debtUsd / (coll * lt)) : undefined;
    const risk = debt > 0
      ? riskFromHealth(lt > 0 ? (1 - ltv / lt) * 100 : 100, `LTV ${pct(ltv)} vs ${pct(lt, 0)} liquidation`, { liqPrice, markPrice: cp })
      : { level: "ok" as const, score: 5, reason: "No debt" };
    const actions: Position["actions"] = [];
    if (debt > 0) actions.push({ id: "borrow-repay", label: `Repay ${ds}`, intent: "repay", fields: [{ name: "amount", label: "Amount", kind: "amount", unit: ds, max: debt }] });
    if (coll > 0) {
      const maxWithdraw = debt > 0 && maxLtv > 0 ? Math.max(0, coll - debtUsd / (maxLtv * cp)) : coll;
      actions.push({ id: "borrow-withdraw", label: `Withdraw ${cs}`, intent: "withdraw", fields: [{ name: "amount", label: "Amount", kind: "amount", unit: cs, max: Math.floor(maxWithdraw * 1e6) / 1e6 }] });
    }
    return {
      id: `jupiter:borrow:${p.address}`, protocol: "jupiter", kind: "lending",
      title: `${cs} / ${ds}`, subtitle: `Jupiter Lend Borrow · vault #${p.vaultId} · position #${p.id}`,
      valueUsd: collUsd - debtUsd,
      legs: [
        { side: "supply", symbol: cs, mint: v.supplyToken.address, amount: coll, valueUsd: collUsd, apy: supplyApy },
        ...(debt > 0 ? [{ side: "borrow" as const, symbol: ds, mint: v.borrowToken.address, amount: debt, valueUsd: debtUsd, apy: borrowApy }] : []),
      ],
      metrics: [
        { label: "LTV", value: `${pct(ltv)} / ${pct(lt, 0)}`, tone: risk.level === "danger" ? "neg" : risk.level === "watch" ? "warn" : undefined },
        { label: "Collateral", value: `${num(coll)} ${cs}` },
        ...(debt > 0 ? [{ label: "Debt", value: `${num(debt, 2)} ${ds}` }, { label: "Borrow APY", value: pct(borrowApy, 2), tone: "muted" as const }] : []),
        ...(liqPrice ? [{ label: `${cs} liq. price`, value: usd(liqPrice) }] : []),
      ],
      risk, actions, url: "https://jup.ag/lend/borrow",
      raw: { kind: "borrow", vaultId: p.vaultId, positionId: p.id, coll, debt, collMint: v.supplyToken.address, collDecimals: v.supplyToken.decimals, collSym: cs, debtMint: v.borrowToken.address, debtDecimals: v.borrowToken.decimals, debtSym: ds },
      updatedAt: Date.now(),
    } satisfies Position;
  });
}

export async function buildBorrow(owner: string, pos: Position, actionId: string, params: Record<string, string>, ctx?: Ctx): Promise<BuiltAction> {
  const raw = pos.raw as { vaultId: number; positionId: number; coll: number; debt: number; collMint: string; collDecimals: number; collSym: string; debtMint: string; debtDecimals: number; debtSym: string };
  const amt = Number(params.amount);
  if (!(amt > 0)) throw new Error("Enter an amount greater than zero.");
  const o = new PublicKey(owner);
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, o);
  const txs: string[] = [];
  const warnings: string[] = [];
  let colAmount = "0", debtAmount = "0", summary: string;

  if (actionId === "borrow-repay") {
    const all = amt >= raw.debt * 0.9999;
    debtAmount = all ? MIN_I128 : "-" + toAtomic(params.amount, raw.debtDecimals);
    summary = `Repay ${all ? `all ~${num(raw.debt, 4)}` : num(amt)} ${raw.debtSym} on your ${raw.collSym}/${raw.debtSym} Jupiter Lend position.`;
    const held = ctx?.tokens.find((t) => t.mint === raw.debtMint)?.amount;
    if (held != null && held < Math.min(amt, raw.debt)) warnings.push(`You hold only ${num(held)} ${raw.debtSym}; swap for more first or the repay will fail.`);
    if (raw.debtMint === SOL) {
      // The API doesn't wrap SOL: fund the WSOL account first (slight buffer for accrued interest).
      const lamports = BigInt(toAtomic((all ? raw.debt * 1.001 : amt).toFixed(9), 9)) + BigInt(10_000);
      txs.push(await buildTx(owner, [
        createAssociatedTokenAccountIdempotentInstruction(o, wsolAta, o, NATIVE_MINT),
        SystemProgram.transfer({ fromPubkey: o, toPubkey: wsolAta, lamports }),
        createSyncNativeInstruction(wsolAta),
      ], { cuLimit: 60_000 }));
      warnings.push("Two transactions: wrap SOL, then repay.");
    }
  } else if (actionId === "borrow-withdraw") {
    const all = amt >= raw.coll * 0.9999 && raw.debt === 0;
    colAmount = all ? MIN_I128 : "-" + toAtomic(params.amount, raw.collDecimals);
    summary = `Withdraw ${all ? `all ~${num(raw.coll)}` : num(amt)} ${raw.collSym} collateral from your Jupiter Lend position.`;
    if (raw.debt > 0) warnings.push("Withdrawing collateral raises your LTV and liquidation price.");
  } else throw new Error(`Unknown borrow action ${actionId}`);

  const r = await jfetch<{ transaction?: string }>(`${JUP}/lend/v1/borrow/operate`, { body: { vaultId: raw.vaultId, positionId: raw.positionId, positionOwner: owner, signer: owner, colAmount, debtAmount } });
  if (!r.transaction) throw new Error("Jupiter Lend returned no transaction.");
  txs.push(r.transaction);
  if (actionId === "borrow-withdraw" && raw.collMint === SOL) {
    txs.push(await buildTx(owner, [createCloseAccountInstruction(wsolAta, o, o)], { cuLimit: 20_000 }));
    warnings.push("A second transaction unwraps the withdrawn WSOL to native SOL.");
  }
  return { txs, summary, warnings: warnings.length ? warnings : undefined };
}

// ---------- JLP loans (perps-api) ----------

interface JlpLoan { positionPubkey: string; borrowSizeUsd: string; borrowSizeTokenAmount: string; maxRepayTokenAmount: string; maxWithdrawTokenAmount: string; ltvPercentage: string; liquidationPriceUsd: string; collateralTokenAmount: string; collateralUsd: string }

export async function jlpLoans(owner: string, jlpPrice: number): Promise<Position[]> {
  const res = await jfetch<{ dataList?: JlpLoan[] }>(`${PERPS}/loans/positions?walletAddress=${owner}`);
  let liqMargin = 0.95;
  const list = (res.dataList ?? []).filter((l) => n(l.collateralTokenAmount) > 0 || n(l.borrowSizeTokenAmount) > 0);
  if (list.length) { try { liqMargin = n((await jfetch<{ liquidationMarginBps?: string }>(`${PERPS}/loans/info`)).liquidationMarginBps, 9500) / 1e4; } catch { /* default */ } }
  return list.map((l) => {
    const coll = n(l.collateralTokenAmount) / 1e6, debt = n(l.borrowSizeTokenAmount) / 1e6;
    const collUsd = n(l.collateralUsd) / 1e6 || coll * jlpPrice, debtUsd = n(l.borrowSizeUsd) / 1e6 || debt;
    const ltv = n(l.ltvPercentage) / 100 || (collUsd ? debtUsd / collUsd : 0);
    const liq = n(l.liquidationPriceUsd) / 1e6;
    const health = debt > 0 ? (1 - ltv / liqMargin) * 100 : 100;
    return {
      id: `jupiter:loan:${l.positionPubkey}`, protocol: "jupiter", kind: "lending",
      title: "JLP / USDC loan", subtitle: "Jupiter Perps · borrow USDC against JLP",
      valueUsd: collUsd - debtUsd,
      legs: [{ side: "supply", symbol: "JLP", mint: JLP, amount: coll, valueUsd: collUsd }, ...(debt > 0 ? [{ side: "borrow" as const, symbol: "USDC", mint: USDC, amount: debt, valueUsd: debtUsd }] : [])],
      metrics: [{ label: "LTV", value: pct(ltv) }, { label: "Collateral", value: `${num(coll, 2)} JLP` }, { label: "Debt", value: `${num(debt, 2)} USDC` }, ...(liq ? [{ label: "JLP liq. price", value: usd(liq, 3) }] : [])],
      risk: debt > 0 ? riskFromHealth(health, `LTV ${pct(ltv)} vs ${pct(liqMargin, 0)} liquidation`, { liqPrice: liq || undefined, markPrice: jlpPrice }) : { level: "ok", score: 5 },
      actions: [
        ...(debt > 0 ? [{ id: "loan-repay", label: "Repay USDC", intent: "repay" as const, fields: [{ name: "amount", label: "Amount", kind: "amount" as const, unit: "USDC", max: n(l.maxRepayTokenAmount) / 1e6 || debt }] }] : []),
        { id: "loan-withdraw", label: "Withdraw JLP", intent: "withdraw", fields: [{ name: "amount", label: "Amount", kind: "amount", unit: "JLP", max: n(l.maxWithdrawTokenAmount) / 1e6 }] },
      ],
      url: "https://jup.ag/perps-earn",
      raw: { kind: "loan", positionPubkey: l.positionPubkey, coll, debt },
      updatedAt: Date.now(),
    } satisfies Position;
  });
}

export async function buildLoan(owner: string, pos: Position, actionId: string, params: Record<string, string>): Promise<BuiltAction> {
  const amt = Number(params.amount);
  if (!(amt > 0)) throw new Error("Enter an amount greater than zero.");
  const repay = actionId === "loan-repay";
  const r = await jfetch<{ serializedTxBase64?: string | null; requireKeeperSignature?: boolean }>(`${PERPS}/loans/repay-withdraw`, {
    body: { walletAddress: owner, repayMint: USDC, repayTokenAmount: repay ? toAtomic(params.amount, 6) : "0", withdrawTokenAmount: repay ? "0" : toAtomic(params.amount, 6) },
  });
  if (r.requireKeeperSignature) throw new Error("Jupiter requires its keeper co-signature for this loan action; use jup.ag.");
  if (!r.serializedTxBase64) throw new Error("Jupiter returned no transaction.");
  return { txs: [r.serializedTxBase64], summary: repay ? `Repay ${num(amt, 2)} USDC on your JLP loan.` : `Withdraw ${num(amt, 4)} JLP from your loan collateral.` };
}
