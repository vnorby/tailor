/**
 * Wallet security checkup: reads every SPL token account the owner holds and
 * reports standing risks — token approvals (delegates, incl. unlimited ones),
 * close authorities that aren't the owner, frozen accounts — plus hygiene items
 * (spam tokens, empty accounts) and concrete recommendations. Read-only.
 */
import { PublicKey } from "@solana/web3.js";
import { connection, jupHeaders, walletTokens } from "@/lib/core/solana";

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** Approvals at or above 2^63 base units are "unlimited" in practice (u64::MAX is the usual value). */
const UNLIMITED = BigInt(2) ** BigInt(63);

export type Severity = "high" | "medium" | "low" | "info";

export interface Finding {
  id: string;
  kind: "delegate" | "close-authority" | "frozen" | "empty-accounts" | "spam";
  severity: Severity;
  title: string;
  detail: string;
  account?: string;
  mint?: string;
  symbol?: string;
  /** Wallet tool that fixes it, if any (opened through the normal action sheet). */
  fix?: { toolId: string; label: string };
}

export interface Checkup {
  owner: string;
  checkedAt: number;
  tokenAccounts: number;
  findings: Finding[];
  recommendations: string[];
  score: "good" | "attention" | "at-risk";
}

interface ParsedAcct {
  account: string; programId: string; mint: string; owner: string; state?: string;
  amount: bigint; decimals: number; uiAmount: number;
  delegate?: string; delegatedAmount?: bigint;
  closeAuthority?: string;
}

async function tokenAccounts(owner: string): Promise<ParsedAcct[]> {
  const c = connection();
  const pk = new PublicKey(owner);
  const out: ParsedAcct[] = [];
  const res = await Promise.all([TOKEN, TOKEN_2022].map((p) => c.getParsedTokenAccountsByOwner(pk, { programId: new PublicKey(p) }).then((r) => ({ p, r }))));
  for (const { p, r } of res) for (const a of r.value) {
    const info = (a.account.data as { parsed?: { info?: {
      mint: string; owner: string; state?: string; closeAuthority?: string; delegate?: string;
      tokenAmount: { amount: string; decimals: number; uiAmount: number | null };
      delegatedAmount?: { amount: string };
    } } }).parsed?.info;
    if (!info?.mint) continue;
    out.push({
      account: a.pubkey.toBase58(), programId: p, mint: info.mint, owner: info.owner, state: info.state,
      amount: BigInt(info.tokenAmount.amount), decimals: info.tokenAmount.decimals, uiAmount: info.tokenAmount.uiAmount ?? 0,
      delegate: info.delegate, delegatedAmount: info.delegatedAmount ? BigInt(info.delegatedAmount.amount) : undefined,
      closeAuthority: info.closeAuthority,
    });
  }
  return out;
}

export interface DelegatedAccount { account: string; programId: string; mint: string; delegate: string; unlimited: boolean }

/** Token accounts with an active delegate (what the revoke-approvals tool revokes). */
export async function delegatedAccounts(owner: string): Promise<DelegatedAccount[]> {
  return (await tokenAccounts(owner))
    .filter((a) => a.delegate && a.owner === owner && a.state !== "frozen")
    .map((a) => ({ account: a.account, programId: a.programId, mint: a.mint, delegate: a.delegate!, unlimited: (a.delegatedAmount ?? BigInt(0)) >= UNLIMITED }));
}

