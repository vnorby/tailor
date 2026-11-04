"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { amt, usd } from "@/lib/ui/format";

interface Held { mint: string; symbol: string; name?: string; icon?: string; amount: number; priceUsd?: number; valueUsd?: number }
interface Info { mint: string; symbol: string; name: string; icon?: string; price?: number; registered: boolean; verified: boolean }

const SOL = "So11111111111111111111111111111111111111112";
const FEE_RESERVE = 0.01; // SOL kept back by Max so the swap (and the next one) can pay fees
const POPULAR = ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", SOL, "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"];
const SYMBOLS: Record<string, string> = { USDC: POPULAR[0], SOL, JITOSOL: POPULAR[2], JUP: POPULAR[3], USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" };
const isMint = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

const heldCache = new Map<string, { at: number; p: Promise<Held[]> }>();
export function useHeld(apiBase: string, owner: string): Held[] {
  const [list, setList] = useState<Held[]>([]);
  useEffect(() => {
    const k = `${apiBase}|${owner}`;
    let c = heldCache.get(k);
    if (!c || Date.now() - c.at > 20_000) {
      c = { at: Date.now(), p: fetch(`${apiBase}/api/balance?owner=${owner}`).then((r) => r.json()).then((j) => (j.tokens ?? []) as Held[]).catch(() => []) };
      heldCache.set(k, c);
    }
    let live = true;
    void c.p.then((l) => live && setList(l.filter((t) => t.amount > 0)));
    return () => { live = false; };
  }, [apiBase, owner]);
  return list;
}

const infoCache = new Map<string, Promise<Info | null>>();
function useInfo(apiBase: string, mint: string | undefined): Info | null {
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => {
    if (!mint) { setInfo(null); return; }
    if (!infoCache.has(mint)) infoCache.set(mint, fetch(`${apiBase}/api/token?mint=${mint}`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
    let live = true;
    void infoCache.get(mint)!.then((i) => live && setInfo(i));
    return () => { live = false; };
  }, [apiBase, mint]);
  return info;
}

/**
 * The swap form: From picks from what you hold (with balances), To is a token card
 * (registry-checked) you can change by search, Max leaves fee SOL, slippage is Auto
 * unless you open Advanced. Params stay the swap tool's: from, to, amount, slippage.
 */
export function SwapForm({ apiBase, owner, params, onChange, onSubmit, submitLabel = "Review swap" }: {
  apiBase: string; owner: string; params: Record<string, string>; onChange(p: Record<string, string>): void; onSubmit(): void; submitLabel?: string;
}) {
  const held = useHeld(apiBase, owner);
  const set = (k: string, v: string) => onChange({ ...params, [k]: v });
  const resolve = (s: string) => held.find((t) => t.mint === s || t.symbol.toLowerCase() === s.toLowerCase())?.mint ?? SYMBOLS[s.toUpperCase()] ?? (isMint(s) ? s : undefined);
  const fromMint = resolve(params.from ?? ""), toMint = resolve(params.to ?? "");
  const from = held.find((t) => t.mint === fromMint);
  const toHeld = held.find((t) => t.mint === toMint);
  const toInfo = useInfo(apiBase, toMint);
  const fromInfo = useInfo(apiBase, from ? undefined : fromMint);
  const [picking, setPicking] = useState<null | "from" | "to">(null);
  const [advanced, setAdvanced] = useState(false);

  // Default From: the largest holding that isn't the To token.
  useEffect(() => {
    if (!held.length || from) return;
    const best = [...held].filter((t) => t.mint !== toMint).sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0))[0];
    if (best && !fromInfo) set("from", best.mint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held.length]);

  const amount = Number(params.amount);
  const max = from ? Math.max(0, from.mint === SOL ? from.amount - FEE_RESERVE : from.amount) : 0;
  const price = from?.priceUsd ?? fromInfo?.price;
  const tooMuch = !!from && amount > from.amount;
  const ready = !!fromMint && !!toMint && fromMint !== toMint && amount > 0 && !tooMuch;
  const slip = params.slippage && params.slippage !== "auto" ? params.slippage : "auto";

  return (
    <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (ready) onSubmit(); }}>
      <div className="rounded-xl bg-panel-2/60 p-2.5">
        <div className="flex items-center justify-between text-[11.5px] text-faint mb-1.5">
          <span>You pay</span>
          {from && <button type="button" className="text-tape hover:underline" onClick={() => set("amount", String(Number(max.toFixed(6))))}>Max {amt(max)}</button>}
        </div>
        <div className="flex items-center gap-2">
          <input className="flex-1 min-w-0 bg-transparent num text-[22px] outline-none placeholder:text-faint" inputMode="decimal" placeholder="0" value={params.amount ?? ""} onChange={(e) => set("amount", e.target.value.replace(/[^0-9.]/g, ""))} />
          <TokenButton t={from ?? fromInfo ?? undefined} onClick={() => setPicking("from")} />
        </div>
        <div className="mt-1 flex justify-between text-[11.5px]">
          <span className="text-faint num">{amount > 0 && price ? `≈ ${usd(amount * price)}` : " "}</span>
          {from && <span className={tooMuch ? "text-danger" : "text-faint"}>{tooMuch ? `Only ${amt(from.amount)} ${from.symbol}` : `${amt(from.amount)} ${from.symbol}`}</span>}
        </div>
      </div>

      <button type="button" aria-label="Flip" className="self-center -my-3.5 z-10 size-7 rounded-full bg-panel border border-line text-dim hover:text-chalk text-[13px]"
        onClick={() => onChange({ ...params, from: params.to ?? "", to: params.from ?? "", amount: "" })}>⇅</button>

      <div className="rounded-xl bg-panel-2/60 p-2.5">
        <div className="text-[11.5px] text-faint mb-1.5">You get</div>
        <button type="button" className="w-full flex items-center gap-2.5 text-left" onClick={() => setPicking("to")}>
          <TokenIcon t={toHeld ?? toInfo ?? undefined} size={30} />
          <span className="flex-1 min-w-0">
            <span className="flex items-center gap-1 text-[14.5px] font-medium">{toInfo?.symbol ?? toHeld?.symbol ?? (toMint ? "…" : "Choose token")}<Check i={toInfo} /></span>
            <span className="block text-[11.5px] text-dim truncate">{toInfo?.name ?? toHeld?.name ?? ""}{toInfo?.price ? ` · ${usd(toInfo.price)}` : ""}</span>
          </span>
          <span className="text-faint text-[11px]">Change</span>
        </button>
      </div>

      <div className="flex items-center justify-between text-[11.5px] text-faint px-0.5">
        <span>Slippage {slip === "auto" ? "Auto" : `${slip}%`}</span>
        <button type="button" className="hover:text-chalk" onClick={() => setAdvanced((a) => !a)}>{advanced ? "Hide" : "Advanced"}</button>
      </div>
      {advanced && (
        <div className="flex gap-1.5">
          {["auto", "0.5", "1", "3"].map((v) => (
            <button key={v} type="button" className={`h-7 px-3 rounded-full text-[12px] border ${slip === v ? "border-tape text-tape" : "border-line text-dim"}`} onClick={() => set("slippage", v)}>{v === "auto" ? "Auto" : `${v}%`}</button>
          ))}
        </div>
      )}

      <button className="btn btn-primary justify-center mt-1" type="submit" disabled={!ready}>{fromMint && fromMint === toMint ? "Pick two different tokens" : submitLabel}</button>

      {picking && (
        <Picker apiBase={apiBase} held={held} mode={picking} onClose={() => setPicking(null)}
          onPick={(mint) => { set(picking, mint); setPicking(null); }} />
      )}
    </form>
  );
}

