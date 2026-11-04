import { explainTransaction, isAddressLike } from "@/lib/security/explain";

export const maxDuration = 60;

/** POST { tx, owner, origin? } → plain-language explanation + risk + the underlying preview. */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { tx?: string; owner?: string; origin?: string };
  if (!b.tx || !b.owner || !isAddressLike(b.owner)) return Response.json({ error: "Missing tx or owner." }, { status: 400 });
  try { return Response.json(await explainTransaction(b.tx, b.owner, b.origin)); }
  catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 }); }
}
