/**
 * Transaction preview engine: given any unsigned/signed base64 transaction and the
 * wallet that will sign it, simulate it against current chain state and report
 * exactly what it does to that wallet — per-token balance deltas (USD priced),
 * network + priority fee, invoked programs and risky-instruction warnings.
 * Never signs or sends anything.
 */
import {
  PublicKey, Transaction, VersionedTransaction,
  type AddressLookupTableAccount, type MessageAccountKeys, type VersionedMessage,
} from "@solana/web3.js";
import { connection, jupHeaders, prices, rpcUrl, SOL_MINT } from "./solana";

export interface PreviewChange {
  mint: string; symbol: string; name?: string; icon?: string; decimals: number;
  delta: number; // UI units, signed
  usd?: number;
}

export interface Preview {
  ok: boolean; error?: string;
  feeLamports: number;
  changes: PreviewChange[];
  accountsTouched: number;
  programs: { id: string; name?: string }[];
  warnings: string[];
  /** Subset of `warnings` that are severe enough to stop and think (durable nonce, ownership changes…). */
  critical: string[];
  /** Net token-account rent in the SOL change: + refunded (accounts closed), − deposited (accounts opened). */
  rentLamports: number;
  unitsConsumed?: number;
}

// ---------- constants ----------

const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const SOL_ICON = "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png";
const U64_MAX = BigInt("18446744073709551615");
const SIM_ADDR_LIMIT = 64;
/** More owner accounts than this handed (writable) to unknown programs triggers an aggregate warning. */
const UNKNOWN_WRITABLE_LIMIT = 3;
const NONCE_WARNING = "Uses a durable nonce, so this transaction never expires: whoever holds the signed copy can submit it days or months from now. This is the classic \"sign now, drain later\" trick. Only approve if you started this yourself in an app you trust.";

export const KNOWN_PROGRAMS: Record<string, string> = {
  [SYSTEM]: "System Program",
  [TOKEN]: "Token Program",
  [TOKEN_2022]: "Token-2022",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Account",
  [COMPUTE_BUDGET]: "Compute Budget",
  AddressLookupTab1e1111111111111111111111111: "Address Lookup Table",
  Stake11111111111111111111111111111111111111: "Stake Program",
  Vote111111111111111111111111111111111111111: "Vote Program",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
  Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo: "Memo (v1)",
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: "Metaplex Token Metadata",
  L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95: "Lighthouse",
  // Jupiter
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter Aggregator v6",
  "61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH": "Jupiter Order Engine",
  j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X: "Jupiter Limit Order v2",
  jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu: "Jupiter Limit Order",
  DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M: "Jupiter DCA",
  PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu: "Jupiter Perps",
  jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9: "Jupiter Lend",
  jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi: "Jupiter Lend Borrow",
  voTpe3tHQ7AjQHMapgSue2HJFAh2cGsdokqN3XqmVSj: "Jupiter Vote",
  // Lending
  KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD: "Kamino Lend",
  KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd: "Kamino Vaults",
  "6LtLpnUFNByNXLyCoK9wA2MykKAmQNZKBdY8s47dehDc": "Kamino Liquidity",
  FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr: "Kamino Farms",
  MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA: "marginfi",
  So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo: "Solend",
  // Trading / DEX
  PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY: "Phoenix",
  dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH: "Drift",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpools",
  "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP": "Orca (legacy)",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium CLMM",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "Raydium CPMM",
  routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS: "Raydium Router",
  LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: "Raydium Launchpad",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM",
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: "Meteora Pools",
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: "Meteora DAMM v2",
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: "Meteora DBC",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap",
  "2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c": "Lifinity v2",
  SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe: "SolFi",
  ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY: "ZeroFi",
  "obriQD1zbpyLz95G5n7nJe6a4DPjpFwa5XYPoNm113y": "Obric v2",
  TessVdML9pBGgG9yGks7o4HewRaXVAMuoVj4x83GLQH: "Tessera V",
  GAMMA7meSFWaBXF25oSUgmGRwaW6sCMFLmBNiMSdbHVT: "GooseFX Gamma",
  DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH: "DFlow",
  T1TANpTeScyeqVzzgNViGDNrkQ6qHz9KrSBS4aNXvGT: "Titan",
  // Staking
  MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD: "Marinade",
  SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy: "SPL Stake Pool",
  SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY: "Sanctum Single Validator Pool",
  SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn: "Sanctum Multi Validator Pool",
  "5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx": "Sanctum Router",
  stkitrT1Uoy18Dk1fTrgPw8W6MVzoCfYoAFT4MLsmhq: "Sanctum Infinity",
};

