import { getSnapshot } from "@/lib/core/cache";
import { isAddress } from "@/lib/core/solana";
import { suggest, type PageRead } from "@/lib/suggest";

export const maxDuration = 30;

/** POST { owner, page } → { suggestions, markets }: what on the page the user is reading is tradable on Solana. */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { owner?: string; page?: Partial<PageRead> };
  const p = b.page;
  if (!isAddress(b.owner ?? "") || !p || typeof p.url !== "string" || typeof p.text !== "string") return Response.json({ error: "Bad request." }, { status: 400 });
  const strs = (v: unknown, n: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, n).map((x) => x.slice(0, 64)) : []);
  const page: PageRead = { url: p.url.slice(0, 300), title: String(p.title ?? "").slice(0, 200), selection: String(p.selection ?? "").slice(0, 1000), text: p.text.slice(0, 5000), cashtags: strs(p.cashtags, 12), addresses: strs(p.addresses, 12) };
  try {
    const snap = await getSnapshot(b.owner!, false);
    const { tokens, markets } = await suggest(page, new Map(snap.tokens.map((t) => [t.mint, t.amount])));
    return Response.json({ suggestions: tokens, markets });
  } catch (e) {
    return Response.json({ suggestions: [], markets: [], error: e instanceof Error ? e.message : String(e) });
  }
}
