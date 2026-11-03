/**
 * The generative part: Claude arranges a wallet's positions, balances and tools
 * into a Layout, guided by urgency, what the wallet actually does on-chain, and
 * the user's standing instructions. The model only chooses and arranges known
 * widgets — rendering and transactions stay in our code.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { allTools } from "@/lib/adapters";
import { usd } from "./solana";
import type { Layout, Position, Prefs, Snapshot, Widget } from "./types";

const MODEL = "claude-opus-5-5";

const WidgetSchema = z.object({
  type: z.enum(["alert", "summary", "position", "group", "tokens", "tool", "activity", "note"]),
  size: z.enum(["s", "m", "l", "xl"]).describe("grid span out of 4 columns: s=1, m=2, l=3, xl=4"),
  title: z.string().nullable(),
  note: z.string().nullable().describe("one short line of context for this widget, or null"),
  positionIds: z.array(z.string()).nullable().describe("for position (exactly one id), group (several), alert (the positions at risk)"),
  toolId: z.string().nullable().describe("for type=tool"),
  toolDefaults: z.array(z.object({ name: z.string(), value: z.string() })).nullable().describe("prefilled tool fields"),
  accent: z.enum(["danger", "warn", "calm"]).nullable(),
});

const OutputSchema = z.object({
  headline: z.string().describe("one sentence for the top of the page: the most important thing about this wallet right now"),
  widgets: z.array(WidgetSchema),
  instructions: z.array(z.string()).describe("the complete updated list of standing user instructions (merge the new request in; drop ones it supersedes; keep it short)"),
  reply: z.string().describe("one or two sentences to the user about what you changed, or what they should look at"),
});

const SYSTEM = `You design a personal DeFi dashboard for one Solana wallet. You receive the wallet's positions (with risk), token balances, what it has done on-chain recently, the available tools, the user's standing instructions, the current layout, and possibly a new request from the user.

Return the full layout as an ordered list of widgets on a 4-column grid (top to bottom, left to right; sizes s/m/l/xl span 1/2/3/4 columns).

Widget types:
- alert: urgent banner for positions at risk (accent danger/warn). Only when something is actually at risk or needs action.
- summary: net worth and allocation.
- position: one position's custom card with its action buttons (positionIds = [id]). Use for anything sizeable, risky or frequently used.
- group: compact list of several smaller/similar positions (positionIds).
- tokens: wallet token balances.
- tool: an action form not tied to a position (toolId from the tools list, optional toolDefaults).
- activity: what the wallet has been doing.
- note: a short text tip (use sparingly).

Principles:
- Urgency first: danger positions go at the top, large, with an alert. Watch-level items come next.
- Then shape the page around what this wallet actually does: if it mostly trades perps, perps and a swap tool lead; if it farms yield, lending/vault cards lead; a passive holder sees balances and staking.
- Every position should appear somewhere (own card or a group) unless the user's instructions say to hide it. Tiny positions belong in groups.
- Offer tools the wallet would plausibly use next (e.g. swap for active traders, stake-sol for idle SOL). Don't add tools nobody needs.
- The user's standing instructions override these defaults. A new request may change the layout, add/remove a standing instruction, or both. Instructions that are about one-off layout tweaks can still be kept as standing instructions so they survive refreshes.
- Notes and headlines are short, concrete and use real numbers. No hype, no emojis.
- Use only position ids and tool ids that exist in the input.`;

function compactPosition(p: Position) {
  return {
    id: p.id, protocol: p.protocol, kind: p.kind, title: p.title, subtitle: p.subtitle,
    value: usd(p.valueUsd), pnl: p.pnlUsd != null ? usd(p.pnlUsd) : undefined,
    risk: `${p.risk.level} (urgency ${p.risk.score})${p.risk.reason ? `: ${p.risk.reason}` : ""}`,
    metrics: p.metrics.map((m) => `${m.label} ${m.value}`).join(", "),
    actions: p.actions.map((a) => a.label),
  };
}

export async function compose(snap: Snapshot, prefs: Prefs, current: Layout | null, request?: string): Promise<{ layout: Layout; prefs: Prefs; reply: string }> {
  if (!process.env.ANTHROPIC_API_KEY) return { layout: fallbackLayout(snap), prefs, reply: "AI layout unavailable (no API key); showing the default layout." };

  const tools = allTools().map((t) => ({ id: t.id, label: t.label, description: t.description, fields: t.fields.map((f) => f.name) }));
  const input = {
    netWorth: usd(snap.netWorthUsd),
    positions: snap.positions.map(compactPosition),
    tokens: snap.tokens.slice(0, 25).map((t) => `${t.symbol} ${t.amount.toFixed(4)} (${usd(t.valueUsd ?? 0)})`),
    activity: { recentTxs: snap.activity.txCount, byProtocol: snap.activity.bySource, byType: snap.activity.byType, lastActive: snap.activity.lastActiveAt ? new Date(snap.activity.lastActiveAt).toISOString() : null },
    readErrors: snap.errors.map((e) => `${e.protocol}: ${e.message}`),
    tools,
    standingInstructions: prefs.instructions,
    currentLayout: current?.widgets.map(({ id: _id, ...w }) => w) ?? null,
  };

  const client = new Anthropic();
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "low", format: zodOutputFormat(OutputSchema) },
    system: SYSTEM,
    messages: [{
      role: "user",
      content: `<wallet>\n${JSON.stringify(input, null, 1)}\n</wallet>\n\n${request ? `New request from the user: <request>${request}</request>` : "No new request: (re)build the layout from the current state."}`,
    }],
  });
  if (res.stop_reason === "refusal" || !res.parsed_output) return { layout: fallbackLayout(snap), prefs, reply: "Couldn't generate a layout this time; showing the default." };

  const out = res.parsed_output;
  const layout = sanitize(out, snap);
  return { layout, prefs: { instructions: out.instructions.map((s) => s.trim()).filter(Boolean).slice(0, 20) }, reply: out.reply };
}

/** Drop references to unknown ids and make sure nothing dangerous is ever hidden. */
function sanitize(out: z.infer<typeof OutputSchema>, snap: Snapshot): Layout {
  const ids = new Set(snap.positions.map((p) => p.id));
  const toolIds = new Set(allTools().map((t) => t.id));
  const widgets: Widget[] = [];
  out.widgets.forEach((w, i) => {
    const positionIds = w.positionIds?.filter((id) => ids.has(id));
    if ((w.type === "position" || w.type === "group") && !positionIds?.length) return;
    if (w.type === "tool" && (!w.toolId || !toolIds.has(w.toolId))) return;
    widgets.push({
      id: `w${i}`, type: w.type, size: w.size,
      title: w.title ?? undefined, note: w.note ?? undefined,
      positionIds: positionIds?.length ? (w.type === "position" ? positionIds.slice(0, 1) : positionIds) : undefined,
      toolId: w.toolId ?? undefined,
      toolDefaults: w.toolDefaults ? Object.fromEntries(w.toolDefaults.map((d) => [d.name, d.value])) : undefined,
      accent: w.accent ?? undefined,
    });
  });
  const shown = new Set(widgets.flatMap((w) => w.positionIds ?? []));
  const hiddenDanger = snap.positions.filter((p) => p.risk.level === "danger" && !shown.has(p.id));
  if (hiddenDanger.length) {
    widgets.unshift(...hiddenDanger.map((p, i) => ({ id: `d${i}`, type: "position" as const, size: "l" as const, positionIds: [p.id], accent: "danger" as const, note: p.risk.reason })));
  }
  return { headline: out.headline, widgets, generatedAt: Date.now() };
}