// ---------- helpers ----------

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const r = await fetch(rpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), cache: "no-store" });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}

interface ParsedTokenInfo { mint: string; owner: string; tokenAmount: { amount: string; decimals: number }; delegate?: string; state?: string }
interface RpcAccount { lamports: number; owner: string; data: unknown }

/** Returns parsed SPL token account info if this account is one (either token program). */
function tokenInfo(a: RpcAccount | null | undefined): ParsedTokenInfo | null {
  if (!a || (a.owner !== TOKEN && a.owner !== TOKEN_2022)) return null;
  const p = (a.data as { parsed?: { type?: string; info?: ParsedTokenInfo } } | undefined)?.parsed;
  return p?.type === "account" && p.info?.mint ? p.info : null;
}

async function getAccounts(keys: string[]): Promise<Map<string, RpcAccount | null>> {
  const out = new Map<string, RpcAccount | null>();
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += 100) chunks.push(keys.slice(i, i + 100));
  const res = await Promise.all(chunks.map((c) => rpc<{ value: (RpcAccount | null)[] }>("getMultipleAccounts", [c, { encoding: "jsonParsed", commitment: "confirmed" }])));
  chunks.forEach((c, ci) => c.forEach((k, i) => out.set(k, res[ci].value[i] ?? null)));
  return out;
}

function decodeTx(base64Tx: string): VersionedTransaction {
  const bytes = Buffer.from(base64Tx, "base64");
  if (!bytes.length) throw new Error("Empty transaction.");
  try { return VersionedTransaction.deserialize(bytes); } catch (e) {
    try {
      const legacy = Transaction.from(bytes);
      return new VersionedTransaction(legacy.compileMessage());
    } catch { throw new Error(`Not a valid Solana transaction: ${e instanceof Error ? e.message : String(e)}`); }
  }
}

async function resolveKeys(msg: VersionedMessage): Promise<MessageAccountKeys> {
  const lookups = msg.addressTableLookups;
  if (!lookups.length) return msg.getAccountKeys();
  const c = connection();
  const tables = await Promise.all(lookups.map((l) => c.getAddressLookupTable(l.accountKey).then((r) => r.value)));
  const missing = lookups.filter((_, i) => !tables[i]);
  if (missing.length) throw new Error(`Address lookup table not found: ${missing[0].accountKey.toBase58()}`);
  return msg.getAccountKeys({ addressLookupTableAccounts: tables as AddressLookupTableAccount[] });
}

const u32 = (d: Uint8Array, o: number) => d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] * 2 ** 24);
const u64 = (d: Uint8Array, o: number) => { let v = BigInt(0); for (let i = 7; i >= 0; i--) v = (v << BigInt(8)) | BigInt(d[o + i] ?? 0); return v; };
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

function computeFee(ixs: { programId: string; data: Uint8Array }[], numSigs: number): number {
  let limit: number | undefined;
  let microLamports = BigInt(0);
  let nonBudget = 0;
  for (const ix of ixs) {
    if (ix.programId !== COMPUTE_BUDGET) { nonBudget++; continue; }
    const d = ix.data;
    if (d[0] === 2 && d.length >= 5) limit = u32(d, 1);
    else if (d[0] === 3 && d.length >= 9) microLamports = u64(d, 1);
  }
  const units = Math.min(limit ?? 200_000 * nonBudget, 1_400_000);
  const priority = (microLamports * BigInt(units) + BigInt(999_999)) / BigInt(1_000_000);
  return 5000 * numSigs + Number(priority);
}

