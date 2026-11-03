import { generateTheme, type Theme } from "@/lib/genui/theme";

export const maxDuration = 120;

/** POST { activities: string[], style: string, current?: Theme } → NDJSON stream of status lines, then the theme. */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { activities?: unknown; style?: unknown; current?: Theme };
  const activities = Array.isArray(b.activities) ? b.activities.filter((x): x is string => typeof x === "string").slice(0, 20).map((s) => s.slice(0, 80)) : [];
  const style = typeof b.style === "string" ? b.style.slice(0, 500) : "";
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(c) {
      try { for await (const ev of generateTheme({ activities, style, current: b.current ?? null })) c.enqueue(enc.encode(JSON.stringify(ev) + "\n")); }
      catch (e) { c.enqueue(enc.encode(JSON.stringify({ type: "error", error: e instanceof Error ? e.message : String(e) }) + "\n")); }
      try { c.close(); } catch { /* already closed */ }
    },
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
