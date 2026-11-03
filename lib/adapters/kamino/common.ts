/**
 * Shared Kamino plumbing: @solana/kit RPC for the SDKs, kit → web3.js instruction
 * conversion (so we can reuse buildTx), cached REST metadata and formatting bits.
 */
import { PublicKey, TransactionInstruction, type Connection } from "@solana/web3.js";
import { address, createNoopSigner, createSolanaRpc, type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import { SOL_MINT, rpcUrl } from "@/lib/core/solana";

export const API = "https://api.kamino.finance";
export const KLEND_PROGRAM = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
export const MAIN_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";

// The SDKs are typed against their own nested copies of @solana/kit; at runtime they are the same shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRpc = any;

let _rpc: { url: string; rpc: AnyRpc } | null = null;
export function kitRpc(): AnyRpc {
  const url = rpcUrl();
  if (!_rpc || _rpc.url !== url) _rpc = { url, rpc: createSolanaRpc(url) };
  return _rpc.rpc;
}

/** No-op signer (we never sign); typed loosely because each SDK bundles its own @solana/signers. */
export const signer = (owner: string): AnyRpc => createNoopSigner(address(owner)) as TransactionSigner;
export const addr = (s: string): Address => address(s);

/** kit Instruction → web3.js TransactionInstruction (role bit 0 = writable, bit 1 = signer). */
export function toWeb3(ix: Instruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: (ix.accounts ?? []).map((a) => ({ pubkey: new PublicKey(a.address), isWritable: (a.role & 1) === 1, isSigner: (a.role & 2) === 2 })),
    data: Buffer.from(ix.data ?? new Uint8Array()),
  });
}
export const toWeb3All = (ixs: readonly Instruction[]) => ixs.map(toWeb3);

/** web3.js TransactionInstruction → kit Instruction (for SDK params like budgetAndPriorityFeeIxs). */
export function fromWeb3(ix: TransactionInstruction): Instruction {
  return {
    programAddress: address(ix.programId.toBase58()),
    accounts: ix.keys.map((k) => ({ address: address(k.pubkey.toBase58()), role: (k.isSigner ? 2 : 0) | (k.isWritable ? 1 : 0) })),
    data: new Uint8Array(ix.data),
  } as Instruction;
}

/** Owner's balance of a mint in UI units (native SOL + wSOL for the SOL mint). */
export async function walletBalance(connection: Connection, owner: string, mint: string): Promise<number> {
  const o = new PublicKey(owner);
  const res = await connection.getParsedTokenAccountsByOwner(o, { mint: new PublicKey(mint) });
  let bal = res.value.reduce((t, a) => t + ((a.account.data as { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } }).parsed?.info?.tokenAmount?.uiAmount ?? 0), 0);
  if (mint === SOL_MINT) bal += Math.max(0, (await connection.getBalance(o)) / 1e9 - 0.01); // keep ~0.01 SOL for fees/rent
  return bal;
}

// ---------- cached REST metadata ----------

const cache = new Map<string, { at: number; v: unknown }>();
export async function cachedJson<T>(url: string, ttlMs: number, timeoutMs = 6000): Promise<T> {
  const c = cache.get(url);
  if (c && Date.now() - c.at < ttlMs) return c.v as T;
  const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`Kamino API ${r.status} for ${url.replace(API, "")}`);
  const v = (await r.json()) as T;
  cache.set(url, { at: Date.now(), v });
  return v;
}

export interface MarketMeta { lendingMarket: string; name: string; lookupTable?: string; isPrimary?: boolean }
export async function marketsMeta(): Promise<Map<string, MarketMeta>> {
  try {
    const list = await cachedJson<MarketMeta[]>(`${API}/v2/kamino-market`, 30 * 60_000);
    return new Map(list.map((m) => [m.lendingMarket, m]));
  } catch { return new Map(); }
}

let slotMs: { at: number; v: number } | null = null;
export async function slotDurationMs(): Promise<number> {
  if (slotMs && Date.now() - slotMs.at < 60 * 60_000) return slotMs.v;
  try {
    const j = await cachedJson<{ recentSlotDurationInMs: number }>(`${API}/slots/duration`, 60 * 60_000, 3000);
    if (j.recentSlotDurationInMs > 100 && j.recentSlotDurationInMs < 1000) { slotMs = { at: Date.now(), v: j.recentSlotDurationInMs }; return slotMs.v; }
  } catch { /* fall through */ }
  return 400;
}

// ---------- misc ----------

/** Asset family used to judge how correlated collateral and debt are. */
export function family(symbol: string): "sol" | "usd" | "btc" | "eth" | string {
  const s = symbol.toUpperCase();
  if (s === "SOL" || s === "WSOL" || /SOL$/.test(s) || s === "INF") return "sol";
  if (/USD|USDC|USDT|USDG|USDS|DAI|PYUSD|USDE|FDUSD|EURC/.test(s)) return "usd";
  if (/BTC/.test(s)) return "btc";
  if (/ETH/.test(s)) return "eth";
  return s;
}

/** Decimal-ish (has toString) or number → JS number. */
export const n = (x: { toString(): string } | number | undefined | null) => (x == null ? 0 : typeof x === "number" ? x : Number(x.toString()));

/** UI amount string → base-unit integer string, without float drift. */
export function toBaseUnits(ui: string, decimals: number): string {
  const s = ui.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") throw new Error(`Invalid amount "${ui}"`);
  const [w, f = ""] = s.split(".");
  const out = (w || "0") + f.padEnd(decimals, "0").slice(0, decimals);
  return out.replace(/^0+(?=\d)/, "");
}