/** Deterministic layout: risk first, then by value. Used without an API key or on failure. */
export function fallbackLayout(snap: Snapshot): Layout {
  const sorted = [...snap.positions].sort((a, b) => b.risk.score - a.risk.score || b.valueUsd - a.valueUsd);
  const risky = sorted.filter((p) => p.risk.level !== "ok");
  const big = sorted.filter((p) => p.risk.level === "ok" && p.valueUsd >= 100);
  const small = sorted.filter((p) => p.risk.level === "ok" && p.valueUsd < 100);
  const widgets: Widget[] = [];
  if (risky.some((p) => p.risk.level === "danger")) widgets.push({ id: "alert", type: "alert", size: "xl", accent: "danger", positionIds: risky.filter((p) => p.risk.level === "danger").map((p) => p.id) });
  widgets.push({ id: "summary", type: "summary", size: "m" });
  widgets.push({ id: "swap", type: "tool", size: "m", toolId: "swap" });
  for (const p of [...risky, ...big]) widgets.push({ id: `p-${p.id}`, type: "position", size: p.risk.level === "danger" ? "l" : "m", positionIds: [p.id], accent: p.risk.level === "danger" ? "danger" : p.risk.level === "watch" ? "warn" : undefined });
  if (small.length) widgets.push({ id: "small", type: "group", size: "m", title: "Smaller positions", positionIds: small.map((p) => p.id) });
  widgets.push({ id: "tokens", type: "tokens", size: "m" });
  widgets.push({ id: "activity", type: "activity", size: "m" });
  const top = risky[0];
  return { headline: top ? `${top.title}: ${top.risk.reason ?? "needs attention"}.` : `${usd(snap.netWorthUsd)} across ${snap.positions.length} positions.`, widgets, generatedAt: Date.now() };
}

/** Changes when positions open/close or risk levels move, so we know to re-compose. */
export const fingerprint = (snap: Snapshot) =>
  snap.positions.map((p) => `${p.id}:${p.risk.level}`).sort().join("|");
