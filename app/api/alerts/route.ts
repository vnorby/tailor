import { getSnapshot } from "@/lib/core/cache";
import { isAddress } from "@/lib/core/solana";

/** Compact position risk for background alerting (no AI). GET ?owner= */
export async function GET(req: Request) {
  const owner = new URL(req.url).searchParams.get("owner") ?? "";
  if (!isAddress(owner)) return Response.json({ error: "Not a valid Solana address." }, { status: 400 });
  try {
    const snap = await getSnapshot(owner);
    return Response.json({
      positions: snap.positions.map((p) => ({ id: p.id, title: p.title, protocol: p.protocol, kind: p.kind, valueUsd: p.valueUsd, borrows: p.legs.some((l) => l.side === "borrow" || l.side === "long" || l.side === "short"), risk: { level: p.risk.level, score: p.risk.score, reason: p.risk.reason } })),
      netWorthUsd: snap.netWorthUsd, at: snap.fetchedAt,
    });
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 }); }
}
