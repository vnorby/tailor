/**
 * Kamino Earn vaults (kvaults): share positions (wallet + staked in the vault farm)
 * via the Kamino REST API, withdraw built with klend-sdk's KaminoVaultClient.
 */
import { KaminoVault, KaminoVaultClient, getCurrentLedgerInstant } from "@kamino-finance/klend-sdk";
import Decimal from "decimal.js";
import type { BuiltAction, Position } from "@/lib/core/types";
import { buildTx, lookupTables, num, pct } from "@/lib/core/solana";
import { API, addr, cachedJson, kitRpc, n, signer, slotDurationMs, toWeb3All } from "./common";

interface UserVaultPos { vaultAddress: string; stakedShares: string; unstakedShares: string; totalShares: string }
interface VaultInfo { address: string; state: { name: string; tokenMint: string; tokenMintDecimals: number; sharesMint: string; sharesMintDecimals: number; vaultLookupTable?: string; vaultFarm?: string } }
interface VaultMetrics { apy?: string; apy7d?: string; apy30d?: string; tokenPrice?: string; tokensPerShare?: string; sharePrice?: string }

export interface VaultRaw {
  type: "kvault"; vault: string; name: string; tokenMint: string; tokenDecimals: number; sharesMint: string;
  shares: number; stakedShares: number; tokensPerShare: number; symbol: string; claimsMints: string[]; [k: string]: unknown;
}

export async function vaultPositions(owner: string, symbolOf: (mint: string) => string | undefined): Promise<Position[]> {
  let list: UserVaultPos[];
  try { list = await cachedJson<UserVaultPos[]>(`${API}/kvaults/users/${owner}/positions`, 20_000); }
  catch { return []; }
  list = (list ?? []).filter((p) => Number(p.totalShares) > 0);
  const out = await Promise.all(list.map(async (p): Promise<Position | null> => {
    try {
      const [info, m] = await Promise.all([
        cachedJson<VaultInfo>(`${API}/kvaults/vaults/${p.vaultAddress}`, 30 * 60_000),
        cachedJson<VaultMetrics>(`${API}/kvaults/vaults/${p.vaultAddress}/metrics`, 60_000),
      ]);
      const st = info.state;
      const shares = Number(p.totalShares), staked = Number(p.stakedShares);
      const tps = Number(m.tokensPerShare ?? 0), price = Number(m.tokenPrice ?? 0);
      const tokens = shares * tps;
      const valueUsd = tokens * price;
      if (valueUsd < 0.01) return null;
      const apy = Number(m.apy ?? 0);
      const symbol = symbolOf(st.tokenMint) ?? (st.name.split(" ").pop() || "token");
      const raw: VaultRaw = {
        type: "kvault", vault: p.vaultAddress, name: st.name, tokenMint: st.tokenMint, tokenDecimals: st.tokenMintDecimals, sharesMint: st.sharesMint,
        shares, stakedShares: staked, tokensPerShare: tps, symbol, claimsMints: [st.sharesMint],
      };
      return {
        id: `kamino:${p.vaultAddress}`,
        protocol: "kamino", kind: "vault",
        title: `${st.name} Vault`,
        subtitle: `Kamino Earn · ${num(tokens, 4)} ${symbol}`,
        valueUsd,
        legs: [{ side: "supply", symbol, mint: st.tokenMint, amount: tokens, valueUsd, apy }],
        metrics: [
          { label: "APY", value: pct(apy, 2), tone: "pos" },
          ...(m.apy30d ? [{ label: "30d APY", value: pct(Number(m.apy30d), 2) }] : []),
          { label: "Balance", value: `${num(tokens, 4)} ${symbol}` },
          ...(staked > 0 ? [{ label: "Staked shares", value: `${pct(staked / shares, 0)}`, tone: "muted" as const }] : []),
        ],
        risk: { level: "ok", score: Math.min(15, Math.round(Math.log10(Math.max(valueUsd, 1)) * 2)) },
        actions: [{
          id: "withdraw", label: "Withdraw", intent: "withdraw",
          fields: [{ name: "amount", label: `Amount (${symbol})`, kind: "amount", unit: symbol, max: tokens }],
        }, { id: "withdraw-all", label: "Withdraw all", intent: "withdraw" }],
        url: `https://kamino.com/lend/${p.vaultAddress}`,
        raw, updatedAt: Date.now(),
      };
    } catch { return null; }
  }));
  return out.filter((x): x is Position => !!x);
}

export async function buildVault(owner: string, position: Position, actionId: string, params: Record<string, string>): Promise<BuiltAction> {
  const raw = position.raw as VaultRaw;
  if (raw?.type !== "kvault") throw new Error("Not a Kamino vault position.");
  const rpc = kitRpc();
  const ms = await slotDurationMs();
  const client = new KaminoVaultClient(rpc, ms);
  const vault = new KaminoVault(rpc, addr(raw.vault), ms);
  const [state, li] = await Promise.all([vault.getState(), getCurrentLedgerInstant(rpc)]);
  const [reserves, farmState] = await Promise.all([client.loadVaultReserves(state), client.loadVaultFarmState(state)]);

  const all = actionId === "withdraw-all" || !params.amount || Number(params.amount) >= raw.shares * raw.tokensPerShare * 0.9999;
  let shares: Decimal;
  if (all) shares = new Decimal(raw.shares).mul(2).add(1); // "any value > user share amount" = everything
  else {
    const ui = Number(params.amount);
    if (!(ui > 0)) throw new Error("Enter an amount greater than zero.");
    const tps = n(await client.getTokensPerShareSingleVault(state, li, reserves, li)) || raw.tokensPerShare;
    shares = new Decimal(ui).div(tps).toDecimalPlaces(9, Decimal.ROUND_DOWN);
  }
  const w = await client.withdrawIxs(signer(owner), vault, shares, li, reserves, farmState, null);
  const ixs = [...w.unstakeFromFarmIfNeededIxs, ...w.withdrawIxs, ...w.postWithdrawIxs, ...(w.memoIx ? [w.memoIx] : [])];
  if (!ixs.length) throw new Error("Nothing to withdraw.");
  const lutAddrs = [state.vaultLookupTable as string].filter((a) => a && a !== "11111111111111111111111111111111");
  const luts = await lookupTables(lutAddrs);
  try {
    const tx = await buildTx(owner, toWeb3All(ixs), { luts, cuLimit: 1_200_000 });
    return { txs: [tx], summary: all ? `Withdraw your full ${raw.name} vault balance (~${num(raw.shares * raw.tokensPerShare, 4)} ${raw.symbol}) to your wallet.` : `Withdraw ${params.amount} ${raw.symbol} from the ${raw.name} vault.` };
  } catch {
    // Too big for one tx (several reserves): unstake first, then one tx per withdraw ix.
    const txs: string[] = [];
    if (w.unstakeFromFarmIfNeededIxs.length) txs.push(await buildTx(owner, toWeb3All(w.unstakeFromFarmIfNeededIxs), { luts }));
    const groups = w.withdrawIxs.map((ix, i) => [ix, ...(i === w.withdrawIxs.length - 1 ? w.postWithdrawIxs : []), ...(w.memoIx ? [w.memoIx] : [])]);
    for (const g of groups) txs.push(await buildTx(owner, toWeb3All(g), { luts, cuLimit: 1_200_000 }));
    return { txs, summary: `Withdraw ${all ? "your full balance" : `${params.amount} ${raw.symbol}`} from the ${raw.name} vault (${txs.length} transactions).`, warnings: [`Sign all ${txs.length} transactions in order.`] };
  }
}

