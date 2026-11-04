import { isAddress } from "@/lib/core/solana";
import { searchTokens, tokenInfo } from "@/lib/tokeninfo";

/** GET ?mint=… → TokenInfo, or ?q=… → TokenInfo[] (registered / verified only). */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const mint = u.searchParams.get("mint") ?? "", q = (u.searchParams.get("q") ?? "").trim().slice(0, 64);
  if (mint) return isAddress(mint) ? Response.json(await tokenInfo(mint)) : Response.json({ error: "Bad mint." }, { status: 400 });
  if (q) return Response.json(await searchTokens(q), { headers: { "cache-control": "private, max-age=60" } });
  return Response.json({ error: "Expected ?mint= or ?q=" }, { status: 400 });
}
