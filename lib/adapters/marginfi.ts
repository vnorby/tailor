/**
 * Marginfi (mrgnlend) adapter — main group only.
 *
 * positions(): one "lending" Position per marginfi account of the owner. Accounts are found
 * with a filtered getProgramAccounts (group + authority), then a read-only MarginfiClient is
 * loaded with *only the banks those accounts use* (preloadedBankAddresses skips the bank gPA),
 * so a snapshot is a handful of RPC calls.
 *
 * build(): repay / withdraw (partial or all) / deposit per bank.
 * Instructions come from the official SDK and are wrapped with buildTx().
 */
import { Connection, PublicKey, TransactionInstruction, type VersionedTransaction, type Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  MarginfiClient, MarginfiAccount, MarginfiAccountWrapper, MarginRequirementType, MARGINFI_IDL, getConfig, instructions, makeUnwrapSolIx,
  type Bank,
} from "@mrgnlabs/marginfi-client-v2";
import { BorshAccountsCoder, Program, type Idl } from "@coral-xyz/anchor";
import { uiToNative, wrappedI80F48toBigNumber } from "@mrgnlabs/mrgn-common";
import bs58 from "bs58";
import type { Action, Adapter, BuiltAction, Ctx, Leg, Metric, Position, ToolDef } from "@/lib/core/types";
import { buildTx, connection as sharedConnection, jupHeaders, num, pct, riskFromHealth, usd, jupBase } from "@/lib/core/solana";

const CONFIG = getConfig("production");
const PROGRAM = CONFIG.programId;
const GROUP = CONFIG.groupPk;
const APP_URL = "https://app.0.xyz/portfolio"; // marginfi rebranded to Project 0

// ---------- helpers ----------

/** The SDK decodes with camelCased account names, which anchor only produces via Program. */
let camelIdl: typeof MARGINFI_IDL | null = null;
const idl = (conn: Connection) =>
  (camelIdl ??= new Program({ ...MARGINFI_IDL, address: PROGRAM.toBase58() } as typeof MARGINFI_IDL, { connection: conn } as never).idl as typeof MARGINFI_IDL);
const RAW_IDL = MARGINFI_IDL as unknown as { accounts: { name: string; discriminator: number[] }[]; types: { name: string; type: { kind: string; variants?: { name: string }[] } }[] };
const ACCOUNT_DISC = Buffer.from(RAW_IDL.accounts.find((a) => a.name === "MarginfiAccount")!.discriminator);

/**
 * The installed SDK (IDL 0.1.7) only knows oracle setups 0–12; newer banks (Juplend, fixed-price
 * integrator banks, …) use higher variants and make the SDK's bank decode throw. We probe banks with
 * a padded copy of the IDL and keep unsupported ones out of the SDK client (shown read-only).
 */
const SDK_ORACLE_SETUPS = RAW_IDL.types.find((t) => t.name === "OracleSetup")!.type.variants!.map((v) => v.name);
let probeCoder: BorshAccountsCoder | null = null;
const coder = () => (probeCoder ??= (() => {
  const padded = JSON.parse(JSON.stringify(MARGINFI_IDL)) as typeof RAW_IDL;
  for (const t of padded.types) if (t.type.kind === "enum") for (let i = t.type.variants!.length; i < 64; i++) t.type.variants!.push({ name: `Unknown${i}` });
  return new BorshAccountsCoder(padded as unknown as Idl);
})());

interface RawBank { mint: string; decimals: number; assetShareValue: number; liabShareValue: number; assetWeightMaint: number; liabWeightMaint: number; oracle: string }
async function probeBanks(conn: Connection, pks: PublicKey[]) {
  const ais = pks.length ? await conn.getMultipleAccountsInfo(pks) : [];
  const supported: PublicKey[] = [];
  const unsupported = new Map<string, RawBank>();
  const oracleKeys = new Map<string, PublicKey[]>(); // every bank's configured oracle accounts, for health metas
  ais.forEach((ai, i) => {
    if (!ai) return;
    try {
      const d = coder().decode("Bank", ai.data);
      oracleKeys.set(pks[i].toBase58(), (d.config.oracle_keys as PublicKey[]).filter((k) => !k.equals(PublicKey.default)));
      const oracle = Object.keys(d.config.oracle_setup)[0];
      if (SDK_ORACLE_SETUPS.includes(oracle)) { supported.push(pks[i]); return; }
      unsupported.set(pks[i].toBase58(), {
        mint: d.mint.toBase58(), decimals: d.mint_decimals, oracle,
        assetShareValue: wrappedI80F48toBigNumber(d.asset_share_value).toNumber(),
        liabShareValue: wrappedI80F48toBigNumber(d.liability_share_value).toNumber(),
        assetWeightMaint: wrappedI80F48toBigNumber(d.config.asset_weight_maint).toNumber(),
        liabWeightMaint: wrappedI80F48toBigNumber(d.config.liability_weight_maint).toNumber(),
      });
    } catch { /* not a bank we can read at all */ }
  });
  return { supported, unsupported, oracleKeys };
}

