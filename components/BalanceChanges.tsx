"use client";

import { amt, usd } from "@/lib/ui/format";

export interface Preview {
  ok: boolean; error?: string; feeLamports: number;
  changes: { mint: string; symbol: string; name?: string; icon?: string; decimals: number; delta: number; usd?: number }[];
  programs: { id: string; name?: string }[];
  warnings: string[];
}

/** Simulated effect of a transaction on the wallet: what goes out, what comes in. */
export function BalanceChanges({ preview, compact }: { preview: Preview; compact?: boolean }) {
  if (!preview.ok) return <p className="text-[13px] text-danger">Simulation failed: {preview.error}</p>;
  const rows = preview.changes.filter((c) => Math.abs(c.delta) > 0);
  return (
    <div className="rounded-xl border border-line bg-cloth/60 p-3 flex flex-col gap-2">
      <div className="text-[11px] uppercase tracking-[0.12em] text-faint">Estimated balance changes</div>
      {rows.length === 0 && <p className="text-[13px] text-dim">No token balance changes besides the network fee.</p>}
      {rows.map((c) => (
        <div key={c.mint} className="flex items-center gap-2.5 text-[14px]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {c.icon ? <img src={c.icon} alt="" className="size-5 rounded-full bg-panel-2" /> : <span className="size-5 rounded-full bg-panel-2" />}
          <span className="flex-1 truncate">{c.symbol}</span>
          <span className={`num ${c.delta > 0 ? "text-pos" : "text-danger"}`}>{c.delta > 0 ? "+" : "−"}{amt(Math.abs(c.delta), 6)}</span>
          {c.usd != null && !compact && <span className="num text-[12px] text-dim w-20 text-right">{usd(Math.abs(c.usd))}</span>}
        </div>
      ))}
      <div className="flex justify-between text-[12px] text-faint"><span>Network fee</span><span className="num">{(preview.feeLamports / 1e9).toFixed(6)} SOL</span></div>
      {preview.warnings.map((w) => <p key={w} className="text-[12.5px] text-warn">⚠ {w}</p>)}
    </div>
  );
}
