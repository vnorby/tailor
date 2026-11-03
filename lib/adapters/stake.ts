/**
 * Staking: native stake accounts (protocol "stake") and liquid staking tokens
 * (protocol "lst"). Native accounts come from getProgramAccounts on the Stake
 * program filtered by staker/withdrawer; validator names + APY from Stakewiz.
 * LSTs are matched against Sanctum's LST registry; APY + SOL value from Sanctum.
 *
 * Actions: deactivate / withdraw stake accounts; "unstake to SOL" for LSTs (best
 * swap across Jupiter/Titan/DFlow). Tools: stake-sol (SOL → LST via swap) and
 * stake-native (create + delegate a seed-derived stake account, owner signs only).
 */
import { Authorized, Lockup, PublicKey, StakeProgram, type ParsedAccountData } from "@solana/web3.js";
import type { Action, Adapter, BuiltAction, Ctx, Position, ToolDef } from "@/lib/core/types";
import { buildTx, num, pct, SOL_MINT, usd } from "@/lib/core/solana";
import { bestQuote } from "./swap";

const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";
const SANCTUM = "https://extra-api.sanctum.so";
const DEFAULT_VOTE = "he1iusunGwqrNtafDtLdhsUQDFvo13z9sUa36PauBtk"; // Helius, 0% commission

// ---------- small fetch helpers with in-memory caches ----------

const timeout = (ms: number) => AbortSignal.timeout(ms);
async function json<T>(url: string, ms = 4000): Promise<T | null> {
  try { const r = await fetch(url, { signal: timeout(ms), cache: "no-store" }); return r.ok ? ((await r.json()) as T) : null; } catch { return null; }
}

interface ValidatorInfo { name?: string; apy?: number; commission?: number; delinquent?: boolean }
const validatorCache = new Map<string, { v: ValidatorInfo; at: number }>();
async function validatorInfo(vote: string): Promise<ValidatorInfo> {
  const c = validatorCache.get(vote);
  if (c && Date.now() - c.at < 3_600_000) return c.v;
  const j = await json<{ name?: string; total_apy?: number; staking_apy?: number; commission?: number; delinquent?: boolean }>(`https://api.stakewiz.com/validator/${vote}`, 3000);
  const v: ValidatorInfo = j ? { name: j.name || undefined, apy: (j.total_apy ?? j.staking_apy) != null ? Number(j.total_apy ?? j.staking_apy) / 100 : undefined, commission: j.commission, delinquent: j.delinquent } : {};
  if (j) validatorCache.set(vote, { v, at: Date.now() });
  return v;
}