const TOKEN_ERRORS: Record<string, string> = {
  "0": "An account wouldn't be rent-exempt after this transaction.",
  "3": "Token account and mint don't match.",
  "4": "This wallet isn't the owner/authority of that token account.",
  "11": "Can't close a token account that still holds tokens. Move or burn them first.",
  "17": "That token account is frozen.",
};

/** Turn simulation errors into something a human can act on. */
function plainError(err: unknown, logs: string[] = []): string {
  const s = typeof err === "string" ? err : JSON.stringify(err);
  const all = logs.join("\n");
  const custom = s.match(/"Custom":(\d+)/)?.[1];
  if (s === '"AccountNotFound"') return "The fee payer has no SOL to pay the network fee.";
  if (/ProgramAccountNotFound|InvalidProgramForExecution/.test(s)) return "This transaction calls a program that doesn't exist on mainnet.";
  if (/InsufficientFundsForFee/.test(s)) return "Not enough SOL to pay the network fee.";
  if (/InsufficientFundsForRent/.test(s)) return "Not enough SOL left to keep an account rent-exempt. Keep a little more SOL in the wallet.";
  if (/BlockhashNotFound/.test(s)) return "The transaction's blockhash expired. Ask the app to rebuild it.";
  if (/insufficient lamports/i.test(all)) return "Not enough SOL for this transaction.";
  const tokenFailed = /Program Token(keg|z)\w+ failed/.test(all);
  if (/Error: insufficient funds/i.test(all) || (tokenFailed && custom === "1")) return "Not enough tokens in your account for this transfer.";
  if (tokenFailed && custom && TOKEN_ERRORS[custom]) return TOKEN_ERRORS[custom];
  const jupFailed = /Program JUP6\w+ failed/.test(all);
  if (jupFailed && custom === "6024") return "Not enough balance of the token you're selling.";
  if (/SlippageToleranceExceeded|slippage/i.test(all) || (jupFailed && custom === "6001")) return "Price moved beyond your slippage tolerance. Try again or raise slippage.";
  if (/already in use/i.test(all)) return "An account this transaction creates already exists.";
  if (/owner does not match/i.test(all)) return "A token account isn't owned by the expected wallet.";
  if (/exceeded CUs meter|ComputationalBudgetExceeded/i.test(all + s)) return "Ran out of compute units. Ask the app to raise the compute limit.";
  if (/AccountNotFound|could not find account/i.test(all)) return "An account this transaction needs doesn't exist.";
  const logErr = logs.slice().reverse().find((l) => /Error|failed/i.test(l) && !/consumed/.test(l));
  if (logErr) return `Simulation failed: ${logErr.replace(/^Program log: /, "")}`;
  return `Simulation failed: ${s}`;
}

interface TokenMeta { symbol: string; name?: string; icon?: string; decimals?: number }
const metaCache = new Map<string, TokenMeta>();

