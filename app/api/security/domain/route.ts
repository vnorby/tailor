import { NextResponse } from "next/server";
import { checkDomain } from "@/lib/security/domains";

export const maxDuration = 15;

/** GET ?origin=https://site.example → { verdict: "ok"|"suspicious"|"malicious", reasons, host, trusted?, blocklist }. */
export async function GET(req: Request) {
  const origin = new URL(req.url).searchParams.get("origin") ?? "";
  if (!origin || origin.length > 2048) return NextResponse.json({ error: "Expected ?origin=" }, { status: 400 });
  const r = await checkDomain(origin);
  return NextResponse.json(r, { headers: { "cache-control": "private, max-age=300" } });
}
