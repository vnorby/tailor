"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Action, ActionField, Position, ToolDef } from "@/lib/core/types";
import { useWallet } from "@/lib/ui/useWallet";
import { short } from "@/lib/ui/format";
import { WalletPicker } from "./WalletPicker";

type Target =
  | { kind: "action"; position: Position; action: Action; params?: Record<string, string> }
  | { kind: "tool"; tool: ToolDef; params: Record<string, string> };

interface Prepared { txs: string[]; summary: string; warnings?: string[]; simulations: { ok: boolean; error?: string }[] }

type Stage =
  | { s: "form" }
  | { s: "preparing" }
  | { s: "review"; prep: Prepared }
  | { s: "signing"; prep: Prepared; i: number; sigs: string[] }
  | { s: "done"; sigs: string[]; summary: string }
  | { s: "error"; message: string; sigs?: string[] };

const Ctx = createContext<{ open(t: Target): void } | null>(null);
export const useActions = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useActions outside ActionProvider");
  return c;
};

export function ActionProvider({ owner, onDone, children }: { owner: string; onDone(): void; children: ReactNode }) {
  const [target, setTarget] = useState<Target | null>(null);
  const open = useCallback((t: Target) => setTarget(t), []);
  return (
    <Ctx.Provider value={{ open }}>
      {children}
      {target && <Sheet key={JSON.stringify(target.kind === "action" ? [target.position.id, target.action.id] : target.tool.id)} owner={owner} target={target} onClose={(changed) => { setTarget(null); if (changed) onDone(); }} />}
    </Ctx.Provider>
  );
}

function fieldsOf(t: Target): ActionField[] {
  return t.kind === "action" ? t.action.fields ?? [] : t.tool.fields;
}

