/**
 * DFlow: spot swaps via the Trade API (`GET /order` returns a ready v0 tx) and
 * prediction-market outcome tokens (Kalshi markets tokenized on Solana) via the
 * Prediction Market Metadata API.
 *
 * Keys: DFLOW_API_KEY (x-api-key) unlocks prod quote-api + prediction-markets-api.
 * Without it, swaps fall back to DFlow's keyless dev Trade API
 * (dev-quote-api.dflow.net, rate-limited, meant for testing) and prediction
 * positions are skipped (the metadata API returns 403 without a key).
 */
import { PublicKey } from "@solana/web3.js";
import type { Adapter, BuiltAction, Position, SwapProvider, SwapQuote } from "@/lib/core/types";
import { num, usd } from "@/lib/core/solana";

const KEY = () => process.env.DFLOW_API_KEY ?? "";
const TRADE_API = () => process.env.DFLOW_API_URL || (KEY() ? "https://quote-api.dflow.net" : "https://dev-quote-api.dflow.net");
const META_API = () => process.env.DFLOW_METADATA_API_URL || "https://prediction-markets-api.dflow.net";
const headers = (): Record<string, string> => ({ "content-type": "application/json", ...(KEY() ? { "x-api-key": KEY() } : {}) });

const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

// ---------- trade API ----------

interface DflowOrder {
  inputMint: string; outputMint: string; inAmount: string; outAmount: string; minOutAmount?: string;
  priceImpactPct?: string; routePlan?: { venue?: string }[]; transaction?: string; executionMode?: "sync" | "async";
}

