"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { amt, usd } from "@/lib/ui/format";
import { TokenIcon, useHeld } from "./SwapForm";

interface Market { symbol: string; name: string; logo?: string; mark: number; change24h?: number; fundingAnnual?: number; maxLeverage: number }

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL = "So11111111111111111111111111111111111111112";

/**
 * Long / short on Phoenix: live market header, side toggle, USDC margin (SOL is swapped in
 * automatically when short of USDC), leverage, and what that means: size and liquidation.
 * Params stay the phoenix-perp tool's: market, side, collateral, leverage, slippage.
 */
export function PerpForm({ apiBase, owner, params, onChange, onSubmit }: {
  apiBase: string; owner: string; params: Record<string, string>; onChange(p: Record<string, string>): void; onSubmit(): void;
}) {
  const set = (k: string, v: string) => onChange({ ...params, [k]: v });
  const held = useHeld(apiBase, owner);
  const [mkt, setMkt] = useState<Market | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const sym = (params.market || "BTC").toUpperCase().replace(/-PERP$/, "");

  useEffect(() => {
    let live = true;
    setErr(null);
    const load = () => fetch(`${apiBase}/api/perp?market=${encodeURIComponent(sym)}`).then((r) => r.json())
      .then((j) => { if (!live) return; if (j.error) setErr(j.error); else setMkt(j); }).catch(() => live && setErr("Couldn't reach Phoenix."));
    void load();
    const id = setInterval(load, 10_000); // keep the mark price live while the form is open
    return () => { live = false; clearInterval(id); };
  }, [apiBase, sym]);

  const long = (params.side ?? "long") !== "short";
  const margin = Number(params.collateral) || 0;
  const maxLev = mkt?.maxLeverage ?? 10;
  const lev = Math.min(maxLev, Math.max(1, Number(params.leverage) || 3));
  const usdc = held.find((t) => t.mint === USDC)?.amount ?? 0;
  const sol = held.find((t) => t.mint === SOL);
  // Max margin: USDC plus what SOL could be swapped into, leaving SOL for fees.
  const solUsd = sol?.priceUsd ? Math.max(0, sol.amount - 0.02) * sol.priceUsd : 0;
  const maxMargin = Math.floor((usdc + solUsd * 0.98) * 100) / 100;
  const size = mkt && margin ? (margin * lev) / mkt.mark : 0;
  const liq = mkt ? (long ? mkt.mark * (1 - 1 / lev + 1 / (2 * maxLev)) : mkt.mark * (1 + 1 / lev - 1 / (2 * maxLev))) : 0;
  const needsSwap = margin > usdc + 1e-6;
  const ready = !!mkt && margin > 0 && margin <= maxMargin + 0.01;
  const chips = [2, 5, 10, 20].filter((x) => x <= maxLev);

  return (
    <form className="flex flex-col gap-2.5" onSubmit={(e) => { e.preventDefault(); if (ready) onSubmit(); }}>
      <button type="button" className="flex items-center gap-2.5 text-left rounded-xl bg-panel-2/60 p-2.5 hover:bg-panel-2" onClick={() => setPicking(true)}>
        <TokenIcon t={{ icon: mkt?.logo, symbol: sym }} size={30} />
        <span className="flex-1 min-w-0">
          <span className="block text-[14.5px] font-medium">{sym}-PERP <span className="text-[11px] text-faint font-normal">Phoenix</span></span>
          <span className="block text-[11.5px] text-dim truncate">{err ?? (mkt ? `${mkt.name}${mkt.fundingAnnual != null ? ` · funding ${(mkt.fundingAnnual * 100).toFixed(1)}%/yr` : ""}` : "Loading…")}</span>
        </span>
        {mkt && (
          <span className="text-right">
            <span className="block num text-[14px]">{usd(mkt.mark)}</span>
            {mkt.change24h != null && <span className={`block num text-[11px] ${mkt.change24h >= 0 ? "text-pos" : "text-danger"}`}>{mkt.change24h >= 0 ? "+" : ""}{(mkt.change24h * 100).toFixed(2)}%</span>}
          </span>
        )}
      </button>

      <div className="grid grid-cols-2 gap-1 rounded-xl bg-panel-2/60 p-1">
        {(["long", "short"] as const).map((s) => (
          <button key={s} type="button" onClick={() => set("side", s)}
            className={`h-9 rounded-lg text-[13.5px] font-medium transition-colors ${params.side === s || (!params.side && s === "long") ? (s === "long" ? "bg-pos/20 text-pos" : "bg-danger/20 text-danger") : "text-dim hover:text-chalk"}`}>
            {s === "long" ? "Long" : "Short"}
          </button>
        ))}
      </div>

      <div className="rounded-xl bg-panel-2/60 p-2.5">
        <div className="flex items-center justify-between text-[11.5px] text-faint mb-1">
          <span>Margin (USDC)</span>
          <button type="button" className="text-tape hover:underline" onClick={() => set("collateral", String(maxMargin))}>Max {usd(maxMargin)}</button>
        </div>
        <input className="w-full bg-transparent num text-[22px] outline-none placeholder:text-faint" inputMode="decimal" placeholder="0" value={params.collateral ?? ""} onChange={(e) => set("collateral", e.target.value.replace(/[^0-9.]/g, ""))} />
        <div className="text-[11.5px] text-faint">{needsSwap && margin > 0 ? `Swaps ~${amt(Math.max(0, margin - usdc))} USD of SOL first` : `${amt(usdc)} USDC in wallet`}</div>
      </div>

      <div className="rounded-xl bg-panel-2/60 p-2.5">
        <div className="flex items-center justify-between text-[11.5px] text-faint mb-1.5"><span>Leverage</span><span className="num text-[13px] text-chalk">{lev}×</span></div>
        <input type="range" min={1} max={maxLev} step={1} value={lev} onChange={(e) => set("leverage", e.target.value)} className="w-full accent-[var(--color-tape)]" />
        <div className="mt-1.5 flex gap-1.5">
          {chips.map((c) => <button key={c} type="button" className={`h-6 px-2.5 rounded-full text-[11.5px] border ${lev === c ? "border-tape text-tape" : "border-line text-dim"}`} onClick={() => set("leverage", String(c))}>{c}×</button>)}
          <span className="ml-auto text-[11px] text-faint self-center">max {maxLev}×</span>
        </div>
      </div>

      {mkt && margin > 0 && (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 px-1 text-[12px]">
          <dt className="text-faint">Size</dt><dd className="num text-right">{amt(size)} {sym} · {usd(margin * lev)}</dd>
          <dt className="text-faint">Est. liquidation</dt><dd className={`num text-right ${lev >= maxLev * 0.5 ? "text-warn" : ""}`}>{usd(liq)}</dd>
        </dl>
      )}

      <button className={`btn justify-center mt-0.5 ${long ? "btn-primary" : "btn-danger"}`} type="submit" disabled={!ready}>
        {margin > maxMargin + 0.01 ? "Not enough funds" : `Review ${long ? "long" : "short"} ${sym}`}
      </button>

      {picking && <MarketPicker apiBase={apiBase} onPick={(s) => { onChange({ ...params, market: s }); setPicking(false); }} onClose={() => setPicking(false)} />}
    </form>
  );
}