interface Lst { mint: string; symbol: string; name: string; decimals: number; logo?: string }
// Fallback if Sanctum's registry is unreachable.
const MAJOR_LSTS: Lst[] = [
  { mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", symbol: "JitoSOL", name: "Jito Staked SOL", decimals: 9 },
  { mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", symbol: "mSOL", name: "Marinade staked SOL", decimals: 9 },
  { mint: "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm", symbol: "INF", name: "Infinity", decimals: 9 },
  { mint: "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v", symbol: "JupSOL", name: "Jupiter Staked SOL", decimals: 9 },
  { mint: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1", symbol: "bSOL", name: "BlazeStake Staked SOL", decimals: 9 },
  { mint: "he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A", symbol: "hSOL", name: "Helius Staked SOL", decimals: 9 },
  { mint: "BNso1VUJnh4zcfpZa6986Ea66P6TCp59hvtNJ8b1X85", symbol: "BNSOL", name: "Binance Staked SOL", decimals: 9 },
  { mint: "Dso1bDeDjCQxTrWHqUUi63oBvV7Mdm6WaobLbQ7gnPQ", symbol: "dSOL", name: "Drift Staked SOL", decimals: 9 },
  { mint: "vSoLxydx6akxyMD9XEcPvGYNGq6Nn66oqVb3UkGkei7", symbol: "vSOL", name: "The Vault", decimals: 9 },
  { mint: "Bybit2vBJGhPF52GBdNaQfUJ6ZpThSgHBobjWZpLPb4B", symbol: "bbSOL", name: "Bybit Staked SOL", decimals: 9 },
  { mint: "picobAEvs6w7QEknPce34wAE4gknZA9v5tTonnmHYdX", symbol: "picoSOL", name: "picoSOL", decimals: 9 },
];
let lstCache: { list: Lst[]; at: number } | null = null;
async function lstRegistry(): Promise<Lst[]> {
  if (lstCache && Date.now() - lstCache.at < 6 * 3_600_000) return lstCache.list;
  const j = await json<{ lsts: { mint: string; symbol: string; name: string; decimals: number; logo_uri?: string }[] }>(`${SANCTUM}/v1/lsts`, 5000);
  const list = j?.lsts?.length
    ? j.lsts.filter((l) => l.mint !== SOL_MINT && l.symbol !== "wSOL").map((l) => ({ mint: l.mint, symbol: l.symbol, name: l.name, decimals: l.decimals, logo: l.logo_uri }))
    : MAJOR_LSTS;
  for (const m of MAJOR_LSTS) if (!list.some((l) => l.mint === m.mint)) list.push(m);
  lstCache = { list, at: Date.now() };
  return list;
}

async function lstApys(mints: string[]): Promise<Record<string, number>> {
  if (!mints.length) return {};
  const qs = mints.map((m) => `lst=${m}`).join("&");
  const latest = await json<{ apys: Record<string, number> }>(`${SANCTUM}/v1/apy/latest?${qs}`);
  const out: Record<string, number> = {};
  const missing: string[] = [];
  for (const m of mints) { const a = latest?.apys?.[m]; if (a && a > 0) out[m] = a; else missing.push(m); }
  if (missing.length) { // "latest" is sometimes 0 between epochs; fall back to since-inception APY
    const inc = await json<{ apys: Record<string, number> }>(`${SANCTUM}/v1/apy/inception?${missing.map((m) => `lst=${m}`).join("&")}`);
    for (const m of missing) { const a = inc?.apys?.[m]; if (a && a > 0) out[m] = a; }
  }
  return out;
}

async function lstSolValues(mints: string[]): Promise<Record<string, number>> {
  if (!mints.length) return {};
  const j = await json<{ solValues: Record<string, string> }>(`${SANCTUM}/v1/sol-value/current?${mints.map((m) => `lst=${m}`).join("&")}`);
  const out: Record<string, number> = {};
  for (const [m, v] of Object.entries(j?.solValues ?? {})) out[m] = Number(v) / 1e9;
  return out;
}

// ---------- native stake accounts ----------

interface ParsedStake {
  type: "initialized" | "delegated" | "uninitialized" | "rewardsPool";
  info: {
    meta: { rentExemptReserve: string; authorized: { staker: string; withdrawer: string }; lockup: { unixTimestamp: number; epoch: number; custodian: string } };
    stake?: { delegation: { voter: string; stake: string; activationEpoch: string; deactivationEpoch: string } };
  };
}
type StakeStatus = "activating" | "active" | "deactivating" | "inactive";

async function nativeStakes(owner: string, ctx: Ctx): Promise<Position[]> {
  const c = ctx.connection;
  const prog = new PublicKey(STAKE_PROGRAM);
  const q = (offset: number) => c.getParsedProgramAccounts(prog, { filters: [{ dataSize: 200 }, { memcmp: { offset, bytes: owner } }] }).catch(() => []);
  const [asStaker, asWithdrawer, epochInfo] = await Promise.all([q(12), q(44), c.getEpochInfo()]);
  const seen = new Map<string, (typeof asStaker)[number]>();
  for (const a of [...asStaker, ...asWithdrawer]) seen.set(a.pubkey.toBase58(), a);
  if (!seen.size) return [];
  const epoch = epochInfo.epoch;
  const solPx = (await ctx.prices([SOL_MINT]))[SOL_MINT] ?? ctx.tokens.find((t) => t.mint === SOL_MINT)?.priceUsd ?? 0;
  const votes = [...new Set([...seen.values()].map((a) => ((a.account.data as ParsedAccountData).parsed as ParsedStake).info?.stake?.delegation.voter).filter(Boolean))] as string[];
  const infos = Object.fromEntries(await Promise.all(votes.slice(0, 12).map(async (v) => [v, await validatorInfo(v)] as const)));
  const nowSec = Math.floor(Date.now() / 1000);
  const out: Position[] = [];

  for (const [pubkey, a] of seen) {
    const parsed = (a.account.data as ParsedAccountData).parsed as ParsedStake;
    if (!parsed?.info?.meta) continue;
    const { meta, stake } = parsed.info;
    const lamports = a.account.lamports;
    const sol = lamports / 1e9;
    const d = stake?.delegation;
    const U64_MAX = "18446744073709551615";
    let status: StakeStatus = "inactive";
    if (parsed.type === "delegated" && d) {
      const act = Number(d.activationEpoch);
      const deact = d.deactivationEpoch === U64_MAX ? Infinity : Number(d.deactivationEpoch);
      if (deact < epoch) status = "inactive";
      else if (deact === epoch) status = "deactivating";
      else if (act >= epoch) status = "activating";
      else status = "active";
    }
    const vote = d?.voter;
    const vi = vote ? infos[vote] ?? {} : {};
    const isStaker = meta.authorized.staker === owner;
    const isWithdrawer = meta.authorized.withdrawer === owner;
    const lockedUp = (meta.lockup.unixTimestamp > nowSec || meta.lockup.epoch > epoch) && meta.lockup.custodian !== owner;
    const delegated = d ? Number(d.stake) / 1e9 : 0;
    const apy = status === "active" || status === "activating" ? vi.apy : undefined;

    const actions: Action[] = [];
    if ((status === "active" || status === "activating") && isStaker) actions.push({ id: "deactivate", label: "Unstake (deactivate)", intent: "unstake", danger: true });
    if (status === "inactive" && isWithdrawer && !lockedUp) actions.push({
      id: "withdraw", label: "Withdraw SOL", intent: "withdraw",
      fields: [{ name: "amount", label: "Amount", kind: "amount", unit: "SOL", max: sol, default: String(sol) }],
    });

    const valName = vi.name ?? (vote ? `${vote.slice(0, 4)}…${vote.slice(-4)}` : "Undelegated");
    out.push({
      id: `stake:${pubkey}`,
      protocol: "stake", kind: "stake",
      title: status === "inactive" ? `${num(sol, 3)} SOL stake account` : `${num(sol, 3)} SOL staked`,
      subtitle: `${valName} · ${status}`,
      valueUsd: sol * solPx,
      legs: [{ side: "stake", symbol: "SOL", mint: SOL_MINT, amount: sol, valueUsd: sol * solPx, apy }],
      metrics: [
        { label: "Status", value: status, tone: status === "active" ? "pos" : status === "inactive" ? "warn" : "muted" },
        { label: "Validator", value: valName, tone: vi.delinquent ? "neg" : undefined },
        ...(apy != null ? [{ label: "APY", value: pct(apy, 2), tone: "pos" as const }] : []),
        ...(status !== "inactive" && delegated && Math.abs(delegated - sol) > 0.001 ? [{ label: "Delegated", value: `${num(delegated, 3)} SOL` }] : []),
        ...(lockedUp ? [{ label: "Lockup", value: meta.lockup.unixTimestamp > nowSec ? new Date(meta.lockup.unixTimestamp * 1000).toISOString().slice(0, 10) : `epoch ${meta.lockup.epoch}`, tone: "warn" as const }] : []),
      ],
      risk: status === "inactive" && sol < 0.01
        ? { level: "ok", score: 2, reason: "Empty stake account — withdraw to reclaim the rent" }
        : status === "inactive"
        ? { level: "watch", score: 45, reason: lockedUp ? "Inactive but locked up" : "Inactive stake earns nothing — withdraw or re-delegate" }
        : status === "deactivating" ? { level: "ok", score: 20, reason: "Unstaking; withdrawable next epoch" }
        : vi.delinquent ? { level: "watch", score: 50, reason: `Validator ${valName} is delinquent — not earning rewards` }
        : { level: "ok", score: 5 },
      actions,
      url: `https://solscan.io/account/${pubkey}`,
      raw: { stakeAccount: pubkey, status, vote: vote ?? null, lamports, staker: meta.authorized.staker, withdrawer: meta.authorized.withdrawer, lockedUp },
      updatedAt: Date.now(),
    });
  }
  return out;
}

// ---------- LSTs ----------

async function lstPositions(ctx: Ctx): Promise<Position[]> {
  const reg = await lstRegistry();
  const byMint = new Map(reg.map((l) => [l.mint, l]));
  const held = ctx.tokens.filter((t) => byMint.has(t.mint) && t.amount > 0);
  if (!held.length) return [];
  const mints = held.map((t) => t.mint);
  const [apys, solValues, px] = await Promise.all([lstApys(mints), lstSolValues(mints), ctx.prices([SOL_MINT, ...mints.filter((m) => !held.find((t) => t.mint === m)?.priceUsd)])]);
  const solPx = px[SOL_MINT] ?? ctx.tokens.find((t) => t.mint === SOL_MINT)?.priceUsd ?? 0;
  return held.map((t) => {
    const l = byMint.get(t.mint)!;
    const sv = solValues[t.mint];
    const price = t.priceUsd ?? px[t.mint] ?? (sv && solPx ? sv * solPx : 0);
    const value = t.valueUsd ?? t.amount * price;
    const apy = apys[t.mint];
    const solEq = sv ? t.amount * sv : solPx ? value / solPx : undefined;
    return {
      id: `lst:${t.mint}`,
      protocol: "lst", kind: "vault",
      title: `${l.symbol}`,
      subtitle: l.name,
      valueUsd: value,
      legs: [{ side: "stake", symbol: l.symbol, mint: t.mint, amount: t.amount, valueUsd: value, apy }],
      metrics: [
        { label: "Balance", value: `${num(t.amount, 4)} ${l.symbol}` },
        ...(solEq != null ? [{ label: "Worth", value: `${num(solEq, 4)} SOL` }] : []),
        ...(apy != null ? [{ label: "APY", value: pct(apy, 2), tone: "pos" as const }] : []),
        ...(sv ? [{ label: "Rate", value: `1 ${l.symbol} = ${sv.toFixed(4)} SOL` }] : []),
      ],
      risk: { level: "ok", score: Math.min(20, Math.round(value / 5000)) },
      actions: [{
        id: "unstake", label: "Unstake to SOL", intent: "unstake",
        fields: [{ name: "amount", label: "Amount", kind: "amount", unit: l.symbol, max: t.amount, default: String(t.amount) }, { name: "slippage", label: "Slippage %", kind: "percent", default: "0.5" }],
      }],
      url: `https://app.sanctum.so/trade/${l.symbol}-SOL`,
      raw: { mint: t.mint, symbol: l.symbol, decimals: t.decimals, amount: t.amount, solValue: sv ?? null, claimsMints: [t.mint] },
      updatedAt: Date.now(),
    } satisfies Position;
  });
}

// ---------- tools ----------

const STAKE_LST_OPTIONS = [
  { value: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", label: "JitoSOL" },
  { value: "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v", label: "JupSOL" },
  { value: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", label: "mSOL" },
  { value: "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm", label: "INF" },
  { value: "he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A", label: "hSOL" },
  { value: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1", label: "bSOL" },
  { value: "BNso1VUJnh4zcfpZa6986Ea66P6TCp59hvtNJ8b1X85", label: "BNSOL" },
];

const tools: ToolDef[] = [
  {
    id: "stake-sol", protocol: "lst", label: "Stake SOL",
    description: "Liquid-stake SOL into an LST (JitoSOL, JupSOL, mSOL, INF…) by swapping at the best rate; stays liquid and earns staking yield.",
    fields: [
      { name: "amount", label: "Amount", kind: "amount", unit: "SOL" },
      { name: "lst", label: "Into", kind: "select", default: STAKE_LST_OPTIONS[0].value, options: STAKE_LST_OPTIONS },
      { name: "slippage", label: "Slippage %", kind: "percent", default: "0.5" },
    ],
  },
  {
    id: "stake-native", protocol: "stake", label: "Stake to a validator",
    description: "Create a native stake account and delegate SOL to a validator (vote account). Minimum 1 SOL; unstaking takes ~1 epoch.",
    fields: [
      { name: "amount", label: "Amount", kind: "amount", unit: "SOL" },
      { name: "vote", label: "Validator vote account", kind: "text", default: DEFAULT_VOTE },
    ],
  },
];

async function swapFor(owner: string, from: { mint: string; symbol: string; decimals: number }, to: { mint: string; symbol: string; decimals: number }, amount: string, slippage: string, ctx: Ctx, verb: string): Promise<BuiltAction> {
  // bestQuote resolves mints via ctx.tokens; make sure both sides are resolvable even if not held.
  const tokens = [...ctx.tokens];
  for (const t of [from, to]) if (!tokens.some((x) => x.mint === t.mint)) tokens.push({ mint: t.mint, symbol: t.symbol, decimals: t.decimals, amount: 0 });
  const { best, all } = await bestQuote(owner, { from: from.mint, to: to.mint, amount, slippage }, { ...ctx, tokens });
  const out = Number(best.outAmount) / 10 ** to.decimals;
  const others = all.slice(1).map((q) => `${q.provider} ${num(Number(q.outAmount) / 10 ** to.decimals)}`).join(", ");
  return {
    txs: [await best.build()],
    summary: `${verb} ${amount} ${from.symbol} → ~${num(out, 4)} ${to.symbol} via ${best.provider}${best.route ? ` (${best.route})` : ""}.`,
    warnings: [
      ...(best.priceImpactPct && best.priceImpactPct > 1 ? [`Price impact ${best.priceImpactPct.toFixed(2)}%.`] : []),
      ...(others ? [`Other quotes: ${others}.`] : []),
    ],
  };
}

// ---------- adapter ----------

export const stakeAdapter: Adapter = {
  protocol: "stake",
  name: "Staking",

  async positions(owner, ctx) {
    const [a, b] = await Promise.all([nativeStakes(owner, ctx).catch(() => []), lstPositions(ctx).catch(() => [])]);
    return [...a, ...b];
  },

  async build(owner, position, actionId, params, ctx): Promise<BuiltAction> {
    const raw = position.raw as Record<string, unknown>;
    const ownerPk = new PublicKey(owner);
    if (actionId === "deactivate") {
      const stakePubkey = new PublicKey(raw.stakeAccount as string);
      const tx = StakeProgram.deactivate({ stakePubkey, authorizedPubkey: ownerPk });
      return { txs: [await buildTx(owner, tx.instructions, { cuLimit: 50_000 })], summary: `Deactivate stake account ${String(raw.stakeAccount).slice(0, 4)}… — SOL becomes withdrawable after the current epoch ends (~2 days max).` };
    }
    if (actionId === "withdraw") {
      const stakePubkey = new PublicKey(raw.stakeAccount as string);
      const total = Number(raw.lamports);
      const want = params.amount ? Math.floor(Number(params.amount) * 1e9) : total;
      if (!(want > 0)) throw new Error("Enter an amount greater than zero.");
      const lamports = Math.min(total, want);
      const tx = StakeProgram.withdraw({ stakePubkey, authorizedPubkey: ownerPk, toPubkey: ownerPk, lamports });
      return { txs: [await buildTx(owner, tx.instructions, { cuLimit: 50_000 })], summary: `Withdraw ${num(lamports / 1e9, 4)} SOL from stake account ${String(raw.stakeAccount).slice(0, 4)}… to your wallet${lamports === total ? " (closes the account)" : ""}.` };
    }
    if (actionId === "unstake") {
      const amount = params.amount || String(raw.amount);
      return swapFor(owner, { mint: raw.mint as string, symbol: raw.symbol as string, decimals: Number(raw.decimals ?? 9) }, { mint: SOL_MINT, symbol: "SOL", decimals: 9 }, amount, params.slippage ?? "0.5", ctx, "Unstake");
    }
    throw new Error(`Unknown staking action ${actionId}`);
  },

  tools,

  async buildTool(owner, toolId, params, ctx): Promise<BuiltAction> {
    const amt = Number(params.amount);
    if (!(amt > 0)) throw new Error("Enter an amount greater than zero.");
    if (toolId === "stake-sol") {
      const mint = params.lst || STAKE_LST_OPTIONS[0].value;
      const l = (await lstRegistry()).find((x) => x.mint === mint || x.symbol.toLowerCase() === mint.toLowerCase());
      if (!l) throw new Error(`Unknown LST ${mint}`);
      return swapFor(owner, { mint: SOL_MINT, symbol: "SOL", decimals: 9 }, { mint: l.mint, symbol: l.symbol, decimals: l.decimals }, String(amt), params.slippage ?? "0.5", ctx, "Stake");
    }
    if (toolId === "stake-native") {
      const minLamports = await ctx.connection.getStakeMinimumDelegation().then((r) => r.value).catch(() => 1e9);
      if (amt * 1e9 < minLamports) throw new Error(`Native staking needs at least ${minLamports / 1e9} SOL; use liquid staking (stake-sol) for smaller amounts.`);
      const vote = new PublicKey(params.vote || DEFAULT_VOTE);
      const ownerPk = new PublicKey(owner);
      const rent = await ctx.connection.getMinimumBalanceForRentExemption(StakeProgram.space);
      const lamports = Math.floor(amt * 1e9) + rent;
      const seed = `tailor:${Date.now().toString(36)}`;
      const stakePubkey = await PublicKey.createWithSeed(ownerPk, seed, StakeProgram.programId);
      const create = StakeProgram.createAccountWithSeed({
        fromPubkey: ownerPk, stakePubkey, basePubkey: ownerPk, seed, lamports,
        authorized: new Authorized(ownerPk, ownerPk), lockup: new Lockup(0, 0, PublicKey.default),
      });
      const delegate = StakeProgram.delegate({ stakePubkey, authorizedPubkey: ownerPk, votePubkey: vote });
      const vi = await validatorInfo(vote.toBase58());
      return {
        txs: [await buildTx(owner, [...create.instructions, ...delegate.instructions], { cuLimit: 60_000 })],
        summary: `Stake ${num(amt, 4)} SOL with ${vi.name ?? vote.toBase58().slice(0, 6) + "…"} (new stake account ${stakePubkey.toBase58().slice(0, 4)}…, activates next epoch).`,
        warnings: [`Adds ${num(rent / 1e9, 5)} SOL rent reserve, returned when you withdraw.`, ...(vi.delinquent ? ["This validator is currently delinquent."] : [])],
      };
    }
    throw new Error(`Unknown tool ${toolId}`);
  },
};
