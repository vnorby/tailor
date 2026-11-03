/**
 * Shared Solana plumbing: Helius RPC, wallet balances (DAS), prices (Jupiter),
 * recent activity (Helius enhanced transactions) and transaction helpers that
 * every adapter uses to produce unsigned base64 transactions.
 */
import {
  ComputeBudgetProgram, Connection, PublicKey, TransactionMessage, VersionedTransaction,
  type AddressLookupTableAccount, type TransactionInstruction,
} from "@solana/web3.js";
import type { Activity, Token } from "./types";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const KEY = () => process.env.HELIUS_API_KEY ?? "";
export const rpcUrl = () => process.env.SOLANA_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${KEY()}`;

let conn: Connection | null = null;
export const connection = () => (conn ??= new Connection(rpcUrl(), "confirmed"));

export const isAddress = (s: string) => {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try { new PublicKey(s); return true; } catch { return false; }
};

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const r = await fetch(rpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), cache: "no-store" });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}

// ---------- prices ----------

const priceCache = new Map<string, { usd: number; at: number }>();
const PRICE_TTL = 30_000;

export async function prices(mints: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const need: string[] = [];
  for (const m of new Set(mints)) {
    const c = priceCache.get(m);
    if (c && Date.now() - c.at < PRICE_TTL) out[m] = c.usd; else need.push(m);
  }
  for (let i = 0; i < need.length; i += 50) {
    const ids = need.slice(i, i + 50).join(",");
    try {
      const r = await fetch(`https://api.jup.ag/price/v3?ids=${ids}`, { headers: jupHeaders(), cache: "no-store" });
      if (!r.ok) continue;
      const j = (await r.json()) as Record<string, { usdPrice?: number } | null>;
      for (const [m, v] of Object.entries(j)) if (v?.usdPrice) { out[m] = v.usdPrice; priceCache.set(m, { usd: v.usdPrice, at: Date.now() }); }
    } catch { /* prices are best-effort */ }
  }
  return out;
}

export const jupHeaders = (): Record<string, string> => (process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {});

// ---------- balances ----------

interface DasAsset {
  id: string; interface: string;
  content?: { metadata?: { name?: string; symbol?: string }; links?: { image?: string }; files?: { uri?: string; cdn_uri?: string }[] };
  token_info?: { balance?: number; decimals?: number; symbol?: string; price_info?: { price_per_token?: number; total_price?: number } };
}

/** Fungible balances incl. native SOL, priced; dust (< $0.01 and unpriced zero) dropped. */
export async function walletTokens(owner: string): Promise<Token[]> {
  const tokens = await dasTokens(owner).catch(() => rpcTokens(owner));
  const px = await prices(tokens.map((t) => t.mint));
  for (const t of tokens) {
    t.priceUsd = px[t.mint] ?? t.priceUsd;
    if (t.priceUsd != null) t.valueUsd = t.amount * t.priceUsd;
  }
  return tokens.filter((t) => (t.valueUsd ?? 0) >= 0.01).sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
}

const SOL_ICON = "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png";
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