function MarketPicker({ apiBase, onPick, onClose }: { apiBase: string; onPick(symbol: string): void; onClose(): void }) {
  const [list, setList] = useState<{ symbol: string; name: string; logo?: string }[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => { void fetch(`${apiBase}/api/perp?list=1`).then((r) => r.json()).then((l) => Array.isArray(l) && setList(l)).catch(() => {}); }, [apiBase]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    const top = ["BTC", "ETH", "SOL"];
    return list.filter((m) => !t || m.symbol.toLowerCase().includes(t) || m.name.toLowerCase().includes(t))
      .sort((a, b) => (top.indexOf(b.symbol) + 1 ? 100 - top.indexOf(b.symbol) : 0) - (top.indexOf(a.symbol) + 1 ? 100 - top.indexOf(a.symbol) : 0) || a.symbol.localeCompare(b.symbol));
  }, [list, q]);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/55" onClick={onClose}>
      <div className="w-full max-w-[560px] max-h-[85vh] flex flex-col rounded-t-2xl bg-cloth border-t border-line p-3" onClick={(e) => e.stopPropagation()}>
        <input autoFocus className="input mb-2" placeholder="Search markets: BTC, NVDA, gold…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="overflow-y-auto flex flex-col">
          {shown.map((m) => (
            <button key={m.symbol} type="button" className="flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-panel text-left" onClick={() => onPick(m.symbol)}>
              <TokenIcon t={{ icon: m.logo, symbol: m.symbol }} size={26} />
              <span className="text-[13.5px] font-medium">{m.symbol}</span><span className="text-[12px] text-dim truncate">{m.name}</span>
            </button>
          ))}
          {!list.length && <p className="px-2 py-3 text-[12.5px] text-faint">Loading markets…</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
