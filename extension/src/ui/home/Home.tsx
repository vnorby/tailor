import { useEffect, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import {
  ArrowDown, ArrowUp, ArrowsLeftRight, ArrowCounterClockwise, Broom, Coins, Bank, Plus, X, CheckCircle, CaretDown, Copy, Warning,
} from "@phosphor-icons/react";
import type { AccountMeta, WalletState } from "~/shared/messages";
import type { Position, ToolDef } from "@/lib/core/types";
import type { Section } from "@/lib/genui/home";
import { ActionProvider, useActions } from "@/components/ActionSheet";
import { GenCard, GenProvider } from "@/components/genui/Render";
import { defaultCard } from "@/lib/genui/cards";
import { PROTOCOLS } from "@/lib/ui/protocols";
import { amt, usd } from "@/lib/ui/format";
import { extensionExecutor } from "../common";
import { useHome, type Note } from "./useHome";
import { Funding } from "./Funding";

const ICONS: Record<string, ReactNode> = {
  fund: <Plus size={18} weight="bold" />,
  send: <ArrowUp size={18} weight="bold" />, receive: <ArrowDown size={18} weight="bold" />, swap: <ArrowsLeftRight size={18} weight="bold" />,
  "stake-sol": <Coins size={18} weight="fill" />, "stake-native": <Coins size={18} weight="fill" />, "kamino-deposit": <Bank size={18} weight="fill" />,
  "marginfi-deposit": <Bank size={18} weight="fill" />, "close-empty-accounts": <Broom size={18} weight="fill" />,
};
const LABELS: Record<string, string> = { fund: "Add funds", send: "Send", receive: "Receive", swap: "Swap", "stake-sol": "Stake", "stake-native": "Stake", "kamino-deposit": "Earn", "marginfi-deposit": "Lend", "close-empty-accounts": "Clean up" };

export function Home({ state, active, header, compact }: { state: WalletState; active: AccountMeta; header: ReactNode; compact?: boolean }) {
  const h = useHome(state.apiBase, active.address);
  return (
    <ActionProvider executor={extensionExecutor(state, active)} onDone={() => void h.run({ fresh: true })}>
      <Body h={h} header={header} compact={compact} watch={active.kind === "watch"} address={active.address} apiBase={state.apiBase} />
    </ActionProvider>
  );
}

function Body({ h, header, compact, watch, address, apiBase }: { h: ReturnType<typeof useHome>; header: ReactNode; compact?: boolean; watch: boolean; address: string; apiBase: string }) {
  const { open } = useActions();
  const [detail, setDetail] = useState<string | null>(null);
  const [receive, setReceive] = useState(false);
  const [fund, setFund] = useState(false);
  const [arrived, setArrived] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const snap = h.snap;

  // A request like "send 1 SOL to …" comes back as an intent: open it right away, prefilled.
  useEffect(() => {
    if (!h.intent || !snap) return;
    const i = h.intent; h.clearIntent();
    if (i.toolId) { const t = h.tools.find((x) => x.id === i.toolId); if (t) open({ kind: "tool", tool: t, params: i.params ?? {}, form: true }); }
    else if (i.positionId && i.actionId) { const p = snap.positions.find((x) => x.id === i.positionId); const a = p?.actions.find((x) => x.id === i.actionId); if (p && a) open({ kind: "action", position: p, action: a, params: i.params }); }
  }, [h.intent, snap, h.tools, open, h]);

  const empty = !!snap && snap.netWorthUsd < 1 && !snap.positions.length;
  const solBal = snap?.tokens.find((t) => t.mint === "So11111111111111111111111111111111111111112")?.amount ?? 0;
  const lowSol = !!snap && !empty && solBal < 0.003 && !watch;

  // While empty, watch for the first deposit and rebuild the home when it lands.
  useEffect(() => {
    if (!empty) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch(`${apiBase}/api/balance?owner=${address}`);
        const j = await r.json();
        if (r.ok && j.totalUsd >= 0.5) { clearInterval(id); setArrived(`Funds arrived: $${j.totalUsd.toFixed(2)}`); setFund(false); void h.run({ fresh: true }); }
      } catch { /* try again next tick */ }
    }, 10_000);
    return () => clearInterval(id);
  }, [empty, apiBase, address, h]);

  const runAction = (ref: string) => {
    if (ref === "receive") return setReceive(true);
    if (ref === "fund") return setFund(true);
    const m = /^pos:(.+):([^:]+)$/.exec(ref);
    if (m && snap) { const p = snap.positions.find((x) => x.id === m[1]); const a = p?.actions.find((x) => x.id === m[2]); if (p && a) open({ kind: "action", position: p, action: a }); return; }
    const t = h.tools.find((x) => x.id === ref);
    if (t) open({ kind: "tool", tool: t, params: {}, form: true });
  };
  const labelFor = (ref: string) => {
    const m = /^pos:(.+):([^:]+)$/.exec(ref);
    if (m && snap) return snap.positions.find((x) => x.id === m[1])?.actions.find((a) => a.id === m[2])?.label.split(" ")[0] ?? "Action";
    return LABELS[ref] ?? h.tools.find((t) => t.id === ref)?.label ?? ref;
  };
  const iconFor = (ref: string) => ICONS[ref] ?? (ref.startsWith("pos:") ? (/close/i.test(ref) ? <X size={18} weight="bold" /> : <ArrowCounterClockwise size={18} weight="bold" />) : <Plus size={18} weight="bold" />);

  const walletUsd = snap?.tokens.reduce((s, t) => s + (t.valueUsd ?? 0), 0) ?? 0;
  const defiUsd = snap ? snap.netWorthUsd - walletUsd : 0;
  const detailPos = detail && snap ? snap.positions.find((p) => p.id === detail) : undefined;

  const ask = (t: string) => { setPrompt(""); void h.ask(t); };

  // A transaction the agent built opens straight into review (simulation + balance changes).
  useEffect(() => {
    if (!h.proposal) return;
    const prep = h.proposal; h.clearProposal();
    open({ kind: "prepared", prep, title: "Review" });
  }, [h.proposal, h, open]);

  return (
    <div className={`flex flex-col ${compact ? "h-[600px] w-[360px] overflow-hidden" : "min-h-screen"}`}>
      {header}
      <div className={`flex-1 overflow-y-auto ${compact ? "pb-20" : "pb-28"}`}>
        {/* Balance */}
        <section className="px-5 pt-5 pb-4 text-center">
          <div className="font-serif text-[46px] leading-none tracking-tight min-h-[46px]">{snap ? usd(snap.netWorthUsd) : <span className="inline-block h-10 w-40 rounded-lg bg-panel animate-pulse" />}</div>
          {snap && defiUsd > 1 && <div className="mt-2 text-[12.5px] text-dim num">{usd(walletUsd, true)} wallet · {usd(defiUsd, true)} in DeFi</div>}
          {watch && <div className="mt-2 text-[11.5px] text-faint">Watch-only</div>}
        </section>

        {/* Actions */}
        <section className="px-4 flex justify-center gap-3">
          {h.actions.slice(0, compact ? 4 : 5).map((ref) => (
            <button key={ref} className="group flex flex-col items-center gap-1.5 w-[60px] disabled:opacity-40" disabled={watch && ref !== "receive"} onClick={() => runAction(ref)}>
              <span className="size-11 rounded-full bg-tape text-on-tape flex items-center justify-center transition-transform group-hover:scale-105 group-active:scale-95">{iconFor(ref)}</span>
              <span className="text-[11.5px] text-dim truncate max-w-full">{labelFor(ref)}</span>
            </button>
          ))}
        </section>

        {/* What the AI is doing */}
        <Working notes={h.notes} working={h.working} />

        {arrived && <p className="mx-4 mt-3 rounded-[calc(var(--t-radius)*.8)] bg-pos/14 text-pos px-3 py-2.5 text-[13px] rise">{arrived}</p>}
        {empty && !watch && <Funding address={address} apiBase={apiBase} compact={compact} />}
        {lowSol && (
          <button className="mx-4 mt-3 w-[calc(100%-2rem)] flex items-center gap-2.5 rounded-[calc(var(--t-radius)*.8)] bg-warn/14 text-warn px-3 py-2.5 text-left text-[13px]" onClick={() => setFund(true)}>
            <Warning size={16} weight="fill" className="shrink-0" /><span className="flex-1">Add a little SOL to pay network fees</span><span className="text-[11px] opacity-70">Add</span>
          </button>
        )}

        {h.alert && !empty && (
          <button className={`mx-4 mt-3 w-[calc(100%-2rem)] flex items-center gap-2.5 rounded-[calc(var(--t-radius)*.8)] px-3 py-2.5 text-left text-[13px] rise ${h.alert.tone === "danger" ? "bg-danger/14 text-danger" : h.alert.tone === "warn" ? "bg-warn/14 text-warn" : "bg-panel-2 text-chalk"}`}
            onClick={() => h.alert?.positionId && setDetail(h.alert.positionId)}>
            <Warning size={16} weight="fill" className="shrink-0" /><span className="flex-1">{h.alert.text}</span>{h.alert.positionId && <span className="text-[11px] opacity-70">View</span>}
          </button>
        )}

        {h.error && <p className="mx-4 mt-3 text-[13px] text-danger">{h.error}</p>}

        {snap && (
          <GenProvider snap={snap} tools={h.tools}>
            {h.answer && <AnswerPanel a={h.answer} onClose={h.clearAnswer} snapReady />}
            <div className="mt-2">
              {!empty && h.sections.map((s, i) => <SectionView key={`${i}-${s.kind}`} s={s} positions={snap.positions} tokens={snap.tokens} tools={h.tools} onOpen={setDetail} />)}
            </div>
            {detailPos && (
              <Sheet onClose={() => setDetail(null)}>
                <div className="grid grid-cols-1">
                  <GenCard card={{ ...(h.details[detailPos.id] ?? defaultCard(detailPos)), span: 4 }} />
                </div>
              </Sheet>
            )}
          </GenProvider>
        )}
        {!snap && !h.error && <div className="px-4 mt-4 flex flex-col gap-2">{[0, 1, 2, 3].map((i) => <div key={i} className="h-12 rounded-xl bg-panel animate-pulse" />)}</div>}

        {h.prefs.instructions.length > 0 && !h.working && (
          <p className="px-5 mt-6 text-[11px] text-faint">Fitted to: {h.prefs.instructions.map((s, i) => <span key={i} className="mr-2">“{s}”</span>)}<button className="underline" onClick={() => void h.run({ reset: true })}>reset</button></p>
        )}
      </div>

      {/* Ask bar */}
      <div className={`${compact ? "absolute" : "fixed"} inset-x-0 bottom-0 z-30 px-3 pb-3 pt-6 bg-gradient-to-t from-cloth via-cloth/95 to-transparent`}>

        <form className="flex gap-2 card !rounded-full p-1 pl-4" onSubmit={(e) => { e.preventDefault(); if (prompt.trim()) ask(prompt.trim()); }}>
          <input className="flex-1 min-w-0 bg-transparent text-[14px] outline-none placeholder:text-faint" placeholder={h.working ? "Tailoring…" : "Ask Tailor anything…"} value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={!snap || h.working} />
          <button className="btn btn-primary !rounded-full !px-4" disabled={!snap || h.working || !prompt.trim()}>Go</button>
        </form>
      </div>

      {receive && <Sheet onClose={() => setReceive(false)}><Receive address={address} /></Sheet>}
      {fund && <Sheet onClose={() => setFund(false)}><div className="pb-4"><Funding address={address} apiBase={apiBase} compact /></div></Sheet>}
    </div>
  );
}

