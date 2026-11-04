/**
 * UX eval for the agent's answers: runs realistic requests through /api/agent (dev server
 * must be up) and has a separate model grade each answer against a fixed rubric.
 *
 *   npx tsx --env-file=.env.local evals/ux.mts [label] [--only=3,7]
 *
 * Results land in evals/results/<label>.json so prompt changes can be compared run to run.
 * Transactions are only proposed, never signed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const API = process.env.TAILOR_API ?? "http://localhost:3210";
const SMALL = "EXjWkYKcomQoY2viwE66EoaRNGugAV1TGXcFGiDECewT"; // an ordinary active wallet, a few SOL (not the public test seed: that account was hijacked)
const WHALE = "HYMhVBmNgWbCtv8ZYkUUnNCPS1TKzWsCZnwPnnfxb2iT"; // Kamino positions

const CASES: { owner: string; prompt: string }[] = [
  { owner: SMALL, prompt: "what's my wallet address" },
  { owner: SMALL, prompt: "how do I get USDC into this wallet from Coinbase" },
  { owner: SMALL, prompt: "best way to earn yield on my SOL" },
  { owner: SMALL, prompt: "swap 0.1 SOL to USDC" },
  { owner: SMALL, prompt: "what's SOL's price right now" },
  { owner: SMALL, prompt: `send 0.01 SOL to ${WHALE}` },
  { owner: SMALL, prompt: "show my recent transactions" },
  { owner: SMALL, prompt: "what is JitoSOL and should I hold it" },
  { owner: SMALL, prompt: "how much would I earn staking all my SOL for a year" },
  { owner: SMALL, prompt: `is it safe to send to ${WHALE}` },
  { owner: SMALL, prompt: "give me a link to view my wallet on an explorer" },
  { owner: SMALL, prompt: "what can I do with this wallet?" },
  { owner: WHALE, prompt: "am I close to liquidation" },
  { owner: WHALE, prompt: "what's my biggest risk right now" },
  { owner: WHALE, prompt: "how is my portfolio split" },
  { owner: WHALE, prompt: "close my riskiest position" },
  { owner: WHALE, prompt: "how much am I earning per day across everything" },
  { owner: WHALE, prompt: "what are my positions on kamino" },
  { owner: WHALE, prompt: "add a module to my home showing my health factor" },
  { owner: WHALE, prompt: "what fees have I paid this month" },
  // Open-ended questions with no dedicated tool: the agent has to find data and make it actionable.
  { owner: SMALL, prompt: "top 10 tokens to buy right now" },
  { owner: SMALL, prompt: "what's hot on solana today" },
  { owner: SMALL, prompt: "which tokenized stocks are moving the most" },
  { owner: SMALL, prompt: "best place to park stablecoins for yield" },
  { owner: SMALL, prompt: "give me a few safe-ish bets under $1" },
  { owner: WHALE, prompt: "how should I rebalance" },
];

const RUBRIC = `You grade the answers of Tailor, an AI Solana wallet that runs in a 360px-wide browser popup. For each request it can reply with short text, draw cards from a UI kit (stat, gauge, bars, table, asset = token row with price and a Buy button, field = value with Copy button, qr, link, action/tool buttons, custom code), propose a transaction (opens a review screen), or change the wallet home.

Judge the answer as a demanding product designer would. Score each 1–5:
- next_step: is the user's most likely next action one tap away inside the answer (copy, scan, choose, act, open)? 5 = yes, obviously; 1 = the user has to work it out or leave.
- form: is the representation right for the content (copyable value in a field, comparison side by side, risk as a gauge, an action as a transaction, a plain fact as one sentence)? Penalize walls of text and needless cards equally.
- fit: will it read well at 360px (no sideways scroll, short labels, one column, not too long)?
- honesty: does it avoid claiming things it didn't do, inventing numbers, or overstating certainty? Saying it can't do something is fine.
- overall: your holistic score.
Then give one sentence: the single change that would most improve this answer.`;

const Grade = z.object({ next_step: z.number(), form: z.number(), fit: z.number(), honesty: z.number(), overall: z.number(), fix: z.string() });

interface Run { text: string; steps: string[]; cards: unknown[]; proposal?: string; home?: string[]; error?: string; ms: number }

async function runCase(owner: string, prompt: string): Promise<Run> {
  const t0 = Date.now();
  const out: Run = { text: "", steps: [], cards: [], ms: 0 };
  try {
    const r = await fetch(`${API}/api/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, prompt }) });
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === "text") out.text += ev.delta;
        else if (ev.type === "narration") { out.steps.push(out.text); out.text = ""; }
        else if (ev.type === "status") out.steps.push(ev.text);
        else if (ev.type === "card") out.cards.push(ev.card);
        else if (ev.type === "proposal") out.proposal = `${ev.prep.summary}${ev.prep.warnings?.length ? ` (warnings: ${ev.prep.warnings.join("; ")})` : ""}`;
        else if (ev.type === "home" && ev.ev.type === "done") out.home = ev.ev.home.sections.map((s: { kind: string }) => s.kind);
        else if (ev.type === "done" && ev.reply) out.text = ev.reply;
        else if (ev.type === "error") out.error = ev.error;
      }
    }
  } catch (e) { out.error = e instanceof Error ? e.message : String(e); }
  out.ms = Date.now() - t0;
  return out;
}

// Long custom HTML isn't useful to the grader past its first part.
const trimCards = (cards: unknown[]) => JSON.stringify(cards, (k, v) => (k === "html" && typeof v === "string" && v.length > 1500 ? `${v.slice(0, 1500)}…` : v));

async function grade(prompt: string, run: Run) {
  const res = await new Anthropic().messages.parse({
    model: "claude-sonnet-5-5", max_tokens: 1500, output_config: { effort: "low", format: zodOutputFormat(Grade) }, system: RUBRIC,
    messages: [{ role: "user", content: `<request>${prompt}</request>\n<answer>\ntext: ${run.text || "(none)"}\ncards: ${trimCards(run.cards)}\nproposed transaction: ${run.proposal ?? "(none)"}\nhome sections after: ${run.home?.join(", ") ?? "(unchanged)"}\nerror: ${run.error ?? "(none)"}\n</answer>` }],
  });
  return res.parsed_output!;
}

async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = []; let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}

const label = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",").map(Number);
const cases = CASES.map((c, i) => ({ ...c, i })).filter((c) => !only || only.includes(c.i));

const results = await pool(cases, 4, async (c) => {
  const run = await runCase(c.owner, c.prompt);
  const g = await grade(c.prompt, run).catch((e) => ({ next_step: 0, form: 0, fit: 0, honesty: 0, overall: 0, fix: `grading failed: ${e.message}` }));
  console.log(`[${c.i}] ${g.overall}/5  ${c.prompt}  →  ${g.fix}`);
  return { ...c, run, grade: g };
});

const avg = (k: keyof z.infer<typeof Grade>) => (results.reduce((s, r) => s + Number(r.grade[k]), 0) / results.length).toFixed(2);
const summary = { label, n: results.length, next_step: avg("next_step"), form: avg("form"), fit: avg("fit"), honesty: avg("honesty"), overall: avg("overall") };
console.log("\n", summary);
mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
writeFileSync(new URL(`./results/${label}.json`, import.meta.url), JSON.stringify({ summary, results }, null, 2));
