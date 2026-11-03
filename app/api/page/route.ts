import { allTools } from "@/lib/adapters";
import { getSnapshot } from "@/lib/core/cache";
import { isAddress } from "@/lib/core/solana";
import { load, save } from "@/lib/core/store";
import { fingerprint, generatePage } from "@/lib/genui/generate";

export const maxDuration = 300;

/**
 * POST { owner, prompt?, reset? } → NDJSON stream of PageEvents (headline, card…, done).
 * `prompt` is a free-text change request; `reset` drops standing instructions.
 */
export async function POST(req: Request) {
  const { owner, prompt, reset } = (await req.json().catch(() => ({}))) as { owner?: string; prompt?: string; reset?: boolean };
  if (!owner || !isAddress(owner)) return Response.json({ error: "Not a valid Solana address." }, { status: 400 });
  if (prompt && prompt.length > 1000) return Response.json({ error: "Keep requests under 1000 characters." }, { status: 400 });

  const snap = await getSnapshot(owner);
  const saved = await load(owner);
  const prefs = reset ? { instructions: [] } : saved.prefs;
  const tools = allTools().map(({ adapter: _a, ...t }) => t);
  const enc = new TextEncoder();

  const body = new ReadableStream({
    async start(controller) {
      try {
        for await (const ev of generatePage(snap, tools, prefs, reset ? null : saved.layout, prompt?.trim() || undefined)) {
          controller.enqueue(enc.encode(JSON.stringify(ev) + "\n"));
          if (ev.type === "done") await save(owner, { layout: ev.page, prefs: ev.prefs, fingerprint: fingerprint(snap) });
        }
      } catch (e) {
        controller.enqueue(enc.encode(JSON.stringify({ type: "error", error: e instanceof Error ? e.message : String(e) }) + "\n"));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