/** The agent's answer: streamed text plus any cards it drew. */
function AnswerPanel({ a, onClose, snapReady }: { a: import("./useHome").Answer; onClose(): void; snapReady: boolean }) {
  return (
    <section className="mx-4 mt-4 card p-3.5 rise">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[12px] text-faint truncate">{a.prompt}</p>
        {a.done && <button className="text-faint hover:text-chalk" aria-label="Dismiss" onClick={onClose}><X size={14} weight="bold" /></button>}
      </div>
      {a.text && <p className={`mt-1.5 text-[14px] leading-snug whitespace-pre-wrap ${a.done ? "" : "caret"}`}>{a.text}</p>}
      {!a.text && !a.done && <p className="mt-1.5 text-[14px] text-dim caret">Working on it</p>}
      {a.error && <p className="mt-1.5 text-[13px] text-danger">{a.error}</p>}
      {snapReady && a.cards.length > 0 && <div className="mt-3 grid grid-cols-1 gap-3">{a.cards.map((c, i) => <GenCard key={i} card={{ ...c, span: 4 }} />)}</div>}
    </section>
  );
}

/** The AI's progress: chain reads tick off quietly, its notes type in. Collapses when done. */
function Working({ notes, working }: { notes: Note[]; working: boolean }) {
  const [open, setOpen] = useState(false);
  const ai = notes.filter((n) => n.source === "ai");
  const chain = notes.filter((n) => n.source === "chain");
  if (!working && !notes.length) return null;
  if (!working) {
    return ai.length ? (
      <div className="mx-4 mt-4">
        <button className="flex items-center gap-1.5 text-[11.5px] text-faint hover:text-dim" onClick={() => setOpen((o) => !o)}>
          <CheckCircle size={13} weight="fill" className="text-tape" />Tailored for you<CaretDown size={11} className={open ? "rotate-180" : ""} />
        </button>
        {open && <ul className="mt-2 flex flex-col gap-1">{ai.map((n, i) => <li key={i} className="text-[12px] text-dim">{n.text}</li>)}</ul>}
      </div>
    ) : null;
  }
  return (
    <div className="mx-4 mt-4 card px-3.5 py-3 rise">
      <div className="h-[3px] -mx-3.5 -mt-3 mb-3 rounded-t-[var(--t-radius)] overflow-hidden bg-panel-2"><div className="h-full w-1/3 bg-tape animate-[slide_1.2s_ease-in-out_infinite]" /></div>
      <ul className="flex flex-col gap-1">
        {chain.map((n, i) => <li key={`c${i}`} className="flex items-center gap-1.5 text-[11.5px] text-faint rise"><CheckCircle size={12} weight="fill" className="text-pos/80" />{n.text}</li>)}
        {ai.map((n, i) => <li key={`a${i}`} className={`text-[13px] text-chalk rise ${i === ai.length - 1 ? "caret" : ""}`}><Typed text={n.text} /></li>)}
        {!ai.length && <li className="text-[13px] text-dim caret">{chain.length ? "Thinking about your wallet" : "Reading the chain"}</li>}
      </ul>
    </div>
  );
}