async function tokenMeta(mints: string[]): Promise<Map<string, TokenMeta>> {
  const out = new Map<string, TokenMeta>();
  out.set(SOL_MINT, { symbol: "SOL", name: "Solana", icon: SOL_ICON, decimals: 9 });
  const need = [...new Set(mints)].filter((m) => m !== SOL_MINT && !metaCache.has(m));
  for (let i = 0; i < need.length; i += 100) {
    try {
      const r = await fetch(`https://api.jup.ag/tokens/v2/search?query=${need.slice(i, i + 100).join(",")}`, { headers: jupHeaders(), cache: "no-store", signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      for (const m of (await r.json()) as { id: string; symbol?: string; name?: string; icon?: string; decimals?: number }[]) {
        if (m.id) metaCache.set(m.id, { symbol: m.symbol || m.id.slice(0, 4), name: m.name, icon: m.icon, decimals: m.decimals });
      }
    } catch { /* metadata is cosmetic */ }
  }
  for (const m of mints) if (m !== SOL_MINT) out.set(m, metaCache.get(m) ?? { symbol: m.slice(0, 4) });
  return out;
}

// ---------- main ----------

export async function previewTransaction(base64Tx: string, owner: string): Promise<Preview> {
  new PublicKey(owner); // throws on bad owner
  const tx = decodeTx(base64Tx);
  const msg = tx.message;
  const keys = await resolveKeys(msg);
  const allKeys = keys.keySegments().flat().map((k) => k.toBase58());
  const writable = allKeys.filter((_, i) => msg.isAccountWritable(i));
  const ixs = msg.compiledInstructions.map((ix) => ({
    programId: allKeys[ix.programIdIndex],
    accounts: ix.accountKeyIndexes.map((i) => allKeys[i]),
    writable: ix.accountKeyIndexes.map((i) => msg.isAccountWritable(i)),
    data: ix.data,
  }));

  const feeLamports = computeFee(ixs, msg.header.numRequiredSignatures);
  const feePayer = allKeys[0];

  // ---- pre-state: owner + every writable account ----
  const preKeys = [...new Set([owner, ...writable])];
  const pre = await getAccounts(preKeys);
  const ownerPre = pre.get(owner);
  const ownerTokenAccts = preKeys.filter((k) => tokenInfo(pre.get(k))?.owner === owner);
  // Writable accounts that don't exist yet could be created as the owner's token accounts (ATAs, temp wSOL…).
  const maybeNew = writable.filter((k) => k !== owner && !pre.get(k));
  // Writable system-owned zero-data accounts could also be re-initialised; lowest priority.
  const simAddrs = [...new Set([owner, ...ownerTokenAccts, ...maybeNew])].slice(0, SIM_ADDR_LIMIT);

  // ---- instruction inspection (warnings + programs) ----
  const warnings: string[] = [];
  const programIds = new Set<string>();
  const sourceMint = (acct: string) => tokenInfo(pre.get(acct))?.mint;
  const isOwnerAcct = (a: string) => a === owner || ownerTokenAccts.includes(a);
  const mintsForWarnings = new Set<string>();

  type Pending = (meta: Map<string, TokenMeta>) => string;
  const pendingWarnings: Pending[] = [];
  let sawApprove = false;
  let sawOwnerChange = false;
  const critical = new Set<string>();
  const addW = (w: string | Pending, severe = false) => pendingWarnings.push((meta) => {
    const text = typeof w === "string" ? w : w(meta);
    if (severe) critical.add(text);
    return text;
  });
  const crit = (w: string) => { critical.add(w); warnings.push(w); };
  const unknownWritable = new Set<string>();

  ixs.forEach((ix, ixIndex) => {
    programIds.add(ix.programId);
    const d = ix.data;
    const a = ix.accounts;
    if (ix.programId === TOKEN || ix.programId === TOKEN_2022) {
      const tag = d[0];
      if (tag === 4 || tag === 13) { // Approve / ApproveChecked
        const [src, delegate, auth] = tag === 4 ? [a[0], a[1], a[2]] : [a[0], a[2], a[3]];
        if (auth === owner) {
          sawApprove = true;
          const amount = d.length >= 9 ? u64(d, 1) : BigInt(0);
          const mint = (tag === 13 ? a[1] : undefined) ?? sourceMint(src);
          if (mint) mintsForWarnings.add(mint);
          const decimals = tag === 13 ? d[9] : tokenInfo(pre.get(src))?.tokenAmount.decimals;
          addW((meta) => {
            const sym = mint ? meta.get(mint)?.symbol ?? short(mint) : "tokens";
            const amt = amount >= U64_MAX / BigInt(2) ? "an unlimited amount of" : decimals != null ? `up to ${(Number(amount) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: decimals })} of` : `up to ${amount} base units of`;
            return `Approves a delegate (${short(delegate)}) to spend ${amt} your ${sym}.`;
          });
        }
      } else if (tag === 6) { // SetAuthority
        const [acct, auth] = a;
        if (auth === owner || isOwnerAcct(acct)) {
          const type = d[1];
          const hasNew = d[2] === 1;
          const newAuth = hasNew ? new PublicKey(d.slice(3, 35)).toBase58() : undefined;
          if (type === 2) { sawOwnerChange = true; addW(`Transfers ownership/authority of a token account${newAuth ? ` to ${short(newAuth)}` : ""}.`, true); }
          else if (type === 3) addW(`Sets close authority on a token account${newAuth ? ` to ${short(newAuth)}` : " (removed)"}.`);
          else if (type === 0 || type === 1) addW(`Changes the ${type === 0 ? "mint" : "freeze"} authority of a token mint${newAuth ? ` to ${short(newAuth)}` : " (revoked)"}.`);
          else addW("Changes an authority on a token account or mint.");
        }
      } else if (tag === 9) { // CloseAccount
        const [acct, dest, auth] = a;
        if (auth === owner || isOwnerAcct(acct)) {
          const info = tokenInfo(pre.get(acct));
          // Closing a temp account created in this same tx (e.g. wSOL unwrap) is routine.
          if (info && dest !== owner) addW(`Closes one of your token accounts and sends its rent to ${short(dest)}.`);
          else if (info && BigInt(info.tokenAmount.amount) > BigInt(0)) addW("Closes one of your token accounts.");
          // Empty account closed back to you (e.g. wSOL unwrap) just refunds rent: not worth a warning.
        }
      }
    } else if (ix.programId === SYSTEM) {
      const tag = d.length >= 4 ? u32(d, 0) : -1;
      if ((tag === 1 || tag === 10) && a[0] === owner) { // Assign / AssignWithSeed
        const newOwner = tag === 1 ? new PublicKey(d.slice(4, 36)).toBase58() : undefined;
        addW(`Assigns your account to another program${newOwner ? ` (${KNOWN_PROGRAMS[newOwner] ?? short(newOwner)})` : ""} — it could take control of your SOL.`, true);
      } else if (tag === 4) { // AdvanceNonceAccount: [nonce account, RecentBlockhashes sysvar, nonce authority]
        // The runtime only honours it as the first instruction; anywhere else it's still a red flag.
        addW(ixIndex === 0 ? NONCE_WARNING : `${NONCE_WARNING} (The nonce instruction isn't first, so it may also just fail.)`, true);
        if (a[2] && a[2] !== owner) addW(`The durable nonce is controlled by ${short(a[2])}, not this wallet.`);
      } else if (tag === 7 && a[1] === owner) { // AuthorizeNonceAccount
        const newAuth = d.length >= 36 ? new PublicKey(d.slice(4, 36)).toBase58() : undefined;
        addW(`Hands control of one of your durable nonce accounts${newAuth ? ` to ${short(newAuth)}` : ""}.`, true);
      }
    } else if (!KNOWN_PROGRAMS[ix.programId]) {
      const handsOwner = a.some((k, i) => ix.writable[i] && isOwnerAcct(k));
      a.forEach((k, i) => { if (ix.writable[i] && isOwnerAcct(k)) unknownWritable.add(k); });
      addW(handsOwner
        ? `Gives write access to your ${a.some((k, i) => ix.writable[i] && k === owner) ? "wallet" : "token account"} to an unknown program (${short(ix.programId)}).`
        : `Calls an unknown program (${short(ix.programId)}).`);
    }
  });
  if (unknownWritable.size > UNKNOWN_WRITABLE_LIMIT) {
    addW(`Gives unknown programs write access to ${unknownWritable.size} of your accounts at once — typical of wallet drainers sweeping every token.`, true);
  }
  if (feePayer !== owner) warnings.push(`The network fee is paid by ${short(feePayer)}, not this wallet.`);
  if (!allKeys.slice(0, msg.header.numRequiredSignatures).includes(owner)) warnings.push("This wallet isn't a required signer of this transaction.");

  // ---- simulate ----
  type SimAcct = RpcAccount | null;
  type InnerIx = { programIdIndex?: number; programId?: string; program?: string; parsed?: { type?: string; info?: Record<string, unknown> } };
  let sim: { err: unknown; logs?: string[]; unitsConsumed?: number; accounts?: SimAcct[] | null; innerInstructions?: { instructions: InnerIx[] }[] | null };
  try {
    const r = await rpc<{ value: typeof sim }>("simulateTransaction", [base64Tx, {
      encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", innerInstructions: true,
      accounts: { encoding: "jsonParsed", addresses: simAddrs },
    }]);
    sim = r.value;
  } catch (e) {
    sim = { err: e instanceof Error ? e.message : String(e) };
  }
  for (const g of sim.innerInstructions ?? []) for (const ii of g.instructions) {
    const id = ii.programId ?? (ii.programIdIndex != null ? allKeys[ii.programIdIndex] : undefined);
    if (id) programIds.add(id);
    // CPI-level risky instructions (the RPC returns inner instructions jsonParsed).
    const t = ii.parsed?.type; const info = ii.parsed?.info ?? {};
    const str = (k: string) => (typeof info[k] === "string" ? (info[k] as string) : undefined);
    if (!t) continue;
    if ((id === TOKEN || id === TOKEN_2022) && t === "setAuthority") {
      const acct = str("account") ?? str("mint"); const auth = str("authority") ?? str("multisigAuthority");
      if (auth !== owner && !(acct && isOwnerAcct(acct))) continue;
      const kind = str("authorityType"); const to = str("newAuthority");
      if (kind === "accountOwner") { sawOwnerChange = true; crit(`A program called by this transaction transfers ownership of one of your token accounts${to ? ` to ${short(to)}` : ""}.`); }
      else if (kind === "closeAccount") crit(`A program called by this transaction sets the close authority of one of your token accounts${to ? ` to ${short(to)}` : ""}.`);
      else warnings.push(`A program called by this transaction changes the ${kind ?? "authority"} of a token account or mint you control.`);
    } else if ((id === TOKEN || id === TOKEN_2022) && t === "closeAccount") {
      const acct = str("account"); const dest = str("destination"); const auth = str("owner") ?? str("multisigOwner");
      if ((auth === owner || (acct && isOwnerAcct(acct))) && dest && dest !== owner) crit(`A program called by this transaction closes one of your token accounts and sends its rent to ${short(dest)}.`);
    } else if (id === SYSTEM && (t === "assign" || t === "assignWithSeed") && str("account") === owner) {
      const to = str("owner");
      crit(`A program called by this transaction assigns your wallet to ${to ? KNOWN_PROGRAMS[to] ?? short(to) : "another program"} — it could take control of your SOL.`);
    } else if (id === SYSTEM && t === "authorizeNonce" && str("nonceAuthority") === owner) {
      crit(`A program called by this transaction hands control of your durable nonce account to ${short(str("newAuthorized") ?? "another wallet")}.`);
    }
  }

  // ---- diff ----
  const deltas = new Map<string, { raw: bigint; decimals: number }>(); // mint → raw delta
  const bump = (mint: string, raw: bigint, decimals: number) => {
    const cur = deltas.get(mint);
    deltas.set(mint, { raw: (cur?.raw ?? BigInt(0)) + raw, decimals });
  };
  const preSol = ownerPre?.lamports ?? 0;
  let solDeltaLamports = 0;
  let rentLamports = 0;
  if (!sim.err && sim.accounts) {
    simAddrs.forEach((addr, i) => {
      const post = sim.accounts![i] ?? null;
      const before = pre.get(addr) ?? null;
      if (addr === owner) {
        solDeltaLamports = (post?.lamports ?? 0) - (before?.lamports ?? 0);
        bump(SOL_MINT, BigInt(solDeltaLamports), 9);
        return;
      }
      const tPre = tokenInfo(before);
      const tPost = tokenInfo(post);
      const preOwned = tPre?.owner === owner;
      const postOwned = tPost?.owner === owner;
      if (!preOwned && !postOwned) return;
      const preAmt = preOwned ? BigInt(tPre!.tokenAmount.amount) : BigInt(0);
      const postAmt = postOwned ? BigInt(tPost!.tokenAmount.amount) : BigInt(0);
      // Rent: lamports held by the account beyond its (wrapped-SOL) balance come back when it's closed.
      const native = (t: typeof tPre) => t?.mint === SOL_MINT;
      // The simulator reports a closed account as missing or as an empty 0-lamport account.
      const closed = !post || !post.lamports, opened = !before || !before.lamports;
      if (preOwned && closed) rentLamports += (before?.lamports ?? 0) - (native(tPre) ? Number(preAmt) : 0);
      if (postOwned && opened) rentLamports -= (post?.lamports ?? 0) - (native(tPost) ? Number(postAmt) : 0);
      // Same mint pre/post (or created/closed). A changed owner moves the whole balance out.
      if (tPre && preOwned && (!tPost || tPost.mint === tPre.mint)) bump(tPre.mint, postAmt - preAmt, tPre.tokenAmount.decimals);
      else {
        if (preOwned) bump(tPre!.mint, -preAmt, tPre!.tokenAmount.decimals);
        if (postOwned) bump(tPost!.mint, postAmt, tPost!.tokenAmount.decimals);
      }
      if (preOwned && tPost && !postOwned && !sawOwnerChange) crit("Transfers ownership of one of your token accounts to another wallet.");
      if (postOwned && tPost?.delegate && tPost.delegate !== tPre?.delegate) {
        // Top-level approves are decoded above; this catches CPI-driven ones.
        if (!sawApprove) warnings.push(`Approves a delegate (${short(tPost.delegate)}) to spend from one of your token accounts.`);
      }
    });
  }

  const changeMints = [...deltas.entries()].filter(([, v]) => v.raw !== BigInt(0)).map(([m]) => m);
  const [meta, px] = await Promise.all([
    tokenMeta([...changeMints, ...mintsForWarnings]),
    changeMints.length ? prices(changeMints).catch(() => ({} as Record<string, number>)) : Promise.resolve({} as Record<string, number>),
  ]);
  const changes: PreviewChange[] = changeMints.map((mint) => {
    const { raw, decimals } = deltas.get(mint)!;
    const m = meta.get(mint) ?? { symbol: mint.slice(0, 4) };
    const delta = Number(raw) / 10 ** decimals;
    const price = px[mint];
    return { mint, symbol: m.symbol, name: m.name, icon: m.icon, decimals, delta, ...(price != null ? { usd: delta * price } : {}) };
  }).sort((x, y) => (x.mint === SOL_MINT ? -1 : y.mint === SOL_MINT ? 1 : Math.abs(y.usd ?? 0) - Math.abs(x.usd ?? 0)));

  warnings.unshift(...pendingWarnings.map((f) => f(meta)));
  if (!sim.err && preSol > 0 && -solDeltaLamports > preSol * 0.5) {
    warnings.push(`Sends out ${((-solDeltaLamports / preSol) * 100).toFixed(0)}% of your SOL balance.`);
  }
  // Severe warnings first so they're the first thing the user reads.
  const ordered = [...new Set([...warnings.filter((w) => critical.has(w)), ...warnings.filter((w) => !critical.has(w))])];

  return {
    ok: !sim.err,
    rentLamports,
    ...(sim.err ? { error: plainError(sim.err, sim.logs) } : {}),
    feeLamports,
    changes,
    accountsTouched: allKeys.length,
    programs: [...programIds].map((id) => ({ id, ...(KNOWN_PROGRAMS[id] ? { name: KNOWN_PROGRAMS[id] } : {}) })),
    warnings: ordered,
    critical: ordered.filter((w) => critical.has(w)),
    ...(sim.unitsConsumed != null ? { unitsConsumed: sim.unitsConsumed } : {}),
  };
}