/** Plain-RPC fallback when DAS isn't available: token accounts + Jupiter token metadata. */
async function rpcTokens(owner: string): Promise<Token[]> {
  const c = connection();
  const pk = new PublicKey(owner);
  const [lamports, ...accts] = await Promise.all([
    c.getBalance(pk),
    ...TOKEN_PROGRAMS.map((p) => c.getParsedTokenAccountsByOwner(pk, { programId: new PublicKey(p) })),
  ]);
  const tokens: Token[] = lamports > 0 ? [{ mint: SOL_MINT, symbol: "SOL", name: "Solana", amount: lamports / 1e9, decimals: 9, icon: SOL_ICON }] : [];
  const byMint = new Map<string, Token>();
  for (const res of accts) for (const a of res.value) {
    const info = (a.account.data as { parsed?: { info?: { mint: string; tokenAmount: { uiAmount: number | null; decimals: number } } } }).parsed?.info;
    if (!info?.tokenAmount.uiAmount) continue;
    const t = byMint.get(info.mint);
    if (t) t.amount += info.tokenAmount.uiAmount;
    else byMint.set(info.mint, { mint: info.mint, symbol: info.mint.slice(0, 4), amount: info.tokenAmount.uiAmount, decimals: info.tokenAmount.decimals });
  }
  const list = [...byMint.values()];
  for (let i = 0; i < list.length; i += 100) {
    try {
      const r = await fetch(`https://api.jup.ag/tokens/v2/search?query=${list.slice(i, i + 100).map((t) => t.mint).join(",")}`, { headers: jupHeaders(), cache: "no-store" });
      if (!r.ok) continue;
      for (const m of (await r.json()) as { id: string; symbol?: string; name?: string; icon?: string }[]) {
        const t = byMint.get(m.id);
        if (t) { t.symbol = m.symbol ?? t.symbol; t.name = m.name; t.icon = m.icon; }
      }
    } catch { /* metadata is cosmetic */ }
  }
  return [...tokens, ...list];
}

async function dasTokens(owner: string): Promise<Token[]> {
  const res = await rpc<{ items: DasAsset[]; nativeBalance?: { lamports: number; price_per_sol?: number } }>("getAssetsByOwner", {
    ownerAddress: owner, page: 1, limit: 1000,
    displayOptions: { showFungible: true, showNativeBalance: true, showZeroBalance: false },
  });
  const tokens: Token[] = [];
  const sol = (res.nativeBalance?.lamports ?? 0) / 1e9;
  if (sol > 0) tokens.push({ mint: SOL_MINT, symbol: "SOL", name: "Solana", amount: sol, decimals: 9, icon: SOL_ICON });
  for (const a of res.items ?? []) {
    if (a.interface !== "FungibleToken" && a.interface !== "FungibleAsset") continue;
    const ti = a.token_info; if (!ti?.balance || ti.decimals == null) continue;
    const amount = ti.balance / 10 ** ti.decimals;
    tokens.push({
      mint: a.id, symbol: ti.symbol || a.content?.metadata?.symbol || a.id.slice(0, 4), name: a.content?.metadata?.name,
      icon: a.content?.files?.[0]?.cdn_uri || a.content?.links?.image, amount, decimals: ti.decimals,
      priceUsd: ti.price_info?.price_per_token,
    });
  }
  return tokens;
}

// ---------- activity ----------

interface EnhancedTx { timestamp: number; type: string; source: string; feePayer: string }

/** What the wallet itself initiated recently, grouped by program source and tx type. */
export async function activity(owner: string): Promise<Activity> {
  const out: Activity = { txCount: 0, bySource: {}, byType: {} };
  let before: string | undefined;
  for (let page = 0; page < 3; page++) {
    const r = await fetch(`https://api.helius.xyz/v0/addresses/${owner}/transactions?api-key=${KEY()}&limit=100${before ? `&before=${before}` : ""}`, { cache: "no-store" });
    if (!r.ok) break;
    const txs = (await r.json()) as (EnhancedTx & { signature: string })[];
    if (!Array.isArray(txs) || !txs.length) break;
    for (const t of txs) {
      if (t.feePayer !== owner) continue;
      out.txCount++;
      out.lastActiveAt = Math.max(out.lastActiveAt ?? 0, t.timestamp * 1000);
      if (t.source && t.source !== "UNKNOWN") out.bySource[t.source] = (out.bySource[t.source] ?? 0) + 1;
      if (t.type && t.type !== "UNKNOWN") out.byType[t.type] = (out.byType[t.type] ?? 0) + 1;
    }
    if (txs.length < 100) break;
    before = txs[txs.length - 1].signature;
  }
  return out;
}

// ---------- transactions ----------