/**
 * Health-check remaining accounts: [bank, ...its oracle keys] per bank, sorted by bank key (same as
 * the SDK's composeRemainingAccounts). The SDK's own version only passes oracle_keys[0], which breaks
 * for Kamino/Drift/Solend integrator banks (they also need the reserve/market) and needs bank metadata
 * for staked banks; using every configured key covers all oracle setups, including ones the SDK doesn't know.
 */
function healthMetas(active: PublicKey[], oracleKeys: Map<string, PublicKey[]>, target: PublicKey, withdrawAll: boolean): PublicKey[] {
  const set = new Map(active.map((b) => [b.toBase58(), b]));
  if (withdrawAll) set.delete(target.toBase58()); else set.set(target.toBase58(), target);
  const groups = [...set.values()].map((b) => [b, ...(oracleKeys.get(b.toBase58()) ?? [])]);
  groups.sort((a, b) => Buffer.compare(Buffer.from(b[0].toBytes()), Buffer.from(a[0].toBytes())));
  return groups.flat();
}

/** Read-only wallet: the SDK wants one, but we never sign. */
const roWallet = (owner: PublicKey) => ({
  publicKey: owner,
  signTransaction: async <T extends Transaction | VersionedTransaction>(_tx: T): Promise<T> => { throw new Error("read-only"); },
  signAllTransactions: async <T extends Transaction | VersionedTransaction>(_txs: T[]): Promise<T[]> => { throw new Error("read-only"); },
});

async function findAccounts(conn: Connection, owner: PublicKey) {
  const res = await conn.getProgramAccounts(PROGRAM, {
    filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(ACCOUNT_DISC) } },
      { memcmp: { offset: 8, bytes: GROUP.toBase58() } },
      { memcmp: { offset: 40, bytes: owner.toBase58() } },
    ],
  });
  return res.map(({ pubkey, account }) => MarginfiAccount.fromAccountDataRaw(pubkey, account.data as Buffer, idl(conn)));
}

async function loadClient(conn: Connection, owner: PublicKey, banks: PublicKey[]) {
  // bankMetadataMap: {} — the SDK's GCS metadata bucket is gone; withdraw only needs a truthy map.
  return MarginfiClient.fetch(CONFIG, roWallet(owner), conn, { readOnly: true, preloadedBankAddresses: banks, bankMetadataMap: {} });
}

const symCache = new Map<string, string>(Object.entries({
  So11111111111111111111111111111111111111112: "SOL", EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT", cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: "cbBTC",
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "JitoSOL", mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: "mSOL",
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "JUP", "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": "ETH",
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": "WBTC", USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA: "USDS",
  USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: "USD1", A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS: "ZEC",
  HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr: "EURC", AvZZF1YaZDziPY2RCK4oJrRVrbN3mTD9NL24hPeaZeUj: "syrupUSDC",
}));
async function symbols(mints: string[], ctx?: Ctx): Promise<Record<string, string>> {
  for (const t of ctx?.tokens ?? []) if (!symCache.has(t.mint)) symCache.set(t.mint, t.symbol);
  const need = [...new Set(mints)].filter((m) => !symCache.has(m));
  if (need.length) {
    try {
      const r = await fetch(`${jupBase()}/tokens/v2/search?query=${need.slice(0, 100).join(",")}`, { headers: jupHeaders(), cache: "no-store" });
      if (r.ok) for (const t of (await r.json()) as { id: string; symbol: string }[]) symCache.set(t.id, t.symbol);
    } catch { /* best effort */ }
  }
  return Object.fromEntries(mints.map((m) => [m, symCache.get(m) ?? `${m.slice(0, 4)}…`]));
}

