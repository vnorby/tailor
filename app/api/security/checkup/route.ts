import { NextResponse } from "next/server";
import { isAddress } from "@/lib/core/solana";
import { runCheckup } from "@/lib/security/checkup";

export const maxDuration = 30;

/** GET ?owner= → { findings: delegates/approvals, foreign close authorities, frozen accounts…, recommendations, score }. */
export async function GET(req: Request) {
  const owner = new URL(req.url).searchParams.get("owner") ?? "";
  if (!isAddress(owner)) return NextResponse.json({ error: "Expected ?owner=<wallet address>" }, { status: 400 });
  try {
    return NextResponse.json(await runCheckup(owner), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