/** Median-ish priority fee for these accounts, in micro-lamports per CU (Helius estimator). */
export async function priorityFee(accountKeys: string[]): Promise<number> {
  try {
    const r = await rpc<{ priorityFeeEstimate?: number }>("getPriorityFeeEstimate", [{ accountKeys: accountKeys.slice(0, 120), options: { priorityLevel: "High" } }]);
    return Math.min(Math.ceil(r.priorityFeeEstimate ?? 50_000), 5_000_000);
  } catch { return 50_000; }
}

/**
 * Wrap legacy-web3 instructions into an unsigned v0 transaction (base64) with a
 * compute budget. Existing compute-budget ixs in `ixs` are kept and ours skipped.
 */
export async function buildTx(payer: string, ixs: TransactionInstruction[], opts: { luts?: AddressLookupTableAccount[]; cuLimit?: number } = {}): Promise<string> {
  const c = connection();
  const hasBudget = ixs.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId));
  const keys = [...new Set(ixs.flatMap((ix) => ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey.toBase58())))];
  const budget = hasBudget ? [] : [
    ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cuLimit ?? 600_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: await priorityFee(keys) }),
  ];
  const { blockhash } = await c.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: blockhash, instructions: [...budget, ...ixs] }).compileToV0Message(opts.luts ?? []);
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
}

export async function lookupTables(addresses: string[]): Promise<AddressLookupTableAccount[]> {
  const c = connection();
  const res = await Promise.all([...new Set(addresses)].map((a) => c.getAddressLookupTable(new PublicKey(a)).then((r) => r.value)));
  return res.filter((x): x is AddressLookupTableAccount => !!x);
}

export interface SimResult { ok: boolean; error?: string; logs?: string[]; unitsConsumed?: number }

/** Simulate an unsigned tx (sigVerify off, fresh blockhash) so users never sign something that fails. */
export async function simulate(base64Tx: string): Promise<SimResult> {
  const r = await rpc<{ value: { err: unknown; logs?: string[]; unitsConsumed?: number } }>("simulateTransaction", [
    base64Tx, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "processed" },
  ]);
  const v = r.value;
  if (!v.err) return { ok: true, unitsConsumed: v.unitsConsumed };
  const logErr = v.logs?.slice().reverse().find((l) => /error|failed|insufficient/i.test(l));
  return { ok: false, error: logErr ?? JSON.stringify(v.err), logs: v.logs?.slice(-12), unitsConsumed: v.unitsConsumed };
}

export async function sendSigned(base64Tx: string): Promise<string> {
  return rpc<string>("sendTransaction", [base64Tx, { encoding: "base64", skipPreflight: true, maxRetries: 5 }]);
}

export async function confirm(signature: string, timeoutMs = 45_000): Promise<{ ok: boolean; error?: string }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await rpc<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }>("getSignatureStatuses", [[signature], { searchTransactionHistory: false }]);
    const s = r.value[0];
    if (s?.err) return { ok: false, error: JSON.stringify(s.err) };
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return { ok: true };
    await new Promise((res) => setTimeout(res, 1500));
  }
  return { ok: false, error: "Timed out waiting for confirmation. Check the explorer before retrying." };
}

// ---------- formatting helpers adapters share ----------

export const usd = (n: number, dp = 2) =>
  `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: Math.abs(n) >= 1000 ? 0 : dp, maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : dp })}`;
export const pct = (n: number, dp = 1) => `${(n * 100).toFixed(dp)}%`;
export const num = (n: number, dp = 4) => n.toLocaleString("en-US", { maximumFractionDigits: dp });

/** Map health (100 safe → 0 liquidatable) to the shared risk shape. */
export function riskFromHealth(healthPct: number, reason: string, extra: { liqPrice?: number; markPrice?: number } = {}) {
  const h = Math.max(0, Math.min(100, healthPct));
  const level = h < 15 ? "danger" : h < 35 ? "watch" : "ok";
  return { level, score: Math.round(100 - h), healthPct: h, reason, ...extra } as const;
}