function Sheet({ owner, target, onClose }: { owner: string; target: Target; onClose(changed: boolean): void }) {
  const { account, sign } = useWallet();
  const fields = fieldsOf(target);
  const [params, setParams] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of fields) init[f.name] = target.params?.[f.name] ?? f.default ?? "";
    return init;
  });
  // Tool widgets collect their inputs inline, so they arrive ready to build.
  const direct = !fields.length || target.kind === "tool";
  const [stage, setStage] = useState<Stage>({ s: direct ? "preparing" : "form" });
  const ownerMatches = account?.address === owner;
  const label = target.kind === "action" ? target.action.label : target.tool.label;
  const danger = target.kind === "action" && target.action.danger;

  const prepare = useCallback(async () => {
    setStage({ s: "preparing" });
    try {
      const r = await fetch(target.kind === "action" ? "/api/action" : "/api/tool", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(target.kind === "action"
          ? { owner, positionId: target.position.id, actionId: target.action.id, params }
          : { owner, toolId: target.tool.id, params }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
      setStage({ s: "review", prep: j as Prepared });
    } catch (e) { setStage({ s: "error", message: e instanceof Error ? e.message : String(e) }); }
  }, [owner, params, target]);

  // Actions without inputs go straight to preparing.
  useEffect(() => {
    if (direct) void prepare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function signAll(prep: Prepared) {
    const sigs: string[] = [];
    try {
      for (let i = 0; i < prep.txs.length; i++) {
        setStage({ s: "signing", prep, i, sigs: [...sigs] });
        const signed = await sign(prep.txs[i]);
        const r = await fetch("/api/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, tx: signed }) });
        const j = await r.json();
        if (j.signature) sigs.push(j.signature);
        if (!r.ok || !j.ok) throw new Error(j.error ?? "Transaction failed.");
      }
      setStage({ s: "done", sigs, summary: prep.summary });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStage({ s: "error", message: /reject|denied|cancel/i.test(msg) ? "You cancelled in your wallet." : msg, sigs });
    }
  }

  const changed = stage.s === "done" || (stage.s === "error" && !!stage.sigs?.length);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-[2px] p-0 sm:p-6" onClick={() => onClose(changed)}>
      <div className="card w-full sm:max-w-md p-5 rounded-b-none sm:rounded-b-[14px] rise" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.12em] text-dim">{target.kind === "action" ? target.position.title : "Tool"}</p>
            <h2 className="font-serif text-[28px] leading-none mt-1">{label}</h2>
          </div>
          <button className="text-dim hover:text-chalk text-xl leading-none" onClick={() => onClose(changed)} aria-label="Close">×</button>
        </div>
        <div className="tape my-4" />

        {stage.s === "form" && (
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void prepare(); }}>
            {fields.map((f) => <Field key={f.name} f={f} value={params[f.name] ?? ""} onChange={(v) => setParams((p) => ({ ...p, [f.name]: v }))} />)}
            <button className={`btn ${danger ? "btn-danger" : "btn-primary"} justify-center mt-1`} type="submit">Preview</button>
          </form>
        )}

        {stage.s === "preparing" && <p className="text-dim text-sm py-6 text-center">Building and simulating…</p>}

        {(stage.s === "review" || stage.s === "signing") && (
          <div className="flex flex-col gap-3">
            <p className="text-[15px] leading-snug">{stage.prep.summary}</p>
            {stage.prep.warnings?.map((w) => <p key={w} className="text-[13px] text-warn">{w}</p>)}
            <ul className="flex flex-col gap-1 text-[12.5px]">
              {stage.prep.simulations.map((sim, i) => (
                <li key={i} className={sim.ok ? "text-pos" : i === 0 ? "text-danger" : "text-warn"}>
                  {stage.prep.txs.length > 1 ? `Tx ${i + 1}: ` : ""}{sim.ok ? "Simulation passed" : i === 0 ? `Simulation failed: ${sim.error}` : `Couldn't pre-simulate (depends on the previous tx): ${sim.error}`}
                </li>
              ))}
            </ul>
            {!ownerMatches ? (
              <div className="flex flex-col gap-2 mt-1">
                <p className="text-[13px] text-dim">{account ? `Connected wallet ${short(account.address)} isn't ${short(owner)}. Switch accounts in your wallet to sign.` : `Connect ${short(owner)} to sign.`}</p>
                <WalletPicker />
              </div>
            ) : (
              <button className={`btn ${danger ? "btn-danger" : "btn-primary"} justify-center`} disabled={stage.s === "signing" || !stage.prep.simulations[0]?.ok} onClick={() => stage.s === "review" && signAll(stage.prep)}>
                {stage.s === "signing" ? `Waiting for wallet${stage.prep.txs.length > 1 ? ` (${stage.i + 1}/${stage.prep.txs.length})` : ""}…` : stage.prep.txs.length > 1 ? `Sign ${stage.prep.txs.length} transactions` : "Sign & send"}
              </button>
            )}
          </div>
        )}

        {stage.s === "done" && (
          <div className="flex flex-col gap-2">
            <p className="text-pos text-[15px]">Done. {stage.summary}</p>
            {stage.sigs.map((s) => <a key={s} className="num text-[12px] text-dim hover:text-chalk" href={`https://solscan.io/tx/${s}`} target="_blank" rel="noreferrer">{short(s)} ↗</a>)}
            <button className="btn justify-center mt-2" onClick={() => onClose(true)}>Close</button>
          </div>
        )}

        {stage.s === "error" && (
          <div className="flex flex-col gap-2">
            <p className="text-danger text-[14px] break-words">{stage.message}</p>
            {stage.sigs?.map((s) => <a key={s} className="num text-[12px] text-dim" href={`https://solscan.io/tx/${s}`} target="_blank" rel="noreferrer">Landed: {short(s)} ↗</a>)}
            <button className="btn justify-center mt-2" onClick={() => setStage({ s: "form" })}>Back</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ f, value, onChange }: { f: ActionField; value: string; onChange(v: string): void }) {
  if (f.kind === "select" && f.options) {
    return (
      <label className="flex flex-col gap-1 text-[12px] text-dim">{f.label}
        <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
          {!value && <option value="">Choose…</option>}
          {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
    );
  }
  const numeric = f.kind === "amount" || f.kind === "percent" || f.kind === "price";
  return (
    <label className="flex flex-col gap-1 text-[12px] text-dim">
      <span className="flex justify-between">{f.label}{f.max != null && <button type="button" className="text-tape hover:underline" onClick={() => onChange(String(f.max))}>Max {f.max.toLocaleString("en-US", { maximumFractionDigits: 6 })}{f.unit ? ` ${f.unit}` : ""}</button>}</span>
      <div className="relative">
        <input className={`input ${numeric ? "num" : ""}`} inputMode={numeric ? "decimal" : undefined} value={value} placeholder={f.kind === "percent" ? "100" : ""} onChange={(e) => onChange(e.target.value)} />
        {(f.unit || f.kind === "percent") && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-faint text-[12px]">{f.kind === "percent" ? "%" : f.unit}</span>}
      </div>
    </label>
  );
}
