/**
 * Market discovery for the agent: what's trending / most traded / best organic activity
 * (Jupiter), curated asset lists with stats (tokens.xyz: crypto majors, stocks, ETFs, metals,
 * treasuries), and search. Rows are compact so the model can rank and render them.
 */
import { jupHeaders, jupBase } from "@/lib/core/solana";

export const MARKET_TOOL = {
  name: "market_data",
  description: "Discover and rank tokens/assets with live stats. source: 'trending' | 'top_traded' | 'top_organic' (Jupiter, verified tokens; window 1h/6h/24h), 'list' (tokens.xyz curated: list = majors | stocks | etfs | metals | rwas | currencies), or 'search' (query). Optional sort: volume | change | marketcap | liquidity. Returns mint, symbol, price, 24h change %, volume, market cap, liquidity, verified.",
  input_schema: {
    type: "object",
    properties: {
      source: { type: "string", enum: ["trending", "top_traded", "top_organic", "list", "search"] },
      list: { type: "string" }, query: { type: "string" }, window: { type: "string", enum: ["1h", "6h", "24h"] },
      sort: { type: "string", enum: ["volume", "change", "marketcap", "liquidity"] }, limit: { type: "number" },
    },
    required: ["source"],
  },
} as const;

interface Row { mint: string; symbol: string; name: string; price?: number; change24h?: number; volume24h?: number; marketCap?: number; liquidity?: number; verified: boolean; category?: string }
type Jup = { id: string; symbol: string; name: string; usdPrice?: number; isVerified?: boolean; liquidity?: number; mcap?: number; stats24h?: { priceChange?: number; buyVolume?: number; sellVolume?: number }; tags?: string[] };
type TxAsset = { symbol: string; name: string; category: string; stats?: { price?: number; priceChange24hPercent?: number; volume24hUSD?: number; marketCap?: number; liquidity?: number }; primaryVariant?: { mint: string; symbol: string } };

const fromJup = (t: Jup): Row => ({
  mint: t.id, symbol: t.symbol, name: t.name, price: t.usdPrice, change24h: t.stats24h?.priceChange, liquidity: t.liquidity, marketCap: t.mcap,
  volume24h: (t.stats24h?.buyVolume ?? 0) + (t.stats24h?.sellVolume ?? 0) || undefined, verified: !!t.isVerified, category: t.tags?.includes("stocks") ? "stock" : undefined,
});
const fromTx = (a: TxAsset): Row | null => a.primaryVariant?.mint ? ({
  mint: a.primaryVariant.mint, symbol: a.primaryVariant.symbol ?? a.symbol, name: a.name, price: a.stats?.price, change24h: a.stats?.priceChange24hPercent,
  volume24h: a.stats?.volume24hUSD, marketCap: a.stats?.marketCap, liquidity: a.stats?.liquidity, verified: true, category: a.category,
}) : null;

async function get<T>(url: string, headers: Record<string, string>): Promise<T | null> {
  const r = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(8000) }).catch(() => null);
  return r?.ok ? ((await r.json()) as T) : null;
}

export async function marketData(input: Record<string, unknown>): Promise<string> {
  const limit = Math.min(50, Math.max(1, Number(input.limit) || 20));
  const window = ["1h", "6h", "24h"].includes(String(input.window)) ? String(input.window) : "24h";
  const tx = { "x-api-key": process.env.TOKENS_XYZ_API_KEY ?? "" };
  let rows: Row[] = [];
  switch (input.source) {
    case "trending": case "top_traded": case "top_organic": {
      const path = { trending: "toptrending", top_traded: "toptraded", top_organic: "toporganicscore" }[input.source as string];
      rows = ((await get<Jup[]>(`${jupBase()}/tokens/v2/${path}/${window}?limit=${Math.min(100, limit * 3)}`, jupHeaders())) ?? []).filter((t) => t.isVerified).map(fromJup);
      break;
    }
    case "list": {
      const list = String(input.list ?? "majors").replace(/[^a-z_-]/g, "");
      const j = await get<{ assets?: TxAsset[] }>(`https://api.tokens.xyz/v1/assets/curated?list=${list}&limit=100`, tx);
      rows = (j?.assets ?? []).map(fromTx).filter((r): r is Row => !!r);
      break;
    }
    case "search": {
      const q = encodeURIComponent(String(input.query ?? "").slice(0, 64));
      const [a, b] = await Promise.all([get<{ results?: TxAsset[] }>(`https://api.tokens.xyz/v1/assets/search?q=${q}`, tx), get<Jup[]>(`${jupBase()}/tokens/v2/search?query=${q}`, jupHeaders())]);
      const seen = new Set<string>();
      rows = [...(a?.results ?? []).map(fromTx).filter((r): r is Row => !!r), ...(b ?? []).filter((t) => t.isVerified).map(fromJup)].filter((r) => !seen.has(r.mint) && !!seen.add(r.mint));
      break;
    }
    default: return "Unknown source.";
  }
  const key = { volume: "volume24h", change: "change24h", marketcap: "marketCap", liquidity: "liquidity" }[String(input.sort)] as keyof Row | undefined;
  if (key) rows.sort((x, y) => Number(y[key] ?? -Infinity) - Number(x[key] ?? -Infinity));
  const round = (v?: number) => (v == null ? undefined : Number(v.toPrecision(4)));
  return JSON.stringify(rows.slice(0, limit).map((r) => ({ ...r, price: round(r.price), change24h: round(r.change24h), volume24h: round(r.volume24h), marketCap: round(r.marketCap), liquidity: round(r.liquidity) })));
}
