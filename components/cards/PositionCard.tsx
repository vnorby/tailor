"use client";

import type { Action, Leg, Position } from "@/lib/core/types";
import { PROTOCOLS } from "@/lib/ui/protocols";
import { amt, pct, usd } from "@/lib/ui/format";
import { useActions } from "@/components/ActionSheet";

/** Picks the card for a position by kind; every card shares header + metrics + action row. */
export function PositionCard({ p, note, accent, compact }: { p: Position; note?: string; accent?: string; compact?: boolean }) {
  const body = (() => {
    switch (p.kind) {
      case "lending": return <LendingBody p={p} />;
      case "perp": return <PerpBody p={p} />;
      case "prediction": return <PredictionBody p={p} />;
      case "order": return <OrderBody p={p} />;
      default: return <LegsBody p={p} />;
    }
  })();
  return (
    <article className="card h-full flex flex-col p-4 gap-3 rise" data-accent={accent ?? (p.risk.level === "danger" ? "danger" : p.risk.level === "watch" ? "warn" : undefined)}>
      <Header p={p} />
      {note && <p className="text-[13px] text-dim leading-snug">{note}</p>}
      {!compact && body}
      {!compact && p.metrics.length > 0 && <Metrics p={p} />}
      <div className="mt-auto pt-1"><ActionRow p={p} /></div>
    </article>
  );
}

function Header({ p }: { p: Position }) {
  const proto = PROTOCOLS[p.protocol];
  return (
    <header className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] text-dim">
          <span className="size-1.5 rounded-full" style={{ background: proto.color }} />
          {proto.name}
          {p.risk.level !== "ok" && <RiskPill level={p.risk.level} />}
        </div>
        <h3 className="mt-1 text-[17px] font-semibold leading-tight truncate">{p.title}</h3>
        {p.subtitle && <p className="text-[12.5px] text-dim truncate">{p.subtitle}</p>}
      </div>
      <div className="text-right shrink-0">
        <div className="num text-[17px]">{usd(p.valueUsd)}</div>
        {p.pnlUsd != null && <div className={`num text-[12px] ${p.pnlUsd >= 0 ? "text-pos" : "text-danger"}`}>{p.pnlUsd >= 0 ? "+" : ""}{usd(p.pnlUsd)}</div>}
      </div>
    </header>
  );
}

function RiskPill({ level }: { level: "watch" | "danger" }) {
  return <span className={`ml-1 rounded px-1.5 py-px text-[10px] font-semibold tracking-wider ${level === "danger" ? "bg-danger/15 text-danger" : "bg-warn/15 text-warn"}`}>{level === "danger" ? "AT RISK" : "WATCH"}</span>;
}

