import { allTools } from "@/lib/adapters";
import { getSnapshot } from "@/lib/core/cache";
import { isAddress } from "@/lib/core/solana";
import { load, save } from "@/lib/core/store";
import { fingerprint } from "@/lib/genui/generate";
import { sanitizeSection, type Home, type Section } from "@/lib/genui/home";

/**
 * POST { owner, sections, instruction? } — the user edited the home by hand (removed, moved, pinned).
 * Saves the new section list and, when given, a standing instruction so the designer respects
 * the edit the next time it rebuilds (e.g. never bring back a removed module).
 */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { owner?: string; sections?: unknown[]; instruction?: string };
  const owner = b.owner ?? "";
  if (!isAddress(owner) || !Array.isArray(b.sections)) return Response.json({ error: "Bad request." }, { status: 400 });
  const key = `${owner}:home`;
  const snap = await getSnapshot(owner, false);
  const tools = allTools().map(({ adapter: _a, ...t }) => t);
  const sections = b.sections.slice(0, 30).map((s) => sanitizeSection(s, snap, tools)).filter((s): s is Section => !!s);
  const saved = await load(key);
  const base = (saved.layout as unknown as Home | null) ?? { actions: ["send", "receive", "swap"], sections: [], details: {}, generatedAt: Date.now() };
  const home: Home = { ...base, sections, generatedAt: Date.now() };
  const instruction = typeof b.instruction === "string" ? b.instruction.trim().slice(0, 300) : "";
  // Newest edit wins: drop an older instruction about the same module before adding this one.
  const prefs = instruction ? { instructions: [...saved.prefs.instructions.filter((x) => !sameSubject(x, instruction)), instruction].slice(-20) } : saved.prefs;
  await save(key, { layout: home as never, prefs, fingerprint: fingerprint(snap) });
  return Response.json({ home, prefs });
}

const subject = (s: string) => /“([^”]+)”/.exec(s)?.[1]?.toLowerCase();
const sameSubject = (a: string, b: string) => !!subject(a) && subject(a) === subject(b);
