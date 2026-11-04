/**
 * Token metadata for pickers: Jupiter for icon/price/verification, tokens.xyz for whether
 * the Solana Foundation registry knows it (the checkmark). Registry membership is the
 * stronger signal; Jupiter-verified is shown too.
 */
import { jupHeaders, jupBase } from "@/lib/core/solana";

export interface TokenInfo { mint: string; symbol: string; name: string; icon?: string; price?: number; change24h?: number; registered: boolean; verified: boolean; liquidity?: number }

type Jup = { id: string; symbol: string; name: string; icon?: string; usdPrice?: number; isVerified?: boolean; liquidity?: number; stats24h?: { priceChange?: number } };
const txKey = () => process.env.TOKENS_XYZ_API_KEY;

async function jup(q: string): Promise<Jup[]> {
  const r = await fetch(`${jupBase()}/tokens/v2/search?query=${encodeURIComponent(q)}`, { headers: jupHeaders(), cache: "no-store", signal: AbortSignal.timeout(5000) });
  return r.ok ? ((await r.json()) as Jup[]) : [];
}

const registeredCache = new Map<string, boolean>();
async function registered(mint: string): Promise<boolean> {
  if (registeredCache.has(mint)) return registeredCache.get(mint)!;
  if (!txKey()) return false;
  const r = await fetch(`https://api.tokens.xyz/v1/assets/resolve?mint=${mint}`, { headers: { "x-api-key": txKey()! }, cache: "no-store", signal: AbortSignal.timeout(5000) }).catch(() => null);
  const ok = !!r?.ok && !(await r.json().catch(() => ({})))?.variant?.advisory;
  registeredCache.set(mint, ok);
  return ok;
}

const toInfo = async (t: Jup): Promise<TokenInfo> => ({ mint: t.id, symbol: t.symbol, name: t.name, icon: t.icon, price: t.usdPrice, change24h: t.stats24h?.priceChange, verified: !!t.isVerified, registered: await registered(t.id), liquidity: t.liquidity });

export async function tokenInfo(mint: string): Promise<TokenInfo | null> {
  const t = (await jup(mint)).find((x) => x.id === mint);
  return t ? toInfo(t) : null;
}

/** Search for the To picker: registry assets and Jupiter-verified tokens only, most liquid first. */
export async function searchTokens(q: string): Promise<TokenInfo[]> {
  const fromRegistry = txKey()
    ? await fetch(`https://api.tokens.xyz/v1/assets/search?q=${encodeURIComponent(q)}`, { headers: { "x-api-key": txKey()! }, cache: "no-store", signal: AbortSignal.timeout(5000) })
      .then((r) => (r.ok ? r.json() : { results: [] })).then((j: { results?: { primaryVariant?: { mint: string } }[] }) => (j.results ?? []).map((a) => a.primaryVariant?.mint).filter((m): m is string => !!m).slice(0, 6)).catch(() => [] as string[])
    : [];
  const [byQuery, byMint] = await Promise.all([jup(q), fromRegistry.length ? jup(fromRegistry.join(",")) : Promise.resolve([] as Jup[])]);
  const seen = new Set<string>();
  const list = [...byMint, ...byQuery].filter((t) => (t.isVerified || fromRegistry.includes(t.id)) && !seen.has(t.id) && !!seen.add(t.id));
  const infos = await Promise.all(list.slice(0, 10).map(toInfo));
  return infos.sort((a, b) => Number(b.registered) - Number(a.registered) || (b.liquidity ?? 0) - (a.liquidity ?? 0)).slice(0, 8);
}
