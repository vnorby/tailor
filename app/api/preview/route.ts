import { NextResponse } from "next/server";
import { previewTransaction } from "@/lib/core/preview";
import { isAddress } from "@/lib/core/solana";

export const maxDuration = 30;

/** Allow the Tailor Chrome extension (any chrome-extension:// origin) to call this route. */
function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  if (!origin.startsWith("chrome-extension://")) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: cors(req) });
}

/** POST { tx: base64 transaction, owner: wallet address } → Preview (what the tx does to that wallet). */
export async function POST(req: Request) {
  const headers = cors(req);
  const { tx, owner } = (await req.json().catch(() => ({}))) as { tx?: unknown; owner?: unknown };
  if (typeof tx !== "string" || !tx || typeof owner !== "string" || !isAddress(owner)) {
    return NextResponse.json({ error: "Expected { tx: base64 transaction, owner: wallet address }." }, { status: 400, headers });
  }
  try {
    return NextResponse.json(await previewTransaction(tx, owner), { headers });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const bad = /valid Solana transaction|Empty transaction|lookup table not found/i.test(message);
    return NextResponse.json({ error: message }, { status: bad ? 400 : 500, headers });
  }
}
