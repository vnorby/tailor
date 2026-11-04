import { allTools } from "@/lib/adapters";
import { getSnapshot } from "@/lib/core/cache";
import { isAddress } from "@/lib/core/solana";
import { load, save } from "@/lib/core/store";
import { fingerprint } from "@/lib/genui/generate";
import type { Home, Profile } from "@/lib/genui/home";
import type { Theme } from "@/lib/genui/theme";
import { runAgent } from "@/lib/agent/agent";

export const maxDuration = 300;

/** POST { owner, prompt, profile?, theme?, current? } → NDJSON stream of AgentEvents. */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { owner?: string; prompt?: string; profile?: Profile; theme?: Theme; current?: Home; site?: string };
  const owner = b.owner ?? "";
  if (!isAddress(owner)) return Response.json({ error: "Not a valid Solana address." }, { status: 400 });
  const prompt = (b.prompt ?? "").trim();
  if (!prompt) return Response.json({ error: "Ask something." }, { status: 400 });
  const key = `${owner}:home`;
  const tools = allTools().map(({ adapter: _a, ...t }) => t);
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(c) {
      let closed = false;
      const send = (o: unknown) => { if (closed) return; try { c.enqueue(enc.encode(JSON.stringify(o) + "\n")); } catch { closed = true; } };
      try {
        const snap = await getSnapshot(owner);
        const saved = await load(key);
        const current = b.current && Array.isArray(b.current.sections) ? b.current : (saved.layout as unknown as Home) ?? null;
        for await (const ev of runAgent({
          snap, tools, prefs: saved.prefs, profile: b.profile ?? null, theme: b.theme ?? null, current, prompt, site: typeof b.site === "string" ? b.site.slice(0, 100) : undefined,
          onHomeDone: (home, prefs) => save(key, { layout: home as never, prefs, fingerprint: fingerprint(snap) }),
        })) send(ev);
      } catch (e) { send({ type: "error", error: e instanceof Error ? e.message : String(e) }); }
      try { c.close(); } catch { /* already closed */ }
    },
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