const n = (b: { toNumber(): number }) => b.toNumber();
const aprToApy = (apr: number) => Math.pow(1 + apr / 365, 365) - 1;

// ---------- positions ----------

async function positions(owner: string, ctx: Ctx): Promise<Position[]> {
  const conn = ctx.connection ?? sharedConnection();
  const ownerPk = new PublicKey(owner);
  const accounts = await findAccounts(conn, ownerPk);
  if (!accounts.length) return [];
  const bankPks = [...new Set(accounts.flatMap((a) => a.balances.filter((b) => b.active).map((b) => b.bankPk.toBase58())))].map((s) => new PublicKey(s));
  if (!bankPks.length) {
    return []; // only empty accounts (closing needs a newer program interface than the SDK has — see report)
  }
  const { supported, unsupported } = await probeBanks(conn, bankPks);
  const client = await loadClient(conn, ownerPk, supported);
  const mints = [...[...client.banks.values()].map((b) => b.mint.toBase58()), ...[...unsupported.values()].map((b) => b.mint)];
  const [syms, px] = await Promise.all([symbols(mints, ctx), ctx.prices(mints).catch(() => ({} as Record<string, number>))]);

  const out: Position[] = [];
  for (const acc of accounts) {
    const w = new MarginfiAccountWrapper(acc.address, client, acc);
    const active = w.activeBalances;
    if (!active.length) continue;

    const legs: Leg[] = [];
    const actions: Action[] = [];
    const banksRaw: Record<string, { mint: string; symbol: string; decimals: number; supply: number; borrow: number }> = {};
    let supplyUsd = 0, borrowUsd = 0, weightedApy = 0;
    const unpriced: string[] = [];
    let extraMaintA = 0, extraMaintL = 0; // maintenance-weighted value of banks the SDK can't load
    const hasUnsupported = active.some((b) => unsupported.has(b.bankPk.toBase58()));
    for (const bal of active) {
      const ub = unsupported.get(bal.bankPk.toBase58());
      if (ub) {
        // Read-only leg: shares × share value, priced by Jupiter. No actions (SDK can't build for this bank).
        const symbol = syms[ub.mint];
        const supply = (n(bal.assetShares) * ub.assetShareValue) / 10 ** ub.decimals;
        const borrow = (n(bal.liabilityShares) * ub.liabShareValue) / 10 ** ub.decimals;
        const price = px[ub.mint] ?? 0;
        if (!px[ub.mint]) unpriced.push(symbol);
        banksRaw[bal.bankPk.toBase58()] = { mint: ub.mint, symbol, decimals: ub.decimals, supply, borrow };
        if (supply > 1e-9) { legs.push({ side: "supply", symbol, mint: ub.mint, amount: supply, valueUsd: supply * price }); supplyUsd += supply * price; extraMaintA += supply * price * ub.assetWeightMaint; }
        if (borrow > 1e-9) { legs.push({ side: "borrow", symbol, mint: ub.mint, amount: borrow, valueUsd: borrow * price }); borrowUsd += borrow * price; extraMaintL += borrow * price * ub.liabWeightMaint; }
        continue;
      }
      const bank = client.banks.get(bal.bankPk.toBase58());
      const oracle = client.oraclePrices.get(bal.bankPk.toBase58());
      if (!bank) continue;
      const mint = bank.mint.toBase58();
      const symbol = (bank.tokenSymbol || syms[mint]) + (["", "", "", " (Kamino)", " (Drift)", " (Solend)"][bank.config.assetTag] ?? "");
      const q = bal.computeQuantityUi(bank);
      const usdV = oracle ? bal.computeUsdValue(bank, oracle, MarginRequirementType.Equity) : null;
      const price = px[mint] ?? (oracle ? n(oracle.priceRealtime.price) : 0);
      const rates = bank.computeInterestRates();
      const supply = n(q.assets), borrow = n(q.liabilities);
      banksRaw[bank.address.toBase58()] = { mint, symbol, decimals: bank.mintDecimals, supply, borrow };
      const standard = bank.config.assetTag < 3; // Kamino/Drift/Solend integrator banks need their own ixs
      if (supply > 1e-9 && (supply * price >= 0.01 || !price)) {
        const v = usdV ? n(usdV.assets) : supply * price;
        const apy = aprToApy(n(rates.lendingRate));
        legs.push({ side: "supply", symbol, mint, amount: supply, valueUsd: v, apy });
        supplyUsd += v; weightedApy += v * apy;
        if (standard) actions.push({ id: `withdraw:${bank.address.toBase58()}`, label: `Withdraw ${symbol}`, intent: "withdraw", fields: [{ name: "amount", label: "Amount", kind: "amount", unit: symbol, max: supply, default: String(supply) }] });
        if (standard) actions.push({ id: `deposit:${bank.address.toBase58()}`, label: `Deposit ${symbol}`, intent: "deposit", fields: [{ name: "amount", label: "Amount", kind: "amount", unit: symbol }] });
      }
      if (borrow > 1e-9) {
        const v = usdV ? n(usdV.liabilities) : borrow * price;
        const apy = aprToApy(n(rates.borrowingRate));
        legs.push({ side: "borrow", symbol, mint, amount: borrow, valueUsd: v, apy });
        borrowUsd += v; weightedApy -= v * apy;
        actions.unshift({ id: `repay:${bank.address.toBase58()}`, label: `Repay ${symbol}`, intent: "repay", fields: [{ name: "amount", label: "Amount", kind: "amount", unit: symbol, max: borrow, default: String(borrow) }] });
      }
    }
    const equity = supplyUsd - borrowUsd;

    // Health: maintenance-weighted assets vs liabilities (oracle-based, not the possibly stale on-chain cache).
    let risk: Position["risk"] = { level: "ok", score: Math.min(20, Math.round(Math.log10(Math.max(1, supplyUsd)) * 4)) };
    const metrics: Metric[] = [];
    if (borrowUsd > 0) {
      // Oracle-based maintenance health; banks the SDK can't load are added from their raw weights × Jupiter price.
      const excluded = active.filter((b) => unsupported.has(b.bankPk.toBase58())).map((b) => b.bankPk);
      const { assets, liabilities } = acc.computeHealthComponentsLegacy(client.banks, client.oraclePrices, MarginRequirementType.Maintenance, excluded);
      const A = n(assets) + extraMaintA, L = n(liabilities) + extraMaintL;
      const health = A > 0 ? ((A - L) / A) * 100 : 0;
      const usedPct = A > 0 ? L / A : 1;
      let liqPrice: number | undefined, markPrice: number | undefined;
      const coll = legs.filter((l) => l.side === "supply");
      if (coll.length === 1 && !hasUnsupported) {
        const bankPk = Object.keys(banksRaw).find((k) => banksRaw[k].mint === coll[0].mint && banksRaw[k].supply > 0);
        if (bankPk) {
          const lp = w.computeLiquidationPriceForBank(new PublicKey(bankPk));
          if (lp && lp > 0) { liqPrice = lp; markPrice = coll[0].amount > 0 ? coll[0].valueUsd / coll[0].amount : undefined; }
        }
      }
      const reason = `Debt uses ${pct(Math.min(usedPct, 9.99), 0)} of your liquidation limit`
        + (liqPrice && markPrice ? ` — ${coll[0].symbol} liquidates at ${usd(liqPrice)} (${pct(1 - liqPrice / markPrice, 0)} below now)` : "")
        + (hasUnsupported ? " (approximate: some banks priced off-chain)" : "");
      risk = unpriced.length
        ? { level: "watch", score: 50, reason: `Couldn't price ${unpriced.join(", ")} — check health in the marginfi app` }
        : riskFromHealth(health, reason, { liqPrice, markPrice });
      if (!unpriced.length) metrics.push({ label: "Health", value: `${health.toFixed(0)}%`, tone: health < 15 ? "neg" : health < 35 ? "warn" : "pos" });
      metrics.push({ label: "Borrowed", value: usd(borrowUsd) });
    }
    const netApy = equity > 0 ? weightedApy / equity : 0;
    metrics.unshift({ label: "Supplied", value: usd(supplyUsd) });
    if (!hasUnsupported && equity > 0) metrics.push({ label: "Net APY", value: pct(netApy, 2), tone: netApy >= 0 ? "pos" : "neg" });

    if (hasUnsupported) metrics.push({ label: "Note", value: "Some banks read-only", tone: "muted" });
    const supSyms = legs.filter((l) => l.side === "supply").map((l) => l.symbol);
    const borSyms = legs.filter((l) => l.side === "borrow").map((l) => l.symbol);
    out.push({
      id: `marginfi:${acc.address.toBase58()}`,
      protocol: "marginfi",
      kind: "lending",
      title: borSyms.length ? `${supSyms.join(" + ") || "—"} → ${borSyms.join(" + ")}` : `${supSyms.join(" + ")} lending`,
      subtitle: `Marginfi · account ${acc.address.toBase58().slice(0, 4)}…${acc.address.toBase58().slice(-4)}`,
      valueUsd: equity,
      legs, metrics, risk, actions,
      url: APP_URL,
      raw: { account: acc.address.toBase58(), banks: banksRaw },
      updatedAt: Date.now(),
    });
  }
  return out;
}

