import { NextResponse } from "next/server";
import { getSnapshot } from "@/lib/core/cache";
import { compose, fingerprint } from "@/lib/core/compose";
import { isAddress } from "@/lib/core/solana";
import { load, save } from "@/lib/core/store";
import { allTools } from "@/lib/adapters";

export const maxDuration = 120;

/** GET /api/wallet?owner=…&fresh=1 → snapshot + layout (re-composed when positions changed). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const owner = url.searchParams.get("owner") ?? "";
  if (!isAddress(owner)) return NextResponse.json({ error: "Not a valid Solana address." }, { status: 400 });
  try {
    const snap = await getSnapshot(owner, url.searchParams.get("fresh") === "1");
    const saved = await load(owner);
    const fp = fingerprint(snap);
    let { layout, prefs } = saved;
    let reply: string | undefined;
    if (!layout || saved.fingerprint !== fp) {
      ({ layout, prefs, reply } = await compose(snap, prefs, layout));
      await save(owner, { layout, prefs, fingerprint: fp });
    }
    const tools = allTools().map(({ adapter: _a, ...t }) => t);
    return NextResponse.json({ snapshot: snap, layout, prefs, reply, tools });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
