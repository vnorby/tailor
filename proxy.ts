import { NextResponse, type NextRequest } from "next/server";

/**
 * CORS for the Tailor browser extension. Only chrome-extension:// origins get CORS
 * headers; everything else stays same-origin. EXTENSION_IDS (comma-separated) pins
 * it to specific published extension ids once we have them.
 */
export function proxy(req: NextRequest) {
  const origin = req.headers.get("origin") ?? "";
  const pinned = (process.env.EXTENSION_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const allowed = origin.startsWith("chrome-extension://") && (!pinned.length || pinned.includes(origin.slice("chrome-extension://".length)));
  if (!allowed) return NextResponse.next();
  const headers = {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
  if (req.method === "OPTIONS") return new NextResponse(null, { status: 204, headers });
  const res = NextResponse.next();
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
}

export const config = { matcher: "/api/:path*" };
