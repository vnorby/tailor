/**
 * Kamino Liquidity (kliquidity) automated LP strategies: share tokens held in the
 * wallet, valued via the Kamino REST API; withdraw-all via kliquidity-sdk.
 */
import { PublicKey } from "@solana/web3.js";
import type { BuiltAction, Ctx, Position } from "@/lib/core/types";
import { buildTx, lookupTables, num, pct } from "@/lib/core/solana";
import { API, addr, cachedJson, kitRpc, signer, toWeb3All } from "./common";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

interface StrategyRow { address: string; shareMint: string; status: string; tokenAMint: string; tokenBMint: string }
interface StrategyMetrics {
  tokenA: string; tokenB: string; sharePrice: string;
  apy?: { totalApy?: string; vault?: { strategyOutOfRange?: boolean; priceLower?: string; priceUpper?: string; poolPrice?: string } };
  kaminoApy?: { vault?: { apy7d?: string } };
}

export interface LiqRaw { type: "kliquidity"; strategy: string; shareMint: string; shares: number; pair: string; claimsMints: string[]; [k: string]: unknown }

export async function liquidityPositions(owner: string, ctx: Ctx): Promise<Position[]> {
  let strategies: StrategyRow[];
  try { strategies = await cachedJson<StrategyRow[]>(`${API}/strategies?status=LIVE`, 30 * 60_000); } catch { return []; }
  const byShare = new Map(strategies.map((s) => [s.shareMint, s]));
  const accts = await ctx.connection.getParsedTokenAccountsByOwner(new PublicKey(owner), { programId: TOKEN_PROGRAM });
  const held = new Map<string, number>();
  for (const a of accts.value) {
    const info = (a.account.data as { parsed?: { info?: { mint: string; tokenAmount?: { uiAmount: number | null } } } }).parsed?.info;
    if (!info || !byShare.has(info.mint)) continue;
    const amt = info.tokenAmount?.uiAmount ?? 0;
    if (amt > 0) held.set(info.mint, (held.get(info.mint) ?? 0) + amt);
  }
  if (!held.size) return [];
  const out = await Promise.all([...held].map(async ([mint, shares]): Promise<Position | null> => {
    const s = byShare.get(mint)!;
    try {
      const m = await cachedJson<StrategyMetrics>(`${API}/strategies/${s.address}/metrics?env=mainnet-beta`, 60_000);
      const valueUsd = shares * Number(m.sharePrice);
      if (!(valueUsd >= 0.01)) return null;
      const apy = Number(m.apy?.totalApy ?? m.kaminoApy?.vault?.apy7d ?? 0);
      const oor = !!m.apy?.vault?.strategyOutOfRange;
      const pair = `${m.tokenA}/${m.tokenB}`;
      const raw: LiqRaw = { type: "kliquidity", strategy: s.address, shareMint: mint, shares, pair, claimsMints: [mint] };
      return {
        id: `kamino:${s.address}`,
        protocol: "kamino", kind: "lp",
        title: `${pair} Liquidity`,
        subtitle: `Kamino automated LP${oor ? " · out of range" : ""}`,
        valueUsd,
        legs: [{ side: "lp", symbol: pair, mint, amount: shares, valueUsd, apy }],
        metrics: [
          { label: "APY", value: pct(apy, 2), tone: "pos" },
          { label: "Shares", value: num(shares, 4), tone: "muted" },
          ...(oor ? [{ label: "Range", value: "Out of range", tone: "warn" as const }] : []),
        ],
        risk: oor ? { level: "watch", score: 40, reason: "Strategy is out of range — not earning fees until it rebalances" } : { level: "ok", score: Math.min(15, Math.round(Math.log10(Math.max(valueUsd, 1)) * 2)) },
        actions: [{ id: "withdraw-all", label: "Withdraw all", intent: "withdraw" }],
        url: `https://kamino.com/liquidity/${s.address}`,
        raw, updatedAt: Date.now(),
      };
    } catch { return null; }
  }));
  return out.filter((x): x is Position => !!x);
}

export async function buildLiquidity(owner: string, position: Position): Promise<BuiltAction> {
  const raw = position.raw as LiqRaw;
  if (raw?.type !== "kliquidity") throw new Error("Not a Kamino liquidity position.");
  // Lazy: kliquidity-sdk pulls in @orca-so/whirlpools-client, which may be missing; keep reads working regardless.
  let Kamino: typeof import("@kamino-finance/kliquidity-sdk").Kamino;
  try { ({ Kamino } = await import("@kamino-finance/kliquidity-sdk")); }
  catch (e) { throw new Error(`Kamino Liquidity withdrawals are unavailable on this server (${e instanceof Error ? e.message.split("\n")[0] : e}). Withdraw at kamino.com.`); }
  const kamino = new Kamino("mainnet-beta", kitRpc());
  const w = await kamino.withdrawAllShares(addr(raw.strategy), signer(owner));
  if (!w) throw new Error("No strategy shares found in this wallet.");
  const ixs = [...w.prerequisiteIxs, w.withdrawIx, ...(w.closeSharesAtaIx ? [w.closeSharesAtaIx] : [])];
  const luts = await lookupTables(((await kamino.getMainLookupTablePks().catch(() => [])) as string[]));
  const tx = await buildTx(owner, toWeb3All(ixs), { luts, cuLimit: 800_000 });
  return { txs: [tx], summary: `Withdraw all ${num(raw.shares, 4)} ${raw.pair} strategy shares back into the two underlying tokens.` };
}