async function symbols(mints: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(mints)];
  for (let i = 0; i < uniq.length; i += 100) {
    try {
      const r = await fetch(`https://api.jup.ag/tokens/v2/search?query=${uniq.slice(i, i + 100).join(",")}`, { headers: jupHeaders(), cache: "no-store", signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      for (const m of (await r.json()) as { id: string; symbol?: string }[]) if (m.symbol) out.set(m.id, m.symbol);
    } catch { /* cosmetic */ }
  }
  return out;
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const fmt = (raw: bigint, decimals: number) => (Number(raw) / 10 ** decimals).toLocaleString("en-US", { maximumFractionDigits: Math.min(decimals, 6) });

export async function runCheckup(owner: string): Promise<Checkup> {
  const [accts, tokens] = await Promise.all([tokenAccounts(owner), walletTokens(owner, { includeSpam: true }).catch(() => [])]);
  const flaggedMints = accts.filter((a) => a.delegate || (a.closeAuthority && a.closeAuthority !== owner) || a.state === "frozen").map((a) => a.mint);
  const sym = flaggedMints.length ? await symbols(flaggedMints) : new Map<string, string>();
  const name = (m: string) => sym.get(m) ?? short(m);
  const findings: Finding[] = [];
  const revoke = { toolId: "revoke-approvals", label: "Revoke" };

  for (const a of accts) {
    if (a.delegate) {
      const amt = a.delegatedAmount ?? BigInt(0);
      const unlimited = amt >= UNLIMITED;
      const coversAll = amt >= a.amount && a.amount > BigInt(0);
      const severity: Severity = unlimited || coversAll ? "high" : a.amount > BigInt(0) ? "medium" : "low";
      findings.push({
        id: `delegate:${a.account}`, kind: "delegate", severity, account: a.account, mint: a.mint, symbol: sym.get(a.mint),
        title: `${unlimited ? "Unlimited" : coversAll ? "Full-balance" : "Partial"} approval on ${name(a.mint)}`,
        detail: `${short(a.delegate)} can move ${unlimited ? "all" : `up to ${fmt(amt, a.decimals)}`} of your ${name(a.mint)} without asking you${a.amount > BigInt(0) ? ` (you hold ${fmt(a.amount, a.decimals)})` : ""}.${a.state === "frozen" ? " The account is frozen, so it can't be revoked right now." : ""}`,
        ...(a.state !== "frozen" ? { fix: revoke } : {}),
      });
    }
    if (a.closeAuthority && a.closeAuthority !== owner) {
      findings.push({
        id: `close:${a.account}`, kind: "close-authority", severity: a.amount > BigInt(0) ? "medium" : "low", account: a.account, mint: a.mint, symbol: sym.get(a.mint),
        title: `Someone else can close your ${name(a.mint)} account`,
        detail: `Close authority is ${short(a.closeAuthority)}, not you. Once the account is empty they can close it and take its rent; if the mint allows it they may also burn or reclaim it. Move the tokens to a fresh account you control if you don't recognise this.`,
      });
    }
    if (a.state === "frozen") {
      findings.push({
        id: `frozen:${a.account}`, kind: "frozen", severity: a.amount > BigInt(0) ? "medium" : "info", account: a.account, mint: a.mint, symbol: sym.get(a.mint),
        title: `${name(a.mint)} account is frozen`,
        detail: `The token's freeze authority has frozen this account${a.amount > BigInt(0) ? ` holding ${fmt(a.amount, a.decimals)} ${name(a.mint)}` : ""}. You can't send or swap it until the issuer unfreezes it. Common with scam tokens and sanctioned stablecoin addresses.`,
      });
    }
  }

  const empties = accts.filter((a) => a.amount === BigInt(0) && a.state !== "frozen" && (!a.closeAuthority || a.closeAuthority === owner));
  if (empties.length >= 3) findings.push({
    id: "empty-accounts", kind: "empty-accounts", severity: "info",
    title: `${empties.length} empty token accounts`,
    detail: `They hold ~${(empties.length * 0.00204).toFixed(4)} SOL of rent and clutter your history (dust/spam often lands in them).`,
    fix: { toolId: "close-empty-accounts", label: "Reclaim" },
  });

  const spam = tokens.filter((t) => t.spam);
  if (spam.length) findings.push({
    id: "spam", kind: "spam", severity: "info",
    title: `${spam.length} likely spam token${spam.length > 1 ? "s" : ""} hidden`,
    detail: `${spam.slice(0, 5).map((t) => t.symbol).join(", ")}${spam.length > 5 ? "…" : ""}. They're excluded from your balance. Never visit links in token names or try to "claim" them — that's how drainers get a signature.`,
  });

  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((x, y) => rank[x.severity] - rank[y.severity]);

  const delegates = findings.filter((f) => f.kind === "delegate");
  const recommendations: string[] = [];
  if (delegates.some((f) => f.severity === "high")) recommendations.push("Revoke unlimited and full-balance approvals now. Legit apps rarely need standing approvals; drainers rely on them.");
  else if (delegates.length) recommendations.push("Revoke approvals you don't recognise or no longer use.");
  if (findings.some((f) => f.kind === "close-authority")) recommendations.push("Move tokens out of accounts whose close authority isn't you, then close those accounts.");
  if (findings.some((f) => f.kind === "frozen" && f.severity !== "info")) recommendations.push("Frozen balances can't move. Don't pay anyone who offers to \"unfreeze\" them — that's a scam.");
  recommendations.push("Only connect your wallet to sites you typed or bookmarked; Tailor flags known phishing domains.");
  recommendations.push("Never sign transactions that use a durable nonce unless you initiated them — they never expire.");
  recommendations.push("Keep your recovery phrase offline. No app, support agent or airdrop ever needs it.");

  const score: Checkup["score"] = findings.some((f) => f.severity === "high") ? "at-risk" : findings.some((f) => f.severity === "medium") ? "attention" : "good";
  return { owner, checkedAt: Date.now(), tokenAccounts: accts.length, findings, recommendations, score };
}
