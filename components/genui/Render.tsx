"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { Position, ToolDef } from "@/lib/core/types";
import type { Card, Fmt, Node, Tone } from "@/lib/genui/spec";
import { fmt, safeEval, template, type Scope } from "@/lib/genui/expr";
import { PROTOCOLS } from "@/lib/ui/protocols";
import { amt, pct, usd } from "@/lib/ui/format";
import { useActions } from "@/components/ActionSheet";
import { CodeFrame } from "./CodeFrame";
import { SwapForm } from "@/components/SwapForm";
import { PerpForm } from "@/components/PerpForm";
import { RichText } from "./RichText";
import { useGenData as useEnv } from "./data";

export { GenProvider } from "./data";

const SPAN = { 1: "md:col-span-1", 2: "md:col-span-2", 3: "md:col-span-2 lg:col-span-3", 4: "md:col-span-2 lg:col-span-4" } as const;
const TONE: Record<Tone, string> = { default: "text-chalk", dim: "text-dim", pos: "text-pos", neg: "text-danger", warn: "text-warn", accent: "text-tape" };
const TONE_BG: Record<Tone, string> = { default: "bg-panel-2 text-chalk", dim: "bg-panel-2 text-dim", pos: "bg-pos/12 text-pos", neg: "bg-danger/12 text-danger", warn: "bg-warn/12 text-warn", accent: "bg-tape/12 text-tape" };

export function GenCard({ card }: { card: Card }) {
  const env = useEnv();
  const scope = (card.positionId && env.scopes.get(card.positionId)) || env.global;
  const accent = card.tone === "danger" ? "danger" : card.tone === "warn" ? "warn" : undefined;
  return (
    <div className={`col-span-1 ${SPAN[card.span]}`}>
      <article className={`card h-full p-4 flex flex-col gap-3 rise ${card.tone === "accent" ? "!border-tape/40" : ""} ${card.tone === "calm" ? "!bg-panel/70" : ""}`} data-accent={accent}>
        {card.children.map((n, i) => <N key={i} n={n} scope={scope} />)}
      </article>
    </div>
  );
}

function useScope(n: { positionId?: string }, scope: Scope) {
  const env = useEnv();
  return (n.positionId && env.scopes.get(n.positionId)) || scope;
}

