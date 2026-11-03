/**
 * Jupiter Metis routing via /swap/v1 (quote → swap). The returned tx is a plain
 * user-signed v0 transaction, so it goes through any RPC — unlike /swap/v2/order
 * whose RFQ fills must land through Jupiter's /execute. Falls back to
 * /swap/v2/build (raw instructions, same Metis engine) if v1 is unavailable.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { SwapProvider, SwapQuote } from "@/lib/core/types";
import { buildTx, lookupTables } from "@/lib/core/solana";
import { JUP, jfetch, n } from "./http";

interface V1Quote { inAmount: string; outAmount: string; priceImpactPct?: string; routePlan?: { swapInfo?: { label?: string } }[]; errorCode?: string; error?: string }
interface ApiIx { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }
interface V2Build extends V1Quote {
  computeBudgetInstructions?: ApiIx[]; setupInstructions?: ApiIx[]; swapInstruction?: ApiIx; cleanupInstruction?: ApiIx | null;
  otherInstructions?: ApiIx[]; addressLookupTableAddresses?: string[] | Record<string, unknown>;
}

const toIx = (i: ApiIx) => new TransactionInstruction({
  programId: new PublicKey(i.programId),
  keys: i.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
  data: Buffer.from(i.data, "base64"),
});

const routeLabel = (q: V1Quote) => {
  const labels = [...new Set((q.routePlan ?? []).map((r) => r.swapInfo?.label).filter(Boolean))] as string[];
  return labels.length ? labels.slice(0, 3).join(" → ") + (labels.length > 3 ? " …" : "") : undefined;
};

export async function swapTxFromQuote(owner: string, quote: unknown): Promise<string> {
  const r = await jfetch<{ swapTransaction?: string; simulationError?: unknown; error?: string }>(`${JUP}/swap/v1/swap`, {
    body: {
      quoteResponse: quote, userPublicKey: owner, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: "high" } },
    },
    timeoutMs: 12_000,
  });
  if (!r.swapTransaction) throw new Error(r.error ?? "Jupiter returned no swap transaction.");
  return r.swapTransaction;
}

async function v2Quote(owner: string, inMint: string, outMint: string, amount: string, slippageBps: number): Promise<SwapQuote | null> {
  const b = await jfetch<V2Build>(`${JUP}/swap/v2/build?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${slippageBps}&taker=${owner}`);
  if (!b.swapInstruction || !b.outAmount) return null;
  return {
    provider: "jupiter", inMint, outMint, inAmount: b.inAmount, outAmount: b.outAmount,
    priceImpactPct: n(b.priceImpactPct) * 100, route: routeLabel(b),
    async build() {
      const lutAddrs = Array.isArray(b.addressLookupTableAddresses) ? b.addressLookupTableAddresses : Object.keys(b.addressLookupTableAddresses ?? {});
      const ixs = [...(b.computeBudgetInstructions ?? []), ...(b.setupInstructions ?? []), b.swapInstruction!, ...(b.cleanupInstruction ? [b.cleanupInstruction] : []), ...(b.otherInstructions ?? [])].map(toIx);
      return buildTx(owner, ixs, { luts: await lookupTables(lutAddrs) });
    },
  };
}

export const jupiterSwap: SwapProvider = {
  name: "jupiter",
  async quote(owner, inMint, outMint, amount, slippageBps) {
    try {
      const q = await jfetch<V1Quote>(`${JUP}/swap/v1/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`);
      if (!q.outAmount) return null;
      return {
        provider: "jupiter", inMint, outMint, inAmount: q.inAmount, outAmount: q.outAmount,
        priceImpactPct: n(q.priceImpactPct) * 100, route: routeLabel(q),
        build: () => swapTxFromQuote(owner, q),
      };
    } catch {
      try { return await v2Quote(owner, inMint, outMint, amount, slippageBps); } catch { return null; }
    }
  },
};