// ---------- build ----------

async function wrapperFor(conn: Connection, owner: string, account: string, extraBanks: string[] = []) {
  const ownerPk = new PublicKey(owner);
  const ai = await conn.getAccountInfo(new PublicKey(account));
  if (!ai) throw new Error("Marginfi account not found");
  const pure = MarginfiAccount.fromAccountDataRaw(new PublicKey(account), ai.data, idl(conn));
  if (!pure.authority.equals(ownerPk)) throw new Error("This marginfi account belongs to another wallet");
  const banks = [...new Set([...pure.balances.filter((b) => b.active).map((b) => b.bankPk.toBase58()), ...extraBanks])].map((s) => new PublicKey(s));
  const { supported, unsupported, oracleKeys } = await probeBanks(conn, banks);
  const client = await loadClient(conn, ownerPk, supported);
  return { w: new MarginfiAccountWrapper(pure.address, client, pure), client, unsupported, oracleKeys };
}

/** Switchboard-pull banks need a feed crank before health checks; returned as its own tx (may be empty). */
async function crankTx(owner: string, w: MarginfiAccountWrapper, banks: PublicKey[]): Promise<string[]> {
  try {
    const { instructions, luts } = await w.makeUpdateFeedIx(banks);
    if (!instructions.length) return [];
    return [await buildTx(owner, instructions, { luts, cuLimit: 1_000_000 })];
  } catch { return []; }
}

