import { NextResponse } from "next/server";
import { getSnapshot } from "@/lib/core/cache";
import { compose, fingerprint } from "@/lib/core/compose";
import { isAddress } from "@/lib/core/solana";
import { load, save } from "@/lib/core/store";

export const maxDuration = 120;

/**
 * POST { owner, prompt?, reset? } → re-compose the layout. `prompt` is a free-text request
 * ("put perps first", "hide anything under $50"); `reset` clears standing instructions.
 */
export async function POST(req: Request) {
  const { owner, prompt, reset } = (await req.json().catch(() => ({}))) as { owner?: string; prompt?: string; reset?: boolean };
  if (!owner || !isAddress(owner)) return NextResponse.json({ error: "Not a valid Solana address." }, { status: 400 });
  if (prompt && prompt.length > 1000) return NextResponse.json({ error: "Keep requests under 1000 characters." }, { status: 400 });
  try {
    const snap = await getSnapshot(owner);
    const saved = await load(owner);
    const prefs = reset ? { instructions: [] } : saved.prefs;
    const out = await compose(snap, prefs, reset ? null : saved.layout, prompt?.trim() || undefined);
    await save(owner, { layout: out.layout, prefs: out.prefs, fingerprint: fingerprint(snap) });
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
