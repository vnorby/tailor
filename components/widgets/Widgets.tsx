"use client";

import { useState } from "react";
import type { Position, Snapshot, ToolDef, Widget } from "@/lib/core/types";
import { PositionCard, ActionRow } from "@/components/cards/PositionCard";
import { useActions } from "@/components/ActionSheet";
import { PROTOCOLS } from "@/lib/ui/protocols";
import { ago, amt, usd } from "@/lib/ui/format";

const SPAN: Record<Widget["size"], string> = {
  s: "md:col-span-1", m: "md:col-span-2", l: "md:col-span-2 lg:col-span-3", xl: "md:col-span-2 lg:col-span-4",
};

export function WidgetView({ w, snap, tools }: { w: Widget; snap: Snapshot; tools: ToolDef[] }) {
  const byId = new Map(snap.positions.map((p) => [p.id, p]));
  const positions = (w.positionIds ?? []).map((id) => byId.get(id)).filter((p): p is Position => !!p);
  const inner = (() => {
    switch (w.type) {
      case "position": return positions[0] ? <PositionCard p={positions[0]} note={w.note} accent={w.accent} /> : null;
      case "alert": return <Alert w={w} positions={positions} />;
      case "summary": return <Summary w={w} snap={snap} />;
      case "group": return <Group w={w} positions={positions} />;
      case "tokens": return <Tokens w={w} snap={snap} />;
      case "tool": { const t = tools.find((x) => x.id === w.toolId); return t ? <Tool w={w} tool={t} /> : null; }
      case "activity": return <ActivityCard w={w} snap={snap} />;
      case "note": return <div className="card h-full p-4 rise"><p className="font-serif italic text-[19px] leading-snug text-chalk/90">{w.note ?? w.title}</p></div>;
    }
  })();
  if (!inner) return null;
  return <div className={`col-span-1 ${SPAN[w.size]}`}>{inner}</div>;
}

function Title({ w, fallback }: { w: Widget; fallback: string }) {
  return (
    <div className="mb-3">
      <h3 className="text-[11px] uppercase tracking-[0.12em] text-dim">{w.title ?? fallback}</h3>
      {w.note && <p className="mt-1 text-[13px] text-dim leading-snug">{w.note}</p>}
    </div>
  );
}