function Metrics({ p }: { p: Position }) {
  return (
    <dl className="grid grid-cols-[repeat(auto-fit,minmax(90px,1fr))] gap-x-4 gap-y-2">
      {p.metrics.map((m) => (
        <div key={m.label}>
          <dt className="text-[11px] text-faint">{m.label}</dt>
          <dd className={`num text-[13px] ${m.tone === "pos" ? "text-pos" : m.tone === "neg" ? "text-danger" : m.tone === "warn" ? "text-warn" : m.tone === "muted" ? "text-dim" : ""}`}>{m.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function HealthBar({ p }: { p: Position }) {
  const h = p.risk.healthPct;
  if (h == null) return null;
  const color = p.risk.level === "danger" ? "var(--color-danger)" : p.risk.level === "watch" ? "var(--color-warn)" : "var(--color-pos)";
  return (
    <div>
      <div className="flex justify-between text-[11px] text-faint mb-1"><span>Health</span><span className="num" style={{ color }}>{h.toFixed(0)}%</span></div>
      <div className="h-1.5 rounded-full bg-cloth overflow-hidden"><div className="h-full rounded-full transition-[width]" style={{ width: `${Math.max(2, h)}%`, background: color }} /></div>
      {p.risk.reason && <p className="mt-1.5 text-[12px] text-dim">{p.risk.reason}</p>}
    </div>
  );
}

function LegRow({ l }: { l: Leg }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[13px]">
      <span className="truncate"><span className="num">{amt(l.amount)}</span> <span className="text-dim">{l.symbol}</span></span>
      <span className="flex gap-3 shrink-0">
        {l.apy != null && <span className={`num text-[12px] ${l.side === "borrow" ? "text-warn" : "text-pos"}`}>{pct(l.apy)}</span>}
        <span className="num text-dim w-20 text-right">{usd(l.valueUsd)}</span>
      </span>
    </div>
  );
}

function LendingBody({ p }: { p: Position }) {
  const supply = p.legs.filter((l) => l.side === "supply");
  const borrow = p.legs.filter((l) => l.side === "borrow");
  return (
    <div className="flex flex-col gap-3">
      <HealthBar p={p} />
      <div className="grid gap-3 sm:grid-cols-2">
        <section><h4 className="text-[11px] uppercase tracking-wider text-faint mb-1">Supplied</h4>{supply.map((l) => <LegRow key={l.symbol} l={l} />)}{!supply.length && <p className="text-[12px] text-faint">—</p>}</section>
        <section><h4 className="text-[11px] uppercase tracking-wider text-faint mb-1">Borrowed</h4>{borrow.map((l) => <LegRow key={l.symbol} l={l} />)}{!borrow.length && <p className="text-[12px] text-faint">—</p>}</section>
      </div>
    </div>
  );
}

function PerpBody({ p }: { p: Position }) {
  const leg = p.legs.find((l) => l.side === "long" || l.side === "short");
  const { liqPrice, markPrice } = p.risk;
  const entry = typeof p.raw?.entryPrice === "number" ? (p.raw.entryPrice as number) : undefined;
  // Track from liquidation price to a point symmetrically past mark, so distance-to-liq reads at a glance.
  let track: { liq: number; entry?: number; mark: number } | null = null;
  if (liqPrice && markPrice) {
    const span = Math.abs(markPrice - liqPrice) * 2 || 1;
    const lo = Math.min(liqPrice, markPrice + (markPrice - liqPrice));
    const pos = (x: number) => Math.max(0, Math.min(100, ((x - lo) / span) * 100));
    track = { liq: pos(liqPrice), mark: pos(markPrice), entry: entry ? pos(entry) : undefined };
  }
  return (
    <div className="flex flex-col gap-3">
      {leg && (
        <div className="flex items-center gap-2">
          <span className={`rounded-md px-2 py-0.5 text-[12px] font-semibold ${leg.side === "long" ? "bg-pos/15 text-pos" : "bg-danger/15 text-danger"}`}>{leg.side.toUpperCase()}</span>
          <span className="num text-[14px]">{amt(leg.amount)} {leg.symbol}</span>
          <span className="num text-[12px] text-dim">{usd(leg.valueUsd)} notional</span>
        </div>
      )}
      {track && (
        <div>
          <div className="relative h-8">
            <div className="absolute top-3.5 inset-x-0 h-px bg-line" />
            <Tick at={track.liq} label="Liq" value={liqPrice!} color="var(--color-danger)" />
            {track.entry != null && <Tick at={track.entry} label="Entry" value={entry!} color="var(--color-dim)" />}
            <Tick at={track.mark} label="Mark" value={markPrice!} color="var(--color-chalk)" />
          </div>
          {p.risk.reason && <p className="mt-3 text-[12px] text-dim">{p.risk.reason}</p>}
        </div>
      )}
    </div>
  );
}

function Tick({ at, label, value, color }: { at: number; label: string; value: number; color: string }) {
  return (
    <div className="absolute -translate-x-1/2 flex flex-col items-center" style={{ left: `${at}%` }}>
      <span className="text-[10px] text-faint leading-none">{label}</span>
      <span className="mt-1 h-3 w-px" style={{ background: color }} />
      <span className="num text-[10.5px] mt-0.5 whitespace-nowrap" style={{ color }}>{value >= 100 ? value.toFixed(0) : value.toPrecision(4)}</span>
    </div>
  );
}

function PredictionBody({ p }: { p: Position }) {
  const prob = typeof p.raw?.price === "number" ? (p.raw.price as number) : undefined;
  return (
    <div className="flex flex-col gap-2">
      <LegsBody p={p} />
      {prob != null && (
        <div>
          <div className="flex justify-between text-[11px] text-faint mb-1"><span>Market price</span><span className="num">{(prob * 100).toFixed(0)}¢</span></div>
          <div className="h-1.5 rounded-full bg-cloth overflow-hidden"><div className="h-full bg-tape" style={{ width: `${prob * 100}%` }} /></div>
        </div>
      )}
    </div>
  );
}

function OrderBody({ p }: { p: Position }) {
  return <LegsBody p={p} />;
}

function LegsBody({ p }: { p: Position }) {
  if (!p.legs.length) return null;
  return <div className="flex flex-col gap-1">{p.legs.map((l, i) => <LegRow key={`${l.symbol}${i}`} l={l} />)}</div>;
}

export function ActionRow({ p, limit }: { p: Position; limit?: number }) {
  const { open } = useActions();
  const acts = limit ? p.actions.slice(0, limit) : p.actions;
  if (!acts.length) return p.url ? <a className="text-[12px] text-dim hover:text-chalk" href={p.url} target="_blank" rel="noreferrer">Open in {PROTOCOLS[p.protocol].name} ↗</a> : null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {acts.map((a: Action) => (
        <button key={a.id} className={`btn ${a.danger ? "btn-danger" : ""}`} onClick={() => open({ kind: "action", position: p, action: a })}>{a.label}</button>
      ))}
      {p.url && <a className="ml-auto text-[12px] text-faint hover:text-chalk" href={p.url} target="_blank" rel="noreferrer">↗</a>}
    </div>
  );
}
