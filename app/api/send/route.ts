import { NextResponse } from "next/server";
import { VersionedTransaction } from "@solana/web3.js";
import { invalidate } from "@/lib/core/cache";
import { confirm, sendSigned } from "@/lib/core/solana";

export const maxDuration = 60;

/** POST { owner, tx } where tx is a wallet-signed base64 transaction → { signature, ok, error? }. */
export async function POST(req: Request) {
  const { owner, tx } = (await req.json().catch(() => ({}))) as { owner?: string; tx?: string };
  if (!tx || !owner) return NextResponse.json({ error: "Missing tx." }, { status: 400 });
  try {
    const parsed = VersionedTransaction.deserialize(Buffer.from(tx, "base64"));
    if (parsed.message.staticAccountKeys[0]?.toBase58() !== owner) return NextResponse.json({ error: "Fee payer doesn't match this wallet." }, { status: 400 });
    const signature = await sendSigned(tx);
    const res = await confirm(signature);
    invalidate(owner);
    return NextResponse.json({ signature, ...res });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