function Typed({ text }: { text: string }) {
  const [n, setN] = useState(0);
  useEffect(() => { setN(0); const id = setInterval(() => setN((x) => (x >= text.length ? (clearInterval(id), x) : x + 2)), 18); return () => clearInterval(id); }, [text]);
  return <>{text.slice(0, n)}</>;
}

function SectionView({ s, positions, tokens, tools, onOpen }: { s: Section; positions: Position[]; tokens: { mint: string; symbol: string; icon?: string; amount: number; valueUsd?: number }[]; tools: ToolDef[]; onOpen(id: string): void }) {
  if (s.kind === "positions") {
    const list = s.positionIds.map((id) => positions.find((p) => p.id === id)).filter((p): p is Position => !!p);
    return (
      <section className="mt-4 rise">
        <h3 className="px-5 mb-1 text-[11.5px] font-medium text-faint">{s.title}</h3>
        <ul className="px-2">{list.map((p) => <PositionRow key={p.id} p={p} onOpen={() => onOpen(p.id)} />)}</ul>
      </section>
    );
  }
  if (s.kind === "tokens") {
    const list = tokens.slice(0, s.limit ?? 50);
    if (!list.length) return null;
    return (
      <section className="mt-4 rise">
        <h3 className="px-5 mb-1 text-[11.5px] font-medium text-faint">{s.title ?? "Tokens"}</h3>
        <ul className="px-2">
          {list.map((t) => (
            <li key={t.mint} className="flex items-center gap-3 px-3 py-2.5 rounded-[calc(var(--t-radius)*.7)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {t.icon ? <img src={t.icon} alt="" className="size-8 rounded-full bg-panel-2" /> : <span className="size-8 rounded-full bg-panel-2" />}
              <span className="flex-1 min-w-0"><span className="block text-[14px] truncate">{t.symbol}</span><span className="block num text-[11.5px] text-dim">{amt(t.amount)}</span></span>
              <span className="num text-[14px]">{usd(t.valueUsd)}</span>
            </li>
          ))}
        </ul>
      </section>
    );
  }
  if (s.kind === "tool") {
    const tool = tools.find((t) => t.id === s.toolId);
    if (!tool) return null;
    return <section className="mt-4 px-4 grid grid-cols-1 rise"><GenCard card={{ span: 4, children: [{ type: "tool", toolId: tool.id, defaults: Object.entries(s.defaults ?? {}).map(([name, value]) => ({ name, value })) }] }} /></section>;
  }
  return <section className="mt-4 px-4 grid grid-cols-1 rise"><GenCard card={{ ...s.card, span: 4 }} /></section>;
}

