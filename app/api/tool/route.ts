import { NextResponse } from "next/server";
import { prepareTool } from "@/lib/core/execute";
import { isAddress } from "@/lib/core/solana";

export const maxDuration = 60;

/** POST { owner, toolId, params } → unsigned txs + summary + simulation. */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { owner?: string; toolId?: string; params?: Record<string, string> };
  if (!b.owner || !isAddress(b.owner) || !b.toolId) return NextResponse.json({ error: "Missing owner or toolId." }, { status: 400 });
  try {
    return NextResponse.json(await prepareTool(b.owner, b.toolId, b.params ?? {}));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
