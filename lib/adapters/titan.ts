/**
 * Titan Exchange swap aggregator. Titan has no user positions, so the adapter is
 * empty; `titanSwap` quotes through Titan's Developers Portal REST API
 * (GET /api/v1/quote/swap, JSON, `x-api-key`). The response carries raw
 * instructions + ALT addresses, which we compile into an unsigned v0 tx.
 *
 * Needs TITAN_API_KEY (developer.titan.exchange). Without it quote() returns null.
 * TITAN_API_URL may point at a distributor gateway instead (then the key is sent
 * as a Bearer token).
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { Adapter, SwapProvider, SwapQuote } from "@/lib/core/types";
import { buildTx, lookupTables } from "@/lib/core/solana";

export const titanAdapter: Adapter = {
  protocol: "titan",
  name: "Titan",
  async positions() { return []; },
};

interface TitanIx { p: string; a: { p: string; s: boolean; w: boolean }[]; d: string }
interface TitanRoute {
  inAmount: string | number; outAmount: string | number; slippageBps?: number; priceImpactPct?: number;
  steps?: { label?: string; venue?: string; dex?: string }[];
  instructions: TitanIx[]; addressLookupTables?: string[]; computeUnits?: number; computeUnitsSafe?: number;
  expiresAtMs?: number;
}
interface TitanQuotes { quotes?: Record<string, TitanRoute>; metadata?: { ExpectedWinner?: string } }

const toIx = (ix: TitanIx) => new TransactionInstruction({
  programId: new PublicKey(ix.p),
  keys: ix.a.map((k) => ({ pubkey: new PublicKey(k.p), isSigner: k.s, isWritable: k.w })),
  data: Buffer.from(ix.d, "base64"),
});

async function fetchQuote(owner: string, inMint: string, outMint: string, amount: string, slippageBps: number): Promise<TitanRoute | null> {
  const key = process.env.TITAN_API_KEY;
  if (!key) return null;
  const base = process.env.TITAN_API_URL || "https://portal.api.titan.exchange";
  const portal = base.includes("portal.api.titan.exchange");
  const qs = new URLSearchParams({
    inputMint: inMint, outputMint: outMint, amount, userPublicKey: owner, slippageBps: String(slippageBps),
    addSizeConstraint: "true", createOutputTokenAccount: "true",
  });
  const r = await fetch(`${base}/api/v1/quote/swap?${qs}`, {
    headers: { accept: "application/json", ...(portal ? { "x-api-key": key } : { authorization: `Bearer ${key}` }) },
    cache: "no-store", signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const j = (await r.json()) as TitanQuotes;
  const entries = Object.entries(j.quotes ?? {}).filter(([, q]) => q?.instructions?.length);
  if (!entries.length) return null;
  const winner = j.metadata?.ExpectedWinner;
  const pick = entries.find(([id]) => id === winner) ?? entries.sort((a, b) => (BigInt(b[1].outAmount) > BigInt(a[1].outAmount) ? 1 : -1))[0];
  return { ...pick[1], steps: pick[1].steps ?? [{ label: pick[0] }] };
}

export const titanSwap: SwapProvider = {
  name: "titan",
  async quote(owner, inMint, outMint, amount, slippageBps): Promise<SwapQuote | null> {
    try {
      const q = await fetchQuote(owner, inMint, outMint, amount, slippageBps);
      if (!q || !(BigInt(q.outAmount) > BigInt(0))) return null;
      const labels = [...new Set((q.steps ?? []).map((s) => s.label ?? s.venue ?? s.dex).filter(Boolean))] as string[];
      return {
        provider: "titan", inMint, outMint,
        inAmount: String(q.inAmount ?? amount), outAmount: String(q.outAmount),
        priceImpactPct: q.priceImpactPct,
        route: labels.length ? labels.join(" → ") : undefined,
        async build() {
          const luts = q.addressLookupTables?.length ? await lookupTables(q.addressLookupTables) : [];
          return buildTx(owner, q.instructions.map(toIx), { luts, cuLimit: q.computeUnitsSafe ?? (q.computeUnits ? Math.ceil(q.computeUnits * 1.3) : 400_000) });
        },
      };
    } catch { return null; }
  },
};