function Check({ i }: { i: Info | null }) {
  if (!i) return null;
  if (i.registered) return <span title="Registered on tokens.xyz" className="inline-flex size-[15px] items-center justify-center rounded-full bg-tape text-on-tape text-[9px] font-bold">✓</span>;
  if (i.verified) return <span title="Verified on Jupiter" className="text-[11px] text-dim">✓</span>;
  return <span className="rounded px-1 text-[10px] font-semibold bg-warn/15 text-warn">Unverified</span>;
}

export function TokenIcon({ t, size = 24 }: { t?: { icon?: string; symbol?: string }; size?: number }) {
  // eslint-disable-next-line @next/next/no-img-element
  return t?.icon ? <img src={t.icon} alt="" width={size} height={size} className="rounded-full bg-panel shrink-0" style={{ width: size, height: size }} />
    : <span className="rounded-full bg-panel shrink-0 flex items-center justify-center text-[10px] text-faint" style={{ width: size, height: size }}>{t?.symbol?.slice(0, 2) ?? ""}</span>;
}

function TokenButton({ t, onClick }: { t?: { icon?: string; symbol?: string }; onClick(): void }) {
  return (
    <button type="button" className="shrink-0 flex items-center gap-1.5 h-9 pl-1.5 pr-2.5 rounded-full bg-panel border border-line hover:bg-panel-2" onClick={onClick}>
      <TokenIcon t={t} size={24} /><span className="text-[13.5px] font-medium">{t?.symbol ?? "Pick"}</span><span className="text-faint text-[10px]">▾</span>
    </button>
  );
}

