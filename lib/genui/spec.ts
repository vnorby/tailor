/**
 * The generative UI kit: the vocabulary Claude composes pages from. Every text
 * field may contain {{expr|fmt}} templates evaluated against live facts (see
 * facts.ts), so numbers in generated UI are always computed, never typed.
 *
 * The sanitizer is deliberately lenient: unknown nodes, bad references and
 * malformed fields are dropped individually rather than rejecting a card.
 */
import type { Snapshot, ToolDef } from "@/lib/core/types";

export type Tone = "default" | "dim" | "pos" | "neg" | "warn" | "accent";
export type Fmt = "usd" | "usd0" | "pct" | "pct100" | "num" | "num0" | "num2" | "price" | "x" | "sol";
export type NV = { name: string; value: string };

export type Node =
  | { type: "row"; children: Node[]; align?: "start" | "center" | "end" | "between"; positionId?: string }
  | { type: "stack"; children: Node[]; gap?: "s" | "m" | "l"; positionId?: string }
  | { type: "grid"; cols: number; children: Node[]; positionId?: string }
  | { type: "heading"; text: string; size?: "xl" | "l" | "m" | "s"; font?: "serif" | "sans" }
  | { type: "text"; text: string; tone?: Tone; size?: "s" | "m" | "l" }
  | { type: "eyebrow"; text: string; protocol?: string }
  | { type: "pill"; text: string; tone?: Tone }
  | { type: "callout"; text: string; tone?: Tone }
  | { type: "divider" }
  | { type: "stat"; label: string; value: string; sub?: string; tone?: Tone; size?: "s" | "m" | "l" | "xl" }
  | { type: "gauge"; label: string; value: string; max: string; warnAt?: string; dangerAt?: string; format?: Fmt; caption?: string }
  | { type: "track"; markers: { label: string; value: string; tone?: Tone }[]; format?: Fmt; caption?: string }
  | { type: "bars"; items: { label: string; value: string; tone?: Tone }[]; format?: Fmt }
  | { type: "allocation" }
  | { type: "legs"; positionId: string }
  | { type: "tokens"; limit?: number }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "action"; positionId: string; actionId: string; label?: string; variant?: "primary" | "danger" | "ghost"; params?: NV[] }
  | { type: "whatif"; positionId: string; input: { label: string; min: string; max: string; step?: number; unit?: string; initial?: string }; outputs: { label: string; expr: string; format?: Fmt; warnIf?: string; dangerIf?: string }[]; actionId?: string; actionParam?: string; actionLabel?: string }
  | { type: "tool"; toolId: string; defaults?: NV[] }
  | { type: "code"; html: string; height?: number };

export interface Card {
  span: 1 | 2 | 3 | 4;
  tone?: "plain" | "danger" | "warn" | "calm" | "accent";
  positionId?: string;      // default formula scope for everything inside
  children: Node[];
}

export interface Page { headline: string; cards: Card[]; generatedAt: number }

const TONES = new Set(["default", "dim", "pos", "neg", "warn", "accent"]);
const FMTS = new Set(["usd", "usd0", "pct", "pct100", "num", "num0", "num2", "price", "x", "sol"]);
const str = (v: unknown, max = 400) => (typeof v === "string" ? v.slice(0, max) : typeof v === "number" ? String(v) : undefined);
const tone = (v: unknown) => (typeof v === "string" && TONES.has(v) ? (v as Tone) : undefined);
const fmtOf = (v: unknown) => (typeof v === "string" && FMTS.has(v) ? (v as Fmt) : undefined);
const nvs = (v: unknown): NV[] | undefined => Array.isArray(v) ? v.filter((x) => x && typeof x.name === "string").map((x) => ({ name: String(x.name), value: String(x.value ?? "") })) : undefined;

export interface Ctx { snap: Snapshot; tools: ToolDef[] }

function posOk(ctx: Ctx, id: unknown) { return typeof id === "string" && ctx.snap.positions.some((p) => p.id === id); }
function actionOk(ctx: Ctx, pid: unknown, aid: unknown) { return ctx.snap.positions.find((p) => p.id === pid)?.actions.some((a) => a.id === aid) ?? false; }