async function order(owner: string, inMint: string, outMint: string, amount: string, slippageBps: number | "auto"): Promise<DflowOrder | null> {
  const qs = new URLSearchParams({ inputMint: inMint, outputMint: outMint, amount, slippageBps: String(slippageBps), userPublicKey: owner });
  const r = await fetch(`${TRADE_API()}/order?${qs}`, { headers: headers(), cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const j = (await r.json()) as DflowOrder;
  return j.transaction && j.outAmount ? j : null;
}

export const dflowSwap: SwapProvider = {
  name: "dflow",
  async quote(owner, inMint, outMint, amount, slippageBps): Promise<SwapQuote | null> {
    try {
      const o = await order(owner, inMint, outMint, amount, slippageBps);
      if (!o || !(BigInt(o.outAmount) > BigInt(0))) return null;
      const at = Date.now();
      const venues = [...new Set((o.routePlan ?? []).map((r) => r.venue).filter(Boolean))] as string[];
      return {
        provider: "dflow", inMint, outMint, inAmount: o.inAmount, outAmount: o.outAmount,
        priceImpactPct: o.priceImpactPct != null ? Number(o.priceImpactPct) * 100 : undefined,
        route: venues.length ? venues.join(" → ") : undefined,
        async build() {
          // The order tx embeds a blockhash; refresh it if the quote is getting old.
          if (Date.now() - at < 20_000) return o.transaction!;
          const fresh = await order(owner, inMint, outMint, amount, slippageBps);
          if (!fresh?.transaction) throw new Error("DFlow quote expired; try again.");
          return fresh.transaction;
        },
      };
    } catch { return null; }
  },
};

// ---------- prediction markets ----------

interface MarketAccount { yesMint: string; noMint: string; marketLedger?: string; redemptionStatus?: string }
interface Market {
  ticker?: string; eventTicker?: string; title?: string; subtitle?: string; yesSubTitle?: string; noSubTitle?: string;
  status?: string; result?: string; closeTime?: number | string; expirationTime?: number | string;
  yesBid?: number | string | null; yesAsk?: number | string | null; noBid?: number | string | null; noAsk?: number | string | null;
  accounts?: Record<string, MarketAccount>;
}

async function post<T>(path: string, body: unknown): Promise<T | null> {
  const r = await fetch(`${META_API()}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  return (await r.json()) as T;
}

/** DFlow quotes prices either as 0–1 dollars or as cents; normalize to 0–1. */
const prob = (v: unknown): number | undefined => {
  const x = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(x) || x < 0) return undefined;
  return x > 1 ? x / 100 : x;
};
const ts = (v: unknown) => (typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : typeof v === "string" ? Date.parse(v) : NaN);

export const dflowAdapter: Adapter = {
  protocol: "dflow",
  name: "DFlow",

  async positions(owner, ctx) {
    if (!KEY()) return []; // metadata API is key-gated
    const pk = new PublicKey(owner);
    const accts = (await Promise.all(TOKEN_PROGRAMS.map((p) => ctx.connection.getParsedTokenAccountsByOwner(pk, { programId: new PublicKey(p) }).catch(() => ({ value: [] })))))
      .flatMap((r) => r.value)
      .map((a) => a.account.data.parsed.info as { mint: string; tokenAmount: { amount: string; decimals: number; uiAmount: number } })
      .filter((i) => Number(i.tokenAmount.amount) > 0);
    if (!accts.length) return [];
    const balances = new Map<string, { raw: string; decimals: number; ui: number }>();
    for (const a of accts) balances.set(a.mint, { raw: a.tokenAmount.amount, decimals: a.tokenAmount.decimals, ui: a.tokenAmount.uiAmount });

    const f = await post<{ outcomeMints?: string[] }>("/api/v1/filter_outcome_mints", { addresses: [...balances.keys()] });
    const mints = f?.outcomeMints ?? [];
    if (!mints.length) return [];
    const b = await post<{ markets?: Market[] }>("/api/v1/markets/batch", { mints });
    const markets = b?.markets ?? [];

    const out: Position[] = [];
    const now = Date.now();
    for (const mint of mints) {
      const m = markets.find((x) => Object.values(x.accounts ?? {}).some((a) => a.yesMint === mint || a.noMint === mint));
      const bal = balances.get(mint);
      if (!m || !bal) continue;
      const [settleMint, acct] = Object.entries(m.accounts ?? {}).find(([, a]) => a.yesMint === mint || a.noMint === mint)!;
      const side: "yes" | "no" = acct.yesMint === mint ? "yes" : "no";
      const shares = bal.ui;
      const status = (m.status ?? "").toLowerCase();
      const resolved = status === "determined" || status === "finalized" || !!m.result;
      const won = resolved && (m.result ?? "").toLowerCase() === side;
      const redeemOpen = (acct.redemptionStatus ?? "").toLowerCase() === "open";
      const bid = prob(side === "yes" ? m.yesBid : m.noBid);
      const ask = prob(side === "yes" ? m.yesAsk : m.noAsk);
      const price = resolved ? (won ? 1 : 0) : bid != null && ask != null ? (bid + ask) / 2 : (bid ?? ask ?? 0);
      const value = shares * (resolved ? price : (bid ?? price)); // what you could actually sell for
      const outcomeLabel = (side === "yes" ? m.yesSubTitle : m.noSubTitle) || side.toUpperCase();
      const settleSym = settleMint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" ? "USDC" : settleMint.slice(0, 4);
      const close = ts(m.closeTime ?? m.expirationTime);

      const actions: Position["actions"] = [];
      if (resolved && won && redeemOpen) actions.push({ id: "redeem", label: `Redeem for ${settleSym}`, intent: "claim" });
      else if (!resolved && status !== "closed") actions.push({
        id: "sell", label: "Sell shares", intent: "close",
        fields: [{ name: "shares", label: "Shares", kind: "amount", max: shares, default: String(shares) }, { name: "slippage", label: "Slippage %", kind: "percent", default: "2" }],
      });

      out.push({
        id: `dflow:${mint}`,
        protocol: "dflow", kind: "prediction",
        title: m.title ?? m.ticker ?? "Prediction market",
        subtitle: `${side.toUpperCase()} · ${outcomeLabel}`,
        valueUsd: value,
        legs: [{ side: "hold", symbol: `${side.toUpperCase()} ${m.ticker ?? ""}`.trim(), mint, amount: shares, valueUsd: value }],
        metrics: [
          { label: "Shares", value: num(shares, 2) },
          { label: resolved ? "Result" : "Price", value: resolved ? (m.result ?? "").toUpperCase() || "Resolved" : `${Math.round(price * 100)}¢` },
          { label: "Value", value: usd(value) },
          { label: "Status", value: resolved ? (won ? (redeemOpen ? "Won · redeemable" : "Won · redemption pending") : "Lost") : status || "active", tone: won ? "pos" : resolved ? "neg" : undefined },
          ...(Number.isFinite(close) && !resolved ? [{ label: "Closes", value: new Date(close).toISOString().slice(0, 10) }] : []),
        ],
        risk: resolved && won ? { level: "watch", score: redeemOpen ? 55 : 40, reason: redeemOpen ? `Market resolved ${side.toUpperCase()} — redeem ${num(shares, 2)} shares for ${settleSym}` : "Resolved in your favour; redemption not open yet" }
          : resolved ? { level: "ok", score: 5, reason: "Market resolved against this outcome" }
          : { level: "ok", score: Math.min(20, Math.round(value / 500)) },
        actions,
        url: m.eventTicker ? `https://kalshi.com/markets/${m.eventTicker.toLowerCase()}` : undefined,
        raw: { mint, side, settleMint, rawAmount: bal.raw, decimals: bal.decimals, shares, price, bid: bid ?? null, ask: ask ?? null, status, result: m.result ?? null, redemptionStatus: acct.redemptionStatus ?? null, ticker: m.ticker ?? null, claimsMints: [mint] },
        updatedAt: now,
      });
    }
    return out;
  },

  async build(owner, position, actionId, params): Promise<BuiltAction> {
    const raw = position.raw as { mint: string; settleMint: string; rawAmount: string; decimals: number; shares: number; side: string };
    if (actionId !== "sell" && actionId !== "redeem") throw new Error(`Unknown DFlow action ${actionId}`);
    let amount = raw.rawAmount;
    if (actionId === "sell" && params.shares) {
      const s = Number(params.shares);
      if (!(s > 0)) throw new Error("Enter a number of shares.");
      amount = BigInt(Math.min(Number(raw.rawAmount), Math.floor(s * 10 ** raw.decimals))).toString();
    }
    const slip = actionId === "sell" ? Math.round((Number(params.slippage ?? "2") || 2) * 100) : 50;
    const o = await order(owner, raw.mint, raw.settleMint, amount, slip);
    if (!o?.transaction) throw new Error("DFlow returned no route for this outcome token.");
    const outUi = Number(o.outAmount) / 1e6;
    const shares = Number(amount) / 10 ** raw.decimals;
    return {
      txs: [o.transaction],
      summary: actionId === "redeem"
        ? `Redeem ${num(shares, 2)} winning ${raw.side.toUpperCase()} shares for ~${usd(outUi)}.`
        : `Sell ${num(shares, 2)} ${raw.side.toUpperCase()} shares for ~${usd(outUi)} via DFlow.`,
      warnings: o.executionMode === "async" ? ["DFlow fills prediction-market orders asynchronously; proceeds may take a few seconds to arrive."] : undefined,
    };
  },
};
