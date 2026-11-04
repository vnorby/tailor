import { runAgent } from "@/lib/agent/agent";
import { snapshot } from "@/lib/core/snapshot";
import { allTools } from "@/lib/adapters";
const snap = await snapshot("HYMhVBmNgWbCtv8ZYkUUnNCPS1TKzWsCZnwPnnfxb2iT");
const tools = allTools().map(({ adapter: _a, ...t }) => t);
for (const prompt of process.argv.slice(2)) {
  console.log("\n=== " + prompt); const t0 = Date.now();
  for await (const e of runAgent({ snap, tools, prefs: { instructions: [] }, profile: { activities: ["Earn yield"] }, theme: null, current: null, prompt, onHomeDone: async () => {} })) {
    if (e.type === "text") continue;
    if (e.type === "status") console.log("  ·", e.text);
    else if (e.type === "proposal") console.log("  PROPOSAL:", e.prep.summary, "| sim:", e.prep.simulations.map((s) => s.ok ? "ok" : s.error), "| warnings:", e.prep.warnings);
    else if (e.type === "card") console.log("  CARD:", e.card.children.map((n) => n.type).join(","));
    else if (e.type === "done") console.log("  REPLY:", e.reply.slice(0, 300), `(${Math.round((Date.now() - t0) / 1000)}s)`);
    else console.log("  ", e.type, JSON.stringify(e).slice(0, 150));
  }
}
