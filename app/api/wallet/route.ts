import { NextResponse } from "next/server";
import { allTools } from "@/lib/adapters";
import { getSnapshot } from "@/lib/core/cache";
import { isAddress } from "@/lib/core/solana";
import { load } from "@/lib/core/store";
import { fingerprint } from "@/lib/genui/generate";

export const maxDuration = 60;

/**
 * GET /api/wallet?owner=…&fresh=1 → snapshot + tools + the saved page if it still
 * matches the wallet's positions (page: null means the client should stream a new one).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const owner = url.searchParams.get("owner") ?? "";
  if (!isAddress(owner)) return NextResponse.json({ error: "Not a valid Solana address." }, { status: 400 });
  try {
    const snap = await getSnapshot(owner, url.searchParams.get("fresh") === "1");
    const saved = await load(owner);
    const tools = allTools().map(({ adapter: _a, ...t }) => t);
    const page = saved.layout && saved.fingerprint === fingerprint(snap) ? saved.layout : null;
    return NextResponse.json({ snapshot: snap, tools, page, prefs: saved.prefs });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
