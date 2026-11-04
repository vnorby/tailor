import { NextResponse, type NextRequest } from "next/server";

/**
 * 1. Access: only the Tailor extension (pinned by ID) and this server's own pages may call
 *    the API; every other browser origin gets a 403. Meant to run on localhost.
 * 2. Rate limiting for the expensive AI endpoints: an in-memory sliding window per
 *    client IP (per server instance — good enough to stop runaway loops and casual
 *    abuse; use a shared store such as Upstash for a hard global limit).
 */

const LIMITED = ["/api/home", "/api/page", "/api/theme", "/api/agent", "/api/security/explain", "/api/suggest"];
const WINDOWS = [
  { ms: 60_000, max: 30, label: "minute" },
  { ms: 60 * 60_000, max: 300, label: "hour" },
];
const LONGEST = Math.max(...WINDOWS.map((w) => w.ms));
const hits = new Map<string, number[]>();
let lastSweep = 0;

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  return xff?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

/** Record a hit; returns seconds to wait (and which window tripped) if over a limit. */
function rateLimit(key: string, now = Date.now()): { retryAfter: number; label: string } | null {
  if (now - lastSweep > 5 * 60_000) {
    lastSweep = now;
    for (const [k, ts] of hits) if (!ts.length || now - ts[ts.length - 1] > LONGEST) hits.delete(k);
  }
  const ts = (hits.get(key) ?? []).filter((t) => now - t < LONGEST);
  for (const w of WINDOWS) {
    const inWindow = ts.filter((t) => now - t < w.ms);
    if (inWindow.length >= w.max) {
      hits.set(key, ts);
      return { retryAfter: Math.max(1, Math.ceil((inWindow[0] + w.ms - now) / 1000)), label: w.label };
    }
  }
  ts.push(now);
  hits.set(key, ts);
  return null;
}

// The unpacked extension's ID is fixed by the "key" in its manifest. Only it may call this server,
// so other installed extensions can't spend your API credits. EXTENSION_IDS overrides (comma-separated,
// e.g. a Chrome Web Store build's ID); "*" allows any extension (not recommended).
const DEFAULT_EXTENSION_ID = "kmoplbbmdhnenkckmjdjdegfndcnciia";
const PINNED = (process.env.EXTENSION_IDS ?? DEFAULT_EXTENSION_ID).split(",").map((s) => s.trim()).filter(Boolean);

export function proxy(req: NextRequest) {
  const origin = req.headers.get("origin") ?? "";
  const allowed = origin.startsWith("chrome-extension://") && (PINNED.includes("*") || PINNED.includes(origin.slice("chrome-extension://".length)));
  const cors: Record<string, string> = allowed ? {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  } : {};
  if (allowed && req.method === "OPTIONS") return new NextResponse(null, { status: 204, headers: cors });
  // Requests from any other origin are refused outright, not just left unreadable: a web page can send a
  // "simple" cross-site POST (text/plain, no preflight) that would otherwise run and spend your AI credits.
  // Same-origin calls (this server's own pages) and non-browser clients send no foreign Origin.
  const sameOrigin = !origin || origin === req.nextUrl.origin;
  if (!allowed && !sameOrigin) return NextResponse.json({ error: "Origin not allowed." }, { status: 403 });

  const path = req.nextUrl.pathname;
  if (req.method !== "OPTIONS" && LIMITED.some((p) => path === p || path.startsWith(`${p}/`))) {
    const over = rateLimit(clientIp(req));
    if (over) {
      return NextResponse.json(
        { error: `Too many requests — limit is ${WINDOWS.find((w) => w.label === over.label)!.max} per ${over.label}. Try again in ${over.retryAfter}s.` },
        { status: 429, headers: { ...cors, "retry-after": String(over.retryAfter) } },
      );
    }
  }

  if (!allowed) return NextResponse.next();
  const res = NextResponse.next();
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
}

export const config = { matcher: "/api/:path*" };