async function walletBalance(conn: Connection, owner: string, mint: PublicKey, tokenProgram?: PublicKey): Promise<number> {
  try {
    if (mint.toBase58() === "So11111111111111111111111111111111111111112") {
      // SDK wraps native SOL for wSOL repays; count native + any wSOL already wrapped (leave 0.01 SOL for fees).
      const [lamports, wsol] = await Promise.all([conn.getBalance(new PublicKey(owner)), tokenBal(conn, owner, mint, tokenProgram)]);
      return Math.max(0, lamports / 1e9 - 0.01) + wsol;
    }
    return await tokenBal(conn, owner, mint, tokenProgram);
  } catch { return Infinity; } // never block on a balance lookup failure; simulation will catch it
}
async function tokenBal(conn: Connection, owner: string, mint: PublicKey, tokenProgram?: PublicKey) {
  const ata = getAssociatedTokenAddressSync(mint, new PublicKey(owner), true, tokenProgram);
  const r = await conn.getTokenAccountBalance(ata).catch(() => null);
  return r?.value.uiAmount ?? 0;
}

/** Kamino-backed banks (asset tag 3) price off a klend reserve that must be refreshed in the same slot. */
async function kaminoRefreshIxs(conn: Connection, banks: PublicKey[], client: MarginfiClient, oracleKeys: Map<string, PublicKey[]>): Promise<TransactionInstruction[]> {
  const reserves = banks.filter((b) => client.banks.get(b.toBase58())?.config.assetTag === 3)
    .map((b) => oracleKeys.get(b.toBase58())?.[1]).filter((k): k is PublicKey => !!k);
  if (!reserves.length) return [];
  const { Reserve, PROGRAM_ID: KLEND } = await import("@kamino-finance/klend-sdk");
  const klend = new PublicKey(KLEND);
  const ais = await conn.getMultipleAccountsInfo(reserves);
  const DEFAULT = PublicKey.default.toBase58();
  const opt = (a: string) => (a && a !== DEFAULT ? new PublicKey(a) : klend);
  return reserves.flatMap((r, i) => {
    const ai = ais[i]; if (!ai) return [];
    const rs = Reserve.decode(Buffer.from(ai.data));
    const ti = rs.config.tokenInfo;
    return [new TransactionInstruction({
      programId: klend,
      data: Buffer.from([2, 218, 138, 235, 79, 201, 25, 102]), // refresh_reserve
      keys: [
        { pubkey: r, isSigner: false, isWritable: true },
        { pubkey: new PublicKey(rs.lendingMarket), isSigner: false, isWritable: false },
        { pubkey: opt(ti.pythConfiguration.price), isSigner: false, isWritable: false },
        { pubkey: opt(ti.switchboardConfiguration.priceAggregator), isSigner: false, isWritable: false },
        { pubkey: opt(ti.switchboardConfiguration.twapAggregator), isSigner: false, isWritable: false },
        { pubkey: opt(ti.scopeConfiguration.priceFeed), isSigner: false, isWritable: false },
      ],
    })];
  });
}

