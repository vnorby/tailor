import { isAddress, walletTokens } from "@/lib/core/solana";

/** Fast balances for the extension popup (no protocol reads, no AI). */
export async function GET(req: Request) {
  const owner = new URL(req.url).searchParams.get("owner") ?? "";
  if (!isAddress(owner)) return Response.json({ error: "Not a valid Solana address." }, { status: 400 });
  try {
    const tokens = await walletTokens(owner);
    return Response.json({ tokens, totalUsd: tokens.reduce((s, t) => s + (t.valueUsd ?? 0), 0) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