function Alert({ w, positions }: { w: Widget; positions: Position[] }) {
  const danger = (w.accent ?? "danger") === "danger";
  return (
    <section className="card h-full p-4 rise" data-accent={danger ? "danger" : "warn"}>
      <div className={`text-[11px] uppercase tracking-[0.14em] font-semibold ${danger ? "text-danger" : "text-warn"}`}>{w.title ?? (danger ? "Needs attention now" : "Keep an eye on")}</div>
      {w.note && <p className="mt-1.5 text-[15px] leading-snug">{w.note}</p>}
      <ul className="mt-3 flex flex-col divide-y divide-line">
        {positions.map((p) => (
          <li key={p.id} className="py-2.5 flex flex-col sm:flex-row sm:items-center gap-2 justify-between">
            <div className="min-w-0">
              <span className="text-[14px] font-medium">{p.title}</span> <span className="text-[12px] text-dim">· {PROTOCOLS[p.protocol].name}</span>
              {p.risk.reason && <p className="text-[12.5px] text-dim">{p.risk.reason}</p>}
            </div>
            <ActionRow p={p} limit={3} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Summary({ w, snap }: { w: Widget; snap: Snapshot }) {
  // Allocation by protocol, tokens counted as "wallet".
  const buckets = new Map<string, number>();
  const tokenTotal = snap.tokens.reduce((s, t) => s + (t.valueUsd ?? 0), 0);
  if (tokenTotal > 0) buckets.set("wallet", tokenTotal);
  for (const p of snap.positions) if (p.kind !== "order" && p.valueUsd > 0) buckets.set(p.protocol, (buckets.get(p.protocol) ?? 0) + p.valueUsd);
  const total = [...buckets.values()].reduce((a, b) => a + b, 0) || 1;
  const rows = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
  const pnl = snap.positions.reduce((s, p) => s + (p.pnlUsd ?? 0), 0);
  return (
    <section className="card h-full p-4 rise">
      <Title w={w} fallback="Net worth" />
      <div className="flex items-baseline gap-3">
        <span className="font-serif text-[44px] leading-none">{usd(snap.netWorthUsd)}</span>
        {pnl !== 0 && <span className={`num text-[13px] ${pnl >= 0 ? "text-pos" : "text-danger"}`}>{pnl >= 0 ? "+" : ""}{usd(pnl)} open PnL</span>}
      </div>
      <div className="mt-4 flex h-2 rounded-full overflow-hidden bg-cloth">
        {rows.map(([k, v]) => <div key={k} style={{ width: `${(v / total) * 100}%`, background: PROTOCOLS[k as keyof typeof PROTOCOLS]?.color ?? "#888" }} title={k} />)}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1">
        {rows.slice(0, 8).map(([k, v]) => (
          <li key={k} className="flex items-center justify-between text-[12.5px]">
            <span className="flex items-center gap-1.5 text-dim"><span className="size-1.5 rounded-full" style={{ background: PROTOCOLS[k as keyof typeof PROTOCOLS]?.color }} />{PROTOCOLS[k as keyof typeof PROTOCOLS]?.name ?? k}</span>
            <span className="num">{((v / total) * 100).toFixed(0)}%</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Group({ w, positions }: { w: Widget; positions: Position[] }) {
  const { open } = useActions();
  return (
    <section className="card h-full p-4 rise" data-accent={w.accent}>
      <Title w={w} fallback="Positions" />
      <ul className="flex flex-col divide-y divide-line">
        {positions.map((p) => (
          <li key={p.id} className="py-2 flex items-center gap-3">
            <span className="size-1.5 rounded-full shrink-0" style={{ background: PROTOCOLS[p.protocol].color }} />
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] truncate">{p.title}</div>
              <div className="text-[11.5px] text-dim truncate">{p.subtitle ?? PROTOCOLS[p.protocol].name}{p.risk.level !== "ok" && p.risk.reason ? ` · ${p.risk.reason}` : ""}</div>
            </div>
            <span className="num text-[13px]">{usd(p.valueUsd)}</span>
            {p.actions[0] && <button className={`btn !px-2 !py-1 text-[12px] ${p.actions[0].danger ? "btn-danger" : ""}`} onClick={() => open({ kind: "action", position: p, action: p.actions[0] })}>{p.actions[0].label}</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Tokens({ w, snap }: { w: Widget; snap: Snapshot }) {
  const [all, setAll] = useState(false);
  const list = all ? snap.tokens : snap.tokens.slice(0, 8);
  return (
    <section className="card h-full p-4 rise">
      <Title w={w} fallback="Wallet" />
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
      {snap.tokens.length > 8 && <button className="mt-3 text-[12px] text-dim hover:text-chalk" onClick={() => setAll((a) => !a)}>{all ? "Show fewer" : `Show all ${snap.tokens.length}`}</button>}
      {!snap.tokens.length && <p className="text-[13px] text-faint">No tokens.</p>}
    </section>
  );
}

function Tool({ w, tool }: { w: Widget; tool: ToolDef }) {
  const { open } = useActions();
  const [params, setParams] = useState<Record<string, string>>(() => Object.fromEntries(tool.fields.map((f) => [f.name, w.toolDefaults?.[f.name] ?? f.default ?? ""])));
  return (
    <section className="card h-full p-4 rise">
      <Title w={w} fallback={tool.label} />
      <form className="flex flex-col gap-2.5" onSubmit={(e) => { e.preventDefault(); open({ kind: "tool", tool, params }); }}>
        <div className="grid grid-cols-2 gap-2.5">
          {tool.fields.map((f) => (
            <label key={f.name} className={`flex flex-col gap-1 text-[11.5px] text-dim ${f.kind === "amount" && tool.fields.length % 2 ? "col-span-2" : ""}`}>
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
        <button className="btn btn-primary justify-center" type="submit">Preview {tool.label.toLowerCase()}</button>
      </form>
    </section>
  );
}

function ActivityCard({ w, snap }: { w: Widget; snap: Snapshot }) {
  const src = Object.entries(snap.activity.bySource).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const max = src[0]?.[1] ?? 1;
  return (
    <section className="card h-full p-4 rise">
      <Title w={w} fallback="What you do" />
      <p className="text-[12.5px] text-dim mb-3">{snap.activity.txCount} recent transactions{snap.activity.lastActiveAt ? ` · last ${ago(snap.activity.lastActiveAt)}` : ""}</p>
      <ul className="flex flex-col gap-1.5">
        {src.map(([k, v]) => (
          <li key={k} className="grid grid-cols-[90px_1fr_32px] items-center gap-2 text-[12px]">
            <span className="truncate text-dim">{k.toLowerCase().replace(/_/g, " ")}</span>
            <span className="h-1.5 rounded-full bg-tape/70" style={{ width: `${(v / max) * 100}%` }} />
            <span className="num text-right">{v}</span>
          </li>
        ))}
        {!src.length && <li className="text-[12.5px] text-faint">No recent activity.</li>}
      </ul>
    </section>
  );
}