const amountOf = (params: Record<string, string>) => {
  const a = Number(params.amount);
  if (!Number.isFinite(a) || a <= 0) throw new Error("Enter an amount greater than zero");
  return a;
};

async function build(owner: string, position: Position, actionId: string, params: Record<string, string>, ctx: Ctx): Promise<BuiltAction> {
  const conn = ctx.connection ?? sharedConnection();
  const raw = position.raw as { account: string; banks: Record<string, { symbol: string; supply: number; borrow: number }> };
  const [verb, bankStr] = actionId.split(":");
  if (!bankStr) throw new Error(`Unknown action ${actionId}`);
  const bankPk = new PublicKey(bankStr);
  const { w, client, unsupported, oracleKeys } = await wrapperFor(conn, owner, raw.account, [bankStr]);
  const bank = client.banks.get(bankStr) as Bank | undefined;
  if (!bank) throw new Error(unsupported.has(bankStr) ? "This bank uses an oracle type Tailor can't handle yet — use the marginfi app" : "Bank not found");
  const info = raw.banks?.[bankStr];
  const symbol = bank.tokenSymbol || info?.symbol || "tokens";
  if ((verb === "withdraw" || verb === "deposit") && bank.config.assetTag >= 3) throw new Error("This is an integrator (Kamino/Drift/Solend) bank — manage it in the marginfi app");
  const q = w.getBalance(bankPk).computeQuantityUi(bank);
  const luts = client.addressLookupTables;
  const amount = amountOf(params);

  if (verb === "repay") {
    const debt = n(q.liabilities);
    if (debt <= 0) throw new Error(`No ${symbol} debt on this account`);
    const all = amount >= debt * 0.999;
    const have = await walletBalance(conn, owner, bank.mint, client.mintDatas.get(bankStr)?.tokenProgram);
    if (have < (all ? debt : amount) * 0.9999) throw new Error(`Your wallet holds ${num(have)} ${symbol}; you need ${num(all ? debt : amount)} to repay that much`);
    // repayAll pulls the exact live debt (interest accrues); pass a hair more so the wallet check covers it.
    const ix = await w.makeRepayIx(all ? debt * 1.0005 : amount, bankPk, all);
    const warnings = all ? [`Repaying all ${symbol} needs slightly more than ${num(debt)} ${symbol} in your wallet (accrued interest).`] : undefined;
    return { txs: [await buildTx(owner, ix.instructions, { luts, cuLimit: 300_000 })], summary: all ? `Repay your full ${symbol} debt (~${num(debt)} ${symbol}) on marginfi.` : `Repay ${num(amount)} ${symbol} of your marginfi debt.`, warnings };
  }
  if (verb === "withdraw") {
    const sup = n(q.assets);
    if (sup <= 0) throw new Error(`No ${symbol} deposit on this account`);
    const all = amount >= sup * 0.999;
    const crank = await crankTx(owner, w, []);
    const active = w.activeBalances.map((b) => b.bankPk);
    const metas = healthMetas(active, oracleKeys, bankPk, all);
    const tokenProgram = client.mintDatas.get(bankStr)!.tokenProgram;
    const ownerPk = new PublicKey(owner);
    const ata = getAssociatedTokenAddressSync(bank.mint, ownerPk, true, tokenProgram);
    // Built directly (not w.makeWithdrawIx): the SDK resolves every active bank from its own map and
    // throws for banks it can't decode; Kamino-backed banks also need their reserve refreshed this slot.
    const ixs: TransactionInstruction[] = [
      ...(await kaminoRefreshIxs(conn, active.filter((b) => !(all && b.equals(bankPk))), client, oracleKeys)),
      createAssociatedTokenAccountIdempotentInstruction(ownerPk, ata, ownerPk, bank.mint, tokenProgram),
      await instructions.makeWithdrawIx(client.program, { marginfiAccount: w.address, bank: bankPk, destinationTokenAccount: ata, tokenProgram },
        { amount: uiToNative(all ? sup : amount, bank.mintDecimals), withdrawAll: all },
        [...(tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? [bank.mint] : []), ...metas].map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }))),
      ...(bank.mint.equals(NATIVE_MINT) ? [makeUnwrapSolIx(ownerPk)] : []),
    ];
    const tx = await buildTx(owner, ixs, { luts, cuLimit: 800_000 });
    return { txs: [...crank, tx], summary: all ? `Withdraw all ${num(sup)} ${symbol} from marginfi.` : `Withdraw ${num(amount)} ${symbol} from marginfi.` };
  }
  if (verb === "deposit") {
    const ix = await w.makeDepositIx(amount, bankPk);
    return { txs: [await buildTx(owner, ix.instructions, { luts, cuLimit: 300_000 })], summary: `Deposit ${num(amount)} ${symbol} into marginfi.` };
  }
  throw new Error(`Unknown action ${actionId}`);
}

