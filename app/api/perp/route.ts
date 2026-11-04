import { perpMarket, perpMarkets } from "@/lib/adapters/phoenix";

/** GET ?market=BTC → live market (mark, 24h, funding, max leverage); GET ?list=1 → active markets. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  try {
    if (u.searchParams.get("list")) return Response.json(await perpMarkets(), { headers: { "cache-control": "private, max-age=300" } });
    return Response.json(await perpMarket((u.searchParams.get("market") ?? "BTC").slice(0, 16)));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
}
