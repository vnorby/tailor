import { NextResponse } from "next/server";
import { prepareAction } from "@/lib/core/execute";
import { isAddress } from "@/lib/core/solana";

export const maxDuration = 60;

/** POST { owner, positionId, actionId, params } → unsigned txs + summary + simulation. */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { owner?: string; positionId?: string; actionId?: string; params?: Record<string, string> };
  if (!b.owner || !isAddress(b.owner) || !b.positionId || !b.actionId) return NextResponse.json({ error: "Missing owner, positionId or actionId." }, { status: 400 });
  try {
    return NextResponse.json(await prepareAction(b.owner, b.positionId, b.actionId, b.params ?? {}));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