export function sanitizeNode(raw: unknown, ctx: Ctx, depth = 0): Node | null {
  if (!raw || typeof raw !== "object" || depth > 8) return null;
  const n = raw as Record<string, unknown>;
  const kids = () => (Array.isArray(n.children) ? n.children.map((c) => sanitizeNode(c, ctx, depth + 1)).filter((c): c is Node => !!c).slice(0, 24) : []);
  const pid = posOk(ctx, n.positionId) ? (n.positionId as string) : undefined;
  switch (n.type) {
    case "row": { const c = kids(); return c.length ? { type: "row", children: c, align: ["start", "center", "end", "between"].includes(n.align as string) ? n.align as "start" : undefined, positionId: pid } : null; }
    case "stack": { const c = kids(); return c.length ? { type: "stack", children: c, gap: ["s", "m", "l"].includes(n.gap as string) ? n.gap as "s" : undefined, positionId: pid } : null; }
    case "grid": { const c = kids(); return c.length ? { type: "grid", cols: Math.min(4, Math.max(2, Number(n.cols) || 2)), children: c, positionId: pid } : null; }
    case "heading": { const t = str(n.text, 200); return t ? { type: "heading", text: t, size: ["xl", "l", "m", "s"].includes(n.size as string) ? n.size as "xl" : undefined, font: n.font === "sans" ? "sans" : n.font === "serif" ? "serif" : undefined } : null; }
    case "text": { const t = str(n.text, 600); return t ? { type: "text", text: t, tone: tone(n.tone), size: ["s", "m", "l"].includes(n.size as string) ? n.size as "s" : undefined } : null; }
    case "eyebrow": { const t = str(n.text, 80); return t ? { type: "eyebrow", text: t, protocol: str(n.protocol, 20) } : null; }
    case "pill": { const t = str(n.text, 40); return t ? { type: "pill", text: t, tone: tone(n.tone) } : null; }
    case "callout": { const t = str(n.text, 400); return t ? { type: "callout", text: t, tone: tone(n.tone) } : null; }
    case "divider": return { type: "divider" };
    case "stat": { const l = str(n.label, 60), v = str(n.value, 120); return l && v ? { type: "stat", label: l, value: v, sub: str(n.sub, 120), tone: tone(n.tone), size: ["s", "m", "l", "xl"].includes(n.size as string) ? n.size as "s" : undefined } : null; }
    case "gauge": { const l = str(n.label, 60), v = str(n.value), m = str(n.max); return l && v && m ? { type: "gauge", label: l, value: v, max: m, warnAt: str(n.warnAt), dangerAt: str(n.dangerAt), format: fmtOf(n.format), caption: str(n.caption, 200) } : null; }
    case "track": {
      const markers = Array.isArray(n.markers) ? n.markers.map((m) => ({ label: str(m?.label, 30) ?? "", value: str(m?.value) ?? "", tone: tone(m?.tone) })).filter((m) => m.label && m.value).slice(0, 6) : [];
      return markers.length >= 2 ? { type: "track", markers, format: fmtOf(n.format), caption: str(n.caption, 200) } : null;
    }
    case "bars": {
      const items = Array.isArray(n.items) ? n.items.map((m) => ({ label: str(m?.label, 40) ?? "", value: str(m?.value) ?? "", tone: tone(m?.tone) })).filter((m) => m.label && m.value).slice(0, 12) : [];
      return items.length ? { type: "bars", items, format: fmtOf(n.format) } : null;
    }
    case "allocation": return { type: "allocation" };
    case "legs": return pid ? { type: "legs", positionId: pid } : null;
    case "tokens": return { type: "tokens", limit: Number(n.limit) > 0 ? Math.min(50, Number(n.limit)) : undefined };
    case "table": {
      const columns = Array.isArray(n.columns) ? n.columns.map((c) => str(c, 40) ?? "").slice(0, 6) : [];
      const rows = Array.isArray(n.rows) ? n.rows.filter(Array.isArray).map((r) => (r as unknown[]).map((c) => str(c, 120) ?? "").slice(0, columns.length)).slice(0, 20) : [];
      return columns.length && rows.length ? { type: "table", columns, rows } : null;
    }
    case "action": return pid && actionOk(ctx, pid, n.actionId) ? { type: "action", positionId: pid, actionId: n.actionId as string, label: str(n.label, 40), variant: ["primary", "danger", "ghost"].includes(n.variant as string) ? n.variant as "primary" : undefined, params: nvs(n.params) } : null;
    case "whatif": {
      const inp = n.input as Record<string, unknown> | undefined;
      const outputs = Array.isArray(n.outputs) ? n.outputs.map((o) => ({ label: str(o?.label, 50) ?? "", expr: str(o?.expr) ?? "", format: fmtOf(o?.format), warnIf: str(o?.warnIf), dangerIf: str(o?.dangerIf) })).filter((o) => o.label && o.expr).slice(0, 5) : [];
      if (!pid || !inp || !str(inp.label) || !str(inp.min) || !str(inp.max) || !outputs.length) return null;
      const aid = actionOk(ctx, pid, n.actionId) ? (n.actionId as string) : undefined;
      // The slider value is only passed through if it names a real input of that action.
      const fields = aid ? ctx.snap.positions.find((p) => p.id === pid)?.actions.find((a) => a.id === aid)?.fields ?? [] : [];
      const param = typeof n.actionParam === "string" && fields.some((f) => f.name === n.actionParam) ? n.actionParam : fields.find((f) => f.kind === "amount")?.name;
      return { type: "whatif", positionId: pid, input: { label: str(inp.label, 60)!, min: str(inp.min)!, max: str(inp.max)!, step: Number(inp.step) > 0 ? Number(inp.step) : undefined, unit: str(inp.unit, 12), initial: str(inp.initial) }, outputs, actionId: aid, actionParam: param, actionLabel: aid ? str(n.actionLabel, 40) : undefined };
    }
    case "tool": return typeof n.toolId === "string" && ctx.tools.some((t) => t.id === n.toolId) ? { type: "tool", toolId: n.toolId, defaults: nvs(n.defaults) } : null;
    case "code": { const html = str(n.html, 60_000); return html ? { type: "code", html, height: Math.min(900, Math.max(80, Number(n.height) || 320)) } : null; }
    default: return null;
  }
}

export function sanitizeCard(raw: unknown, ctx: Ctx): Card | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const children = Array.isArray(c.children) ? c.children.map((x) => sanitizeNode(x, ctx)).filter((x): x is Node => !!x) : [];
  if (!children.length) return null;
  const span = [1, 2, 3, 4].includes(Number(c.span)) ? (Number(c.span) as Card["span"]) : 2;
  return { span, tone: ["plain", "danger", "warn", "calm", "accent"].includes(c.tone as string) ? c.tone as Card["tone"] : undefined, positionId: posOk(ctx, c.positionId) ? c.positionId as string : undefined, children };
}

/** Position ids a card references (for the "danger positions are never hidden" guarantee). */
export function referencedPositions(card: Card): Set<string> {
  const out = new Set<string>();
  if (card.positionId) out.add(card.positionId);
  const walk = (n: Node) => {
    if ("positionId" in n && n.positionId) out.add(n.positionId);
    if ("children" in n) n.children.forEach(walk);
  };
  card.children.forEach(walk);
  return out;
}