function N({ n, scope: parent }: { n: Node; scope: Scope }) {
  const env = useEnv();
  const scope = useScope(n as { positionId?: string }, parent);
  const t = (s?: string) => (s ? template(s, scope) : "");
  // Prose fields: addresses inside become copyable chips that wrap.
  const rt = (s?: string) => <RichText text={t(s)} />;
  switch (n.type) {
    case "row": return <div className={`flex flex-wrap gap-x-5 gap-y-3 items-center ${n.align === "between" ? "justify-between" : n.align === "end" ? "justify-end" : n.align === "center" ? "justify-center" : ""}`}>{n.children.map((c, i) => <N key={i} n={c} scope={scope} />)}</div>;
    case "stack": return <div className={`flex flex-col ${n.gap === "s" ? "gap-1" : n.gap === "l" ? "gap-4" : "gap-2"}`}>{n.children.map((c, i) => <N key={i} n={c} scope={scope} />)}</div>;
    // At most `cols` columns, fewer when the card is narrow, so values never collide.
    case "grid": return <div className="grid gap-x-4 gap-y-3" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(max(7.5rem, calc((100% - ${n.cols - 1}rem) / ${n.cols})), 1fr))` }}>{n.children.map((c, i) => <N key={i} n={c} scope={scope} />)}</div>;
    case "heading": {
      const size = { xl: "text-[34px] leading-[1.02]", l: "text-[26px] leading-[1.08]", m: "text-[19px] leading-tight", s: "text-[15px] leading-snug" }[n.size ?? "m"];
      return <h3 className={`${n.font === "sans" ? "font-sans font-semibold" : "font-serif"} ${size} text-balance`}>{t(n.text)}</h3>;
    }
    case "text": return <p className={`${TONE[n.tone ?? "default"]} ${n.size === "s" ? "text-[12.5px]" : n.size === "l" ? "text-[16px]" : "text-[14px]"} leading-snug [overflow-wrap:anywhere]`}>{rt(n.text)}</p>;
    case "eyebrow": {
      const proto = n.protocol ? PROTOCOLS[n.protocol as keyof typeof PROTOCOLS] : undefined;
      // The dot aligns with the first line when the label wraps.
      return <div className="flex items-start gap-1.5 text-[11px] leading-[1.35] uppercase tracking-[0.12em] text-dim">{proto && <span className="mt-[5px] size-1.5 shrink-0 rounded-full" style={{ background: proto.color }} />}<span>{t(n.text)}</span></div>;
    }
    case "pill": return <span className={`inline-block w-fit rounded-md px-2 py-0.5 text-[11.5px] font-semibold ${TONE_BG[n.tone ?? "default"]}`}>{t(n.text)}</span>;
    case "callout": return <p className={`rounded-lg px-3 py-2 text-[13px] leading-snug ${TONE_BG[n.tone ?? "dim"]} [overflow-wrap:anywhere]`}>{rt(n.text)}</p>;
    case "divider": return <hr className="border-line" />;
    case "field": return <Field label={t(n.label)} value={t(n.value)} copy={n.copy !== false} />;
    case "button": return <ToolBtn n={n} />;
    case "asset": return <AssetRow mint={n.mint} note={t(n.note)} />;
    case "qr": return <QR value={t(n.value)} caption={t(n.caption)} />;
    case "link": {
      const host = (() => { try { return new URL(n.url).hostname; } catch { return ""; } })();
      // The destination's domain is always visible, whatever the label says.
      return <a href={n.url} target="_blank" rel="noopener noreferrer" className="btn w-fit !text-[13px]">{t(n.label)}<span className="text-[11px] text-faint">{host}</span></a>;
    }
    case "stat": {
      const size = { s: "text-[14px]", m: "text-[18px]", l: "text-[22px]", xl: "text-[40px] font-serif !tracking-normal" }[n.size ?? "m"];
      // Stats never shrink into each other: in a row they wrap to the next line instead.
      return (
        <div className="shrink-0 max-w-full">
          {n.label && <div className="text-[11px] text-faint">{t(n.label)}</div>}
          {/* A long value (an address) wraps instead of pushing the card wider. */}
          <div className={`num ${size} ${TONE[n.tone ?? "default"]} leading-tight ${t(n.value).length > 24 ? "[overflow-wrap:anywhere]" : "whitespace-nowrap"}`}>{rt(n.value)}</div>
          {n.sub && <div className="text-[12px] text-dim [overflow-wrap:anywhere]">{rt(n.sub)}</div>}
        </div>
      );
    }
    case "gauge": return <Gauge n={n} scope={scope} />;
    case "track": return <Track n={n} scope={scope} />;
    case "bars": {
      const vals = n.items.map((it) => safeEval(it.value, scope));
      const max = Math.max(...vals.filter(isFinite).map(Math.abs), 1e-12);
      return (
        <ul className="flex flex-col gap-1.5">
          {n.items.map((it, i) => (
            <li key={i} className="grid grid-cols-[minmax(70px,auto)_1fr_auto] items-center gap-2 text-[12.5px]">
              <span className="text-dim truncate">{t(it.label)}</span>
              <span className={`h-1.5 rounded-full ${it.tone === "neg" ? "bg-danger/80" : it.tone === "warn" ? "bg-warn/80" : it.tone === "pos" ? "bg-pos/80" : "bg-tape/70"}`} style={{ width: `${isFinite(vals[i]) ? Math.max(2, (Math.abs(vals[i]) / max) * 100) : 0}%` }} />
              <span className="num">{fmt(vals[i], n.format ?? "num")}</span>
            </li>
          ))}
        </ul>
      );
    }
    case "allocation": return <Allocation />;
    case "legs": { const p = env.snap.positions.find((x) => x.id === n.positionId); return p ? <Legs p={p} /> : null; }
    case "tokens": return <Tokens limit={n.limit} />;
    case "table": return (
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-[12.5px]">
          <thead><tr>{n.columns.map((c, i) => <th key={i} className={`px-1 pb-1.5 font-normal text-faint ${i ? "text-right" : "text-left"}`}>{t(c)}</th>)}</tr></thead>
          <tbody className="divide-y divide-line">{n.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={`px-1 py-1.5 [overflow-wrap:anywhere] ${j ? "text-right num" : ""}`}>{rt(c)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
    case "action": return <ActionBtn n={n} />;
    case "whatif": return <WhatIf n={n} scope={scope} />;
    case "tool": { const tool = env.tools.find((x) => x.id === n.toolId); return tool ? <ToolForm tool={tool} defaults={n.defaults} /> : null; }
    case "code": return <CodeFrame html={n.html} height={n.height} />;
  }
}

function Gauge({ n, scope }: { n: Extract<Node, { type: "gauge" }>; scope: Scope }) {
  const v = safeEval(n.value, scope), max = safeEval(n.max, scope), warn = safeEval(n.warnAt, scope), danger = safeEval(n.dangerAt, scope);
  // "pct" expects fractions (0.8 → 80%); a gauge whose max is above 1.5 was written in percent units (80 of 92).
  const f = (n.format === "pct" && max > 1.5 ? "pct100" : n.format ?? "num") as Fmt;
  const pctOf = (x: number) => (isFinite(x) && max > 0 ? Math.min(100, Math.max(0, (x / max) * 100)) : 0);
  // Higher = worse when the danger mark sits above the warn mark (LTV); otherwise lower = worse (health).
  const rising = !isFinite(warn) || !isFinite(danger) || danger >= warn;
  const bad = isFinite(danger) && (rising ? v >= danger : v <= danger);
  const meh = isFinite(warn) && (rising ? v >= warn : v <= warn);
  const color = bad ? "var(--color-danger)" : meh ? "var(--color-warn)" : "var(--color-pos)";
  return (
    <div>
      <div className="flex justify-between text-[11.5px] mb-1.5"><span className="text-faint">{template(n.label, scope)}</span><span className="num" style={{ color }}>{fmt(v, f)} <span className="text-faint">/ {fmt(max, f)}</span></span></div>
      <div className="relative h-2 rounded-full bg-cloth">
        <div className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500" style={{ width: `${pctOf(v)}%`, background: color }} />
        {isFinite(warn) && <span className="absolute -top-1 h-4 w-px bg-warn/70" style={{ left: `${pctOf(warn)}%` }} />}
        {isFinite(danger) && <span className="absolute -top-1 h-4 w-px bg-danger" style={{ left: `${pctOf(danger)}%` }} />}
      </div>
      {n.caption && <p className="mt-1.5 text-[12px] text-dim">{template(n.caption, scope)}</p>}
    </div>
  );
}

function Track({ n, scope }: { n: Extract<Node, { type: "track" }>; scope: Scope }) {
  const ms = n.markers.map((m) => ({ ...m, v: safeEval(m.value, scope) })).filter((m) => isFinite(m.v));
  if (ms.length < 2) return null;
  const lo = Math.min(...ms.map((m) => m.v)), hi = Math.max(...ms.map((m) => m.v));
  const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.05 || 1;
  const pos = (x: number) => ((x - (lo - pad)) / (hi - lo + 2 * pad)) * 100;
  const color = (tone?: Tone) => (tone === "neg" ? "var(--color-danger)" : tone === "pos" ? "var(--color-pos)" : tone === "warn" ? "var(--color-warn)" : tone === "dim" ? "var(--color-dim)" : tone === "accent" ? "var(--color-tape)" : "var(--color-chalk)");
  const sorted = [...ms].sort((a, b) => a.v - b.v);
  return (
    <div>
      <div className="relative h-12 mx-6">
        <div className="absolute top-[22px] inset-x-[-24px] h-px bg-line" />
        {sorted.map((m, i) => (
          <div key={i} className="absolute -translate-x-1/2 flex flex-col items-center" style={{ left: `${pos(m.v)}%`, top: i % 2 ? 14 : 0 }}>
            {i % 2 === 0 && <span className="text-[10px] text-faint leading-none mb-1">{m.label}</span>}
            <span className="h-3 w-[2px] rounded" style={{ background: color(m.tone) }} />
            <span className="num text-[10.5px] whitespace-nowrap mt-0.5" style={{ color: color(m.tone) }}>{fmt(m.v, n.format ?? "price")}</span>
            {i % 2 === 1 && <span className="text-[10px] text-faint leading-none mt-0.5">{m.label}</span>}
          </div>
        ))}
      </div>
      {n.caption && <p className="mt-2 text-[12px] text-dim">{template(n.caption, scope)}</p>}
    </div>
  );
}

function Allocation() {
  const { snap } = useEnv();
  const buckets = new Map<string, number>();
  const tokenTotal = snap.tokens.reduce((s, t) => s + (t.valueUsd ?? 0), 0);
  if (tokenTotal > 0) buckets.set("wallet", tokenTotal);
  for (const p of snap.positions) if (p.kind !== "order" && p.valueUsd > 0) buckets.set(p.protocol, (buckets.get(p.protocol) ?? 0) + p.valueUsd);
  const total = [...buckets.values()].reduce((a, b) => a + b, 0) || 1;
  const rows = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
  const meta = (k: string) => PROTOCOLS[k as keyof typeof PROTOCOLS] ?? { name: k, color: "#888" };
  return (
    <div>
      <div className="flex h-2 rounded-full overflow-hidden bg-cloth">{rows.map(([k, v]) => <div key={k} style={{ width: `${(v / total) * 100}%`, background: meta(k).color }} />)}</div>
      <ul className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1">
        {rows.slice(0, 8).map(([k, v]) => (
          <li key={k} className="flex items-center justify-between text-[12.5px]">
            <span className="flex items-center gap-1.5 text-dim"><span className="size-1.5 rounded-full" style={{ background: meta(k).color }} />{meta(k).name}</span>
            <span className="num">{usd(v, true)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Legs({ p }: { p: Position }) {
  return (
    <ul className="flex flex-col gap-1">
      {p.legs.map((l, i) => (
        <li key={i} className="flex items-baseline justify-between gap-2 text-[13px]">
          <span className="truncate"><span className={`text-[10.5px] uppercase tracking-wider mr-1.5 ${l.side === "borrow" || l.side === "short" ? "text-warn" : "text-faint"}`}>{l.side}</span><span className="num">{amt(l.amount)}</span> <span className="text-dim">{l.symbol}</span></span>
          <span className="flex gap-3 shrink-0">
            {l.apy != null && <span className={`num text-[12px] ${l.side === "borrow" ? "text-warn" : "text-pos"}`}>{pct(l.apy)}</span>}
            <span className="num text-dim w-20 text-right">{usd(l.valueUsd)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Tokens({ limit }: { limit?: number }) {
  const { snap } = useEnv();
  const [all, setAll] = useState(false);
  const n = limit ?? 8;
  const list = all ? snap.tokens : snap.tokens.slice(0, n);
  return (
    <div>
      <ul className="flex flex-col gap-2">
        {list.map((t) => (
          <li key={t.mint} className="flex items-center gap-2.5 text-[13.5px]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {t.icon ? <img src={t.icon} alt="" className="size-5 rounded-full bg-cloth" /> : <span className="size-5 rounded-full bg-panel-2" />}
            <span className="flex-1 truncate">{t.symbol}</span>
            <span className="num text-dim">{amt(t.amount)}</span>
            <span className="num w-20 text-right">{usd(t.valueUsd)}</span>
          </li>
        ))}
      </ul>
      {snap.tokens.length > n && <button className="mt-2.5 text-[12px] text-dim hover:text-chalk" onClick={() => setAll((a) => !a)}>{all ? "Show fewer" : `Show all ${snap.tokens.length}`}</button>}
      {!snap.tokens.length && <p className="text-[13px] text-faint">No tokens.</p>}
    </div>
  );
}

interface AssetInfo { mint: string; symbol: string; name: string; icon?: string; price?: number; change24h?: number; registered: boolean; verified: boolean }
const assetCache = new Map<string, Promise<AssetInfo | null>>();

/** Any token the AI mentions: what it is, its price, whether it's vetted, and one tap to buy. */
function AssetRow({ mint, note }: { mint: string; note?: string }) {
  const { tools, snap } = useEnv();
  const { open, apiBase } = useActions();
  const [a, setA] = useState<AssetInfo | null | undefined>(undefined);
  useEffect(() => {
    if (!assetCache.has(mint)) assetCache.set(mint, fetch(`${apiBase}/api/token?mint=${mint}`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
    let live = true;
    void assetCache.get(mint)!.then((x) => live && setA(x));
    return () => { live = false; };
  }, [mint, apiBase]);
  const swap = tools.find((x) => x.id === "swap");
  const held = snap.tokens.find((x) => x.mint === mint)?.amount;
  const usdc = snap.tokens.find((x) => x.symbol === "USDC")?.valueUsd ?? 0;
  const vetted = !!a && (a.registered || a.verified);
  if (a === undefined) return <div className="h-10 rounded-lg bg-panel-2 animate-pulse" />;
  if (!a) return null;
  return (
    <div className="flex items-center gap-2.5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {a.icon ? <img src={a.icon} alt="" className="size-8 rounded-full bg-panel-2 shrink-0" /> : <span className="size-8 rounded-full bg-panel-2 shrink-0" />}
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-1 text-[13.5px] font-medium">{a.symbol}
          {a.registered ? <span title="Registered on tokens.xyz" className="inline-flex size-[14px] items-center justify-center rounded-full bg-tape text-on-tape text-[8.5px] font-bold">✓</span>
            : a.verified ? <span className="text-[11px] text-dim">✓</span> : <span className="rounded px-1 text-[10px] font-semibold bg-warn/15 text-warn">Unverified</span>}
        </span>
        <span className="block text-[11.5px] text-dim truncate">{held ? `You hold ${amt(held)}` : note || a.name}</span>
      </span>
      {a.price != null && (
        <span className="text-right shrink-0">
          <span className="block num text-[12.5px]">{a.price < 1 ? `$${a.price.toPrecision(3)}` : usd(a.price)}</span>
          {a.change24h != null && <span className={`block num text-[10.5px] ${a.change24h >= 0 ? "text-pos" : "text-danger"}`}>{a.change24h >= 0 ? "+" : ""}{a.change24h.toFixed(1)}%</span>}
        </span>
      )}
      {swap && vetted && <button className="btn btn-primary !py-1 !px-3 !text-[12px] shrink-0" onClick={() => open({ kind: "tool", tool: swap, params: { from: usdc >= 5 ? "USDC" : "SOL", to: mint }, form: true })}>Buy</button>}
    </div>
  );
}

function ToolBtn({ n }: { n: Extract<Node, { type: "button" }> }) {
  const { tools } = useEnv();
  const { open } = useActions();
  const tool = tools.find((t) => t.id === n.toolId);
  if (!tool) return null;
  const params = Object.fromEntries((n.params ?? []).map((x) => [x.name, x.value]));
  const go = () => open({ kind: "tool", tool, params, form: true });
  // With a subtitle it's a full-width row (lists of next steps / options); without, a plain button.
  return n.sub
    ? <button className="w-full flex items-center gap-3 rounded-lg bg-panel-2 hover:bg-line px-3 py-2.5 text-left transition-colors" onClick={go}>
        <span className="flex-1 min-w-0"><span className="block text-[14px] font-medium truncate">{n.label}</span><span className="block text-[12px] text-dim truncate">{n.sub}</span></span><span className="text-faint">›</span>
      </button>
    : <button className={`btn ${n.variant === "primary" ? "btn-primary" : ""}`} onClick={go}>{n.label}</button>;
}

function ActionBtn({ n }: { n: Extract<Node, { type: "action" }> }) {
  const { snap } = useEnv();
  const { open } = useActions();
  const p = snap.positions.find((x) => x.id === n.positionId);
  const a = p?.actions.find((x) => x.id === n.actionId);
  if (!p || !a) return null;
  const variant = n.variant ?? (a.danger ? "danger" : "ghost");
  const params = n.params?.length ? Object.fromEntries(n.params.map((x) => [x.name, x.value])) : undefined;
  return <button className={`btn ${variant === "primary" ? "btn-primary" : variant === "danger" ? "btn-danger" : ""}`} onClick={() => open({ kind: "action", position: p, action: a, params })}>{n.label ?? a.label}</button>;
}

function WhatIf({ n, scope }: { n: Extract<Node, { type: "whatif" }>; scope: Scope }) {
  const { snap } = useEnv();
  const { open } = useActions();
  const min = safeEval(n.input.min, scope), max = safeEval(n.input.max, scope);
  const init = safeEval(n.input.initial, scope);
  const [x, setX] = useState(() => (isFinite(init) ? init : isFinite(min) ? min : 0));
  if (!isFinite(min) || !isFinite(max) || max <= min) return null;
  const step = n.input.step ?? (max - min) / 200;
  const s = { ...scope, x };
  const p = snap.positions.find((q) => q.id === n.positionId);
  const a = n.actionId ? p?.actions.find((q) => q.id === n.actionId) : undefined;
  return (
    <div className="rounded-xl border border-line bg-cloth/60 p-3 flex flex-col gap-2.5">
      <div className="flex justify-between text-[12px]"><span className="text-dim">{template(n.input.label, scope)}</span><span className="num text-chalk">{fmt(x, "num")}{n.input.unit ? ` ${n.input.unit}` : ""}</span></div>
      <input type="range" min={min} max={max} step={step} value={x} onChange={(e) => setX(Number(e.target.value))} className="w-full accent-[var(--color-tape)]" />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(100px,1fr))] gap-2">
        {n.outputs.map((o, i) => {
          const v = safeEval(o.expr, s);
          const tone = safeEval(o.dangerIf, s) ? "text-danger" : safeEval(o.warnIf, s) ? "text-warn" : "text-chalk";
          return <div key={i}><div className="text-[11px] text-faint">{template(o.label, scope)}</div><div className={`num text-[15px] ${tone}`}>{fmt(v, o.format ?? "num")}</div></div>;
        })}
      </div>
      {p && a && (
        <button className={`btn ${a.danger ? "btn-danger" : "btn-primary"} justify-center`} disabled={x <= 0}
          onClick={() => open({ kind: "action", position: p, action: a, params: n.actionParam ? { [n.actionParam]: String(Number(x.toPrecision(8))) } : undefined })}>
          {n.actionLabel ? template(n.actionLabel.replace(/\bx\b/g, "{{x|num}}"), s) : `${a.label}: ${fmt(x, "num")}${n.input.unit ? ` ${n.input.unit}` : ""}`}
        </button>
      )}
    </div>
  );
}

function ToolForm({ tool, defaults }: { tool: ToolDef; defaults?: { name: string; value: string }[] }) {
  const { open, apiBase, owner } = useActions();
  const [params, setParams] = useState<Record<string, string>>(() => Object.fromEntries(tool.fields.map((f) => [f.name, defaults?.find((d) => d.name === f.name)?.value ?? f.default ?? ""])));
  if (tool.id === "swap") return <SwapForm apiBase={apiBase} owner={owner} params={params} onChange={setParams} onSubmit={() => open({ kind: "tool", tool, params })} />;
  if (tool.id === "phoenix-perp") return <PerpForm apiBase={apiBase} owner={owner} params={params} onChange={setParams} onSubmit={() => open({ kind: "tool", tool, params })} />;
  return (
    <form className="flex flex-col gap-2.5" onSubmit={(e) => { e.preventDefault(); open({ kind: "tool", tool, params }); }}>
      <div className="grid grid-cols-2 gap-2.5">
        {tool.fields.map((f) => (
          <label key={f.name} className="flex flex-col gap-1 text-[11.5px] text-dim">
            {f.label}
            {f.kind === "select" && f.options ? (
              <select className="input" value={params[f.name]} onChange={(e) => setParams((p) => ({ ...p, [f.name]: e.target.value }))}>
                {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input className={`input ${f.kind !== "text" ? "num" : ""}`} value={params[f.name]} onChange={(e) => setParams((p) => ({ ...p, [f.name]: e.target.value }))} />
            )}
          </label>
        ))}
      </div>
      <button className="btn btn-primary justify-center" type="submit">{tool.label}</button>
    </form>
  );
}

/** A value the user will reuse: shown in full (never truncated, so what you see is what you copy) with one-tap copy. */
function Field({ label, value, copy }: { label?: string; value: string; copy: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      {label && <div className="text-[11px] text-faint">{label}</div>}
      <div className="flex items-center gap-2 rounded-lg bg-panel-2 pl-3 pr-1.5 py-1.5">
        <span className="num flex-1 min-w-0 text-[13px] leading-snug [overflow-wrap:anywhere] select-all">{value}</span>
        {copy && (
          <button type="button" className={`btn !py-1 !px-2.5 !text-[12px] shrink-0 ${copied ? "!text-pos" : ""}`}
            onClick={() => { void navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
    </div>
  );
}

function QR({ value, caption }: { value: string; caption?: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => { void QRCode.toDataURL(value, { margin: 1, width: 360, color: { dark: "#000000", light: "#ffffff" } }).then(setSrc).catch(() => setSrc("")); }, [value]);
  return (
    <figure className="flex flex-col items-center gap-1.5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src ? <img src={src} alt={caption || "QR code"} width={168} height={168} className="rounded-lg" /> : <div className="size-[168px] rounded-lg bg-panel-2" />}
      {caption && <figcaption className="text-[11.5px] text-dim text-center">{caption}</figcaption>}
    </figure>
  );
}