function PositionRow({ p, onOpen }: { p: Position; onOpen(): void }) {
  const proto = PROTOCOLS[p.protocol];
  return (
    <li>
      <button className="w-full flex items-center gap-3 px-3 py-2.5 rounded-[calc(var(--t-radius)*.7)] hover:bg-panel text-left transition-colors" onClick={onOpen}>
        {/* No made-up protocol logos: a neutral disc carrying the protocol's color. */}
        <span className="size-8 rounded-full bg-panel-2 flex items-center justify-center shrink-0"><span className="size-2.5 rounded-full" style={{ background: proto.color }} /></span>
        <span className="flex-1 min-w-0">
          <span className="block text-[14px] truncate">{p.title}</span>
          <span className="block text-[11.5px] text-dim truncate">{proto.name}{p.risk.level !== "ok" && p.risk.reason ? <span className={p.risk.level === "danger" ? "text-danger" : "text-warn"}> · {p.risk.reason}</span> : ""}</span>
        </span>
        <span className="text-right shrink-0">
          <span className="block num text-[14px]">{usd(p.valueUsd)}</span>
          {p.pnlUsd != null && <span className={`block num text-[11px] ${p.pnlUsd >= 0 ? "text-pos" : "text-danger"}`}>{p.pnlUsd >= 0 ? "+" : ""}{usd(p.pnlUsd)}</span>}
        </span>
      </button>
    </li>
  );
}

function Sheet({ children, onClose }: { children: ReactNode; onClose(): void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/55 backdrop-blur-[2px]" onClick={onClose}>
      <div className="w-full max-w-[560px] max-h-[88vh] overflow-y-auto rounded-t-[calc(var(--t-radius)+6px)] bg-cloth border-t border-line p-3 pt-2 rise" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-line" />
        {children}
      </div>
    </div>
  );
}

function Receive({ address }: { address: string }) {
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => { void QRCode.toDataURL(address, { margin: 1, width: 220, color: { dark: "#000000", light: "#ffffff" } }).then(setQr); }, [address]);
  return (
    <div className="flex flex-col items-center gap-4 px-4 pt-2 pb-4">
      <div className="text-[15px] font-medium">Receive</div>
      {qr && <img src={qr} alt="Address QR code" className="rounded-[var(--t-radius)]" width={190} height={190} />}
      <p className="num text-[12px] text-center break-all text-dim">{address}</p>
      <button className="btn btn-primary w-full justify-center" onClick={() => { void navigator.clipboard.writeText(address); setCopied(true); }}><Copy size={15} weight="bold" />{copied ? "Copied" : "Copy address"}</button>
    </div>
  );
}
