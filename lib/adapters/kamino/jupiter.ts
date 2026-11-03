/**
 * Jupiter quoter + swapper in the shape klend-sdk's leverage / repay-with-collateral
 * builders expect. Lookup tables are collected into `luts` (addresses) so the caller
 * can compile the final v0 tx with web3.js.
 */
import { address, type Instruction } from "@solana/kit";
import Decimal from "decimal.js";
import { jupHeaders } from "@/lib/core/solana";

const base = () => (process.env.JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1");

interface JupIx { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }
interface JupQuote { inAmount: string; outAmount: string; [k: string]: unknown }

const toKit = (ix: JupIx): Instruction => ({
  programAddress: address(ix.programId),
  accounts: ix.accounts.map((a) => ({ address: address(a.pubkey), role: (a.isSigner ? 2 : 0) | (a.isWritable ? 1 : 0) })),
  data: new Uint8Array(Buffer.from(ix.data, "base64")),
}) as Instruction;

/** Jupiter's keyless endpoint rate-limits bursts; back off briefly on 429. */
async function jfetch(url: string, init: RequestInit = {}): Promise<Response> {
  let r: Response | null = null;
  for (let i = 0; i < 4; i++) {
    r = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (r.status !== 429) return r;
    await new Promise((res) => setTimeout(res, 700 * (i + 1)));
  }
  return r!;
}

interface SwapInputs { inputAmountLamports: Decimal; minOutAmountLamports?: Decimal; inputMint: string; outputMint: string }

export function jupiterSwapper(owner: string, decimals: Record<string, number>, slippageBps: number, maxAccounts = 28) {
  const luts = new Set<string>();

  async function quote(inp: SwapInputs): Promise<JupQuote> {
    const amount = inp.inputAmountLamports.floor().toFixed(0);
    const q = new URLSearchParams({
      inputMint: inp.inputMint, outputMint: inp.outputMint, amount, slippageBps: String(slippageBps),
      maxAccounts: String(maxAccounts), swapMode: "ExactIn",
    });
    const r = await jfetch(`${base()}/quote?${q}`, { headers: jupHeaders() });
    if (!r.ok) throw new Error(`Jupiter quote failed (${r.status}): ${(await r.text()).slice(0, 160)}`);
    return (await r.json()) as JupQuote;
  }

  const priceAInB = (inp: SwapInputs, q: JupQuote) => {
    const dIn = decimals[inp.inputMint] ?? 0, dOut = decimals[inp.outputMint] ?? 0;
    return new Decimal(q.outAmount).div(10 ** dOut).div(new Decimal(q.inAmount).div(10 ** dIn));
  };

  const quoter = async (inp: SwapInputs) => {
    const q = await quote(inp);
    return { priceAInB: priceAInB(inp, q), quoteResponse: q };
  };

  const swapper = async (inp: SwapInputs) => {
    const q = await quote(inp); // re-quote for the exact sized input
    const r = await jfetch(`${base()}/swap-instructions`, {
      method: "POST", headers: { "content-type": "application/json", ...jupHeaders() },
      body: JSON.stringify({ quoteResponse: q, userPublicKey: owner, wrapAndUnwrapSol: false, useSharedAccounts: true, dynamicComputeUnitLimit: false }),
    });
    if (!r.ok) throw new Error(`Jupiter swap-instructions failed (${r.status}): ${(await r.text()).slice(0, 160)}`);
    const j = (await r.json()) as { setupInstructions?: JupIx[]; swapInstruction: JupIx; cleanupInstruction?: JupIx; addressLookupTableAddresses?: string[] };
    for (const a of j.addressLookupTableAddresses ?? []) luts.add(a);
    return [{
      preActionIxs: [] as Instruction[],
      swapIxs: [...(j.setupInstructions ?? []), j.swapInstruction, ...(j.cleanupInstruction ? [j.cleanupInstruction] : [])].map(toKit),
      lookupTables: [],
      quote: { priceAInB: priceAInB(inp, q), quoteResponse: q },
    }];
  };

  return { quoter, swapper, luts };
}
