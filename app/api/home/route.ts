import { allTools } from "@/lib/adapters";
import { getSnapshot } from "@/lib/core/cache";
import { isAddress } from "@/lib/core/solana";
import { load, save } from "@/lib/core/store";
import { fingerprint } from "@/lib/genui/generate";
import { generateHome, type Home, type Profile } from "@/lib/genui/home";

export const maxDuration = 300;

/**
 * POST { owner, prompt?, reset?, fresh?, profile? } → NDJSON stream:
 *   {type:"snapshot", snapshot, tools}  as soon as the chain is read (with "status" lines from each protocol before it)
 *   then the home being decided: status/alert/actions/section/detail/intent…, then done.
 * If nothing changed and there's no prompt, the cached home is replayed instantly.
 */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { owner?: string; prompt?: string; reset?: boolean; fresh?: boolean; profile?: Profile };
  const owner = b.owner ?? "";
  if (!isAddress(owner)) return Response.json({ error: "Not a valid Solana address." }, { status: 400 });
  const prompt = typeof b.prompt === "string" ? b.prompt.trim().slice(0, 1000) : "";
  const profile: Profile | null = b.profile && Array.isArray(b.profile.activities) ? { activities: b.profile.activities.filter((x) => typeof x === "string").slice(0, 20), style: typeof b.profile.style === "string" ? b.profile.style.slice(0, 300) : undefined } : null;
  const key = `${owner}:home`;
  const tools = allTools().map(({ adapter: _a, ...t }) => t);
  const enc = new TextEncoder();

  const body = new ReadableStream({
    async start(c) {
      const send = (o: unknown) => c.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      try {
        send({ type: "status", source: "chain", text: "Reading the chain" });
        // Only protocols where something was found (or failed) are worth a line.
        const snap = await getSnapshot(owner, !!b.fresh, (e) => {
          if (e.error) send({ type: "status", source: "chain", text: `${e.name}: couldn't read` });
          else if (e.name === "Wallet") send({ type: "status", source: "chain", text: `${e.positions} token${e.positions === 1 ? "" : "s"} in the wallet` });
          else if (e.positions) send({ type: "status", source: "chain", text: `${e.name}: ${e.positions} position${e.positions === 1 ? "" : "s"}` });
        });
        send({ type: "snapshot", snapshot: snap, tools });
        const saved = await load(key);
        const prefs = b.reset ? { instructions: [] } : saved.prefs;
        const fp = fingerprint(snap);
        if (!prompt && !b.reset && saved.layout && saved.fingerprint === fp) {
          send({ type: "done", home: saved.layout as unknown as Home, prefs, reply: "", cached: true });
        } else {
          for await (const ev of generateHome(snap, tools, prefs, profile, prompt || undefined)) {
            send(ev);
            if (ev.type === "done") await save(key, { layout: ev.home as never, prefs: ev.prefs, fingerprint: fp });
          }
        }
      } catch (e) { send({ type: "error", error: e instanceof Error ? e.message : String(e) }); }
      c.close();
    },
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