// ---------- tool: deposit into the main bank for a mint ----------

const DEPOSIT_MINTS = [
  { value: "So11111111111111111111111111111111111111112", label: "SOL" },
  { value: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", label: "USDC" },
  { value: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", label: "USDT" },
  { value: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", label: "JitoSOL" },
  { value: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", label: "mSOL" },
  { value: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", label: "JUP" },
];

const tools: ToolDef[] = [{
  id: "marginfi-deposit", protocol: "marginfi", label: "Deposit to marginfi",
  description: "Lend a token on marginfi (main pool) into the wallet's existing marginfi account to earn supply APY.",
  fields: [
    { name: "mint", label: "Token", kind: "select", options: DEPOSIT_MINTS, default: DEPOSIT_MINTS[1].value },
    { name: "amount", label: "Amount", kind: "amount" },
  ],
}];

async function buildTool(owner: string, toolId: string, params: Record<string, string>, ctx: Ctx): Promise<BuiltAction> {
  if (toolId !== "marginfi-deposit") throw new Error(`Unknown tool ${toolId}`);
  const conn = ctx.connection ?? sharedConnection();
  const mint = new PublicKey(params.mint || DEPOSIT_MINTS[1].value);
  const amount = amountOf(params);
  const accounts = await findAccounts(conn, new PublicKey(owner));
  if (!accounts.length) throw new Error("This wallet has no marginfi account yet — open one in the marginfi app first.");
  // Pick the main-group bank for this mint with the most deposits (skips isolated/integrator banks with low TVL).
  const banks = await conn.getProgramAccounts(PROGRAM, {
    filters: [{ memcmp: { offset: 8, bytes: mint.toBase58() } }, { memcmp: { offset: 8 + 32 + 1, bytes: GROUP.toBase58() } }],
    dataSlice: { offset: 0, length: 0 },
  });
  if (!banks.length) throw new Error("Marginfi has no bank for that token");
  const acc = accounts.sort((a, b) => b.activeBalances.length - a.activeBalances.length)[0];
  const { w, client } = await wrapperFor(conn, owner, acc.address.toBase58(), banks.map((b) => b.pubkey.toBase58()));
  const best = [...client.banks.values()].filter((b) => b.mint.equals(mint) && b.config.assetTag < 3)
    .sort((a, b) => n(b.getTotalAssetQuantity()) - n(a.getTotalAssetQuantity()))[0];
  if (!best) throw new Error("Marginfi has no bank for that token");
  const ix = await w.makeDepositIx(amount, best.address);
  const sym = DEPOSIT_MINTS.find((m) => m.value === mint.toBase58())?.label ?? "tokens";
  return { txs: [await buildTx(owner, ix.instructions, { luts: client.addressLookupTables, cuLimit: 300_000 })], summary: `Deposit ${num(amount)} ${sym} into marginfi.` };
}

export const marginfiAdapter: Adapter = { protocol: "marginfi", name: "Marginfi", positions, build, tools, buildTool };
