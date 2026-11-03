/** Kit cards built in code (no model): fallbacks and the "never hide a risky position" guarantee. */
import type { Position } from "@/lib/core/types";
import type { Card, Node } from "./spec";

/** A sensible kit card for any position: used for the fallback page and the danger guarantee. */
export function defaultCard(p: Position): Card {
  const kids: Node[] = [
    { type: "row", align: "between", children: [
      { type: "stack", gap: "s", children: [{ type: "eyebrow", text: p.protocol, protocol: p.protocol }, { type: "heading", text: p.title, size: "m", font: "sans" }] },
      { type: "stat", label: "Value", value: "{{value|usd}}", size: "m" },
    ] },
  ];
  if (p.risk.reason) kids.push({ type: "callout", text: p.risk.reason, tone: p.risk.level === "danger" ? "neg" : p.risk.level === "watch" ? "warn" : "dim" });
  if (p.risk.liqPrice && p.risk.markPrice) kids.push({ type: "track", format: "price", markers: [{ label: "Liq", value: "liqPrice", tone: "neg" }, ...(typeof p.raw?.entryPrice === "number" ? [{ label: "Entry", value: "entryPrice", tone: "dim" as const }] : []), { label: "Mark", value: "markPrice" }] });
  else if (p.risk.healthPct != null) kids.push({ type: "gauge", label: "Health", value: "health", max: "100", warnAt: "35", dangerAt: "15", format: "pct100" });
  if (p.legs.length) kids.push({ type: "legs", positionId: p.id });
  const acts = p.actions.slice(0, 4).map((a): Node => ({ type: "action", positionId: p.id, actionId: a.id, variant: a.danger ? "danger" : "ghost" }));
  if (acts.length) kids.push({ type: "row", children: acts });
  return { span: p.risk.level === "danger" ? 3 : 2, tone: p.risk.level === "danger" ? "danger" : p.risk.level === "watch" ? "warn" : undefined, positionId: p.id, children: kids };
}