/** From: what you hold. To: search the registry / verified list, with popular picks and your holdings. */
function Picker({ apiBase, held, mode, onPick, onClose }: { apiBase: string; held: Held[]; mode: "from" | "to"; onPick(mint: string): void; onClose(): void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Info[] | null>(null);
  const [popular, setPopular] = useState<Info[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (mode !== "to") return;
    void Promise.all(POPULAR.map((m) => fetch(`${apiBase}/api/token?mint=${m}`).then((r) => r.json()).catch(() => null))).then((l) => setPopular(l.filter(Boolean)));
  }, [apiBase, mode]);
  useEffect(() => {
    clearTimeout(timer.current);
    if (mode !== "to" || q.trim().length < 2) { setResults(null); return; }
    timer.current = setTimeout(() => {
      const url = isMint(q.trim()) ? `${apiBase}/api/token?mint=${q.trim()}` : `${apiBase}/api/token?q=${encodeURIComponent(q.trim())}`;
      void fetch(url).then((r) => r.json()).then((j) => setResults(Array.isArray(j) ? j : j?.mint ? [j] : [])).catch(() => setResults([]));
    }, 300);
  }, [q, apiBase, mode]);
  const mine = useMemo(() => held.filter((t) => !q || `${t.symbol} ${t.name ?? ""}`.toLowerCase().includes(q.toLowerCase())).sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0)), [held, q]);

  // Portaled to <body>: inside an animated (transformed) card, "fixed" would be relative to the card.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/55" onClick={onClose}>
      <div className="w-full max-w-[560px] max-h-[85vh] flex flex-col rounded-t-2xl bg-cloth border-t border-line p-3" onClick={(e) => e.stopPropagation()}>
        <input autoFocus className="input mb-2" placeholder={mode === "from" ? "Search your tokens" : "Search name, ticker or address"} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="overflow-y-auto flex flex-col">
          {mode === "to" && results && results.map((t) => <Row key={t.mint} t={t} onClick={() => onPick(t.mint)} />)}
          {mode === "to" && results && !results.length && <p className="px-2 py-3 text-[12.5px] text-faint">No registered or verified token matches.</p>}
          {mode === "to" && !results && popular.length > 0 && <><h4 className="px-2 pt-1 pb-0.5 text-[11px] text-faint">Popular</h4>{popular.map((t) => <Row key={t.mint} t={t} onClick={() => onPick(t.mint)} />)}</>}
          {(mode === "from" || !results) && mine.length > 0 && (
            <>
              {mode === "to" && <h4 className="px-2 pt-2 pb-0.5 text-[11px] text-faint">Your tokens</h4>}
              {mine.map((t) => (
                <button key={t.mint} type="button" className="flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-panel text-left" onClick={() => onPick(t.mint)}>
                  <TokenIcon t={t} size={28} />
                  <span className="flex-1 min-w-0"><span className="block text-[13.5px] font-medium">{t.symbol}</span><span className="block text-[11.5px] text-dim truncate">{t.name}</span></span>
                  <span className="text-right"><span className="block num text-[13px]">{amt(t.amount)}</span><span className="block num text-[11px] text-faint">{usd(t.valueUsd)}</span></span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Row({ t, onClick }: { t: Info; onClick(): void }) {
  return (
    <button type="button" className="flex items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-panel text-left" onClick={onClick}>
      <TokenIcon t={t} size={28} />
      <span className="flex-1 min-w-0"><span className="flex items-center gap-1 text-[13.5px] font-medium">{t.symbol}<Check i={t} /></span><span className="block text-[11.5px] text-dim truncate">{t.name}</span></span>
      {t.price != null && <span className="num text-[12.5px] text-dim">{usd(t.price)}</span>}
    </button>
  );
}
