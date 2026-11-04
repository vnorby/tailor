/**
 * The shared "swap" tool: asks Jupiter, Titan and DFlow for a quote in parallel
 * and builds the transaction from whichever returns the most output.
 */
import type { Adapter, Ctx, SwapQuote } from "@/lib/core/types";
import { jupiterSwap } from "./jupiter";
import { titanSwap } from "./titan";
import { dflowSwap } from "./dflow";
import { connection, isAddress, jupHeaders, num, jupBase } from "@/lib/core/solana";
import { PublicKey } from "@solana/web3.js";

const PROVIDERS = [jupiterSwap, titanSwap, dflowSwap];

async function resolveMint(input: string, ctx: Ctx): Promise<{ mint: string; decimals: number; symbol: string }> {
  const s = input.trim();
  const t = ctx.tokens.find((x) => x.mint === s) ?? ctx.tokens.find((x) => x.symbol.toLowerCase() === s.toLowerCase());
  if (t) return { mint: t.mint, decimals: t.decimals, symbol: t.symbol };
  const known: Record<string, { mint: string; decimals: number }> = {
    sol: { mint: "So11111111111111111111111111111111111111112", decimals: 9 },
    usdc: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
    usdt: { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
    jup: { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", decimals: 6 },
    jitosol: { mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", decimals: 9 },
  };
  const k = known[s.toLowerCase()];
  if (k) return { ...k, symbol: s.toUpperCase() };
  // Any other mint (e.g. a token suggested from the page you're reading): decimals from chain, symbol from Jupiter.
  if (isAddress(s)) {
    const info = await connection().getParsedAccountInfo(new PublicKey(s));
    const decimals = (info.value?.data as { parsed?: { type?: string; info?: { decimals?: number } } } | undefined)?.parsed;
    if (decimals?.type === "mint" && typeof decimals.info?.decimals === "number") {
      const meta = await fetch(`${jupBase()}/tokens/v2/search?query=${s}`, { headers: jupHeaders(), cache: "no-store", signal: AbortSignal.timeout(4000) })
        .then((r) => r.json() as Promise<{ id: string; symbol: string }[]>).then((l) => l.find((x) => x.id === s)?.symbol).catch(() => undefined);
      return { mint: s, decimals: decimals.info.decimals, symbol: meta ?? `${s.slice(0, 4)}…` };
    }
  }
  throw new Error(`Unknown token "${input}". Use a symbol you hold or a mint address.`);
}

const STABLES = new Set(["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);
const MAJORS = new Set(["So11111111111111111111111111111111111111112", ...STABLES, "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"]);
/** Auto slippage: tight between stables, normal for majors, looser for the long tail. */
function autoSlippage(a: string, b: string, _ctx: Ctx): number {
  if (STABLES.has(a) && STABLES.has(b)) return 10;
  if (MAJORS.has(a) && MAJORS.has(b)) return 30;
  return MAJORS.has(a) || MAJORS.has(b) ? 100 : 200;
}

export async function bestQuote(owner: string, params: Record<string, string>, ctx: Ctx): Promise<{ best: SwapQuote; all: SwapQuote[]; inSym: string; outSym: string; outDecimals: number }> {
  const [from, to] = await Promise.all([resolveMint(params.from ?? "", ctx), resolveMint(params.to ?? "", ctx)]);
  const amountUi = Number(params.amount);
  if (!(amountUi > 0)) throw new Error("Enter an amount greater than zero.");
  const atomic = BigInt(Math.floor(amountUi * 10 ** from.decimals)).toString();
  const slippageBps = params.slippage && params.slippage !== "auto" ? Math.round(Number(params.slippage) * 100) || 50 : autoSlippage(from.mint, to.mint, ctx);
  const quotes = (await Promise.all(PROVIDERS.map((p) => p.quote(owner, from.mint, to.mint, atomic, slippageBps).catch(() => null)))).filter((q): q is SwapQuote => !!q);
  if (!quotes.length) throw new Error("No route found on Jupiter, Titan or DFlow.");
  quotes.sort((a, b) => (BigInt(b.outAmount) > BigInt(a.outAmount) ? 1 : -1));
  return { best: quotes[0], all: quotes, inSym: from.symbol, outSym: to.symbol, outDecimals: to.decimals };
}

export const swapAdapter: Adapter = {
  protocol: "wallet",
  name: "Swap",
  async positions() { return []; },
  tools: [{
    id: "swap", protocol: "wallet", label: "Swap",
    description: "Swap any token for another; routes across Jupiter, Titan and DFlow and takes the best price.",
    fields: [
      { name: "from", label: "From", kind: "text", default: "SOL" },
      { name: "to", label: "To", kind: "text", default: "USDC" },
      { name: "amount", label: "Amount", kind: "amount" },
      { name: "slippage", label: "Slippage %", kind: "percent", default: "auto" },
    ],
  }],
  async buildTool(owner, toolId, params, ctx) {
    if (toolId !== "swap") throw new Error(`Unknown tool ${toolId}`);
    const { best, all, inSym, outSym, outDecimals } = await bestQuote(owner, params, ctx);
    const out = Number(best.outAmount) / 10 ** outDecimals;
    const others = all.slice(1).map((q) => `${q.provider} ${num(Number(q.outAmount) / 10 ** outDecimals)}`).join(", ");
    return {
      txs: [await best.build()],
      summary: `Swap ${params.amount} ${inSym} → ~${num(out)} ${outSym} via ${best.provider}${best.route ? ` (${best.route})` : ""}.`,
      warnings: [
        ...(best.priceImpactPct && best.priceImpactPct > 1 ? [`Price impact ${best.priceImpactPct.toFixed(2)}%.`] : []),
        ...(others ? [`Other quotes: ${others}.`] : []),
      ],
    };
  },
};
