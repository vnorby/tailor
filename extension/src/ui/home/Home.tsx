import { useEffect, useRef, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import {
  ArrowDown, ArrowUp, ArrowsLeftRight, ArrowCounterClockwise, Broom, Coins, Bank, Plus, X, CheckCircle, CaretDown, Copy, Warning, DotsThree, PushPin,
} from "@phosphor-icons/react";
import type { AccountMeta, WalletState } from "~/shared/messages";
import type { Position, ToolDef } from "@/lib/core/types";
import type { Section } from "@/lib/genui/home";
import { ActionProvider, useActions } from "@/components/ActionSheet";
import { GenCard, GenProvider } from "@/components/genui/Render";
import { RichText } from "@/components/genui/RichText";
import { defaultCard } from "@/lib/genui/cards";
import { PROTOCOLS } from "@/lib/ui/protocols";
import { amt, usd } from "@/lib/ui/format";
import { extensionExecutor } from "../common";
import { useHome, type Note } from "./useHome";
import { Funding } from "./Funding";
import { PageSuggestions, SiteContext, useActiveSite, usePageSuggestions } from "./Site";

const ICONS: Record<string, ReactNode> = {
  fund: <Plus size={18} weight="bold" />,
  send: <ArrowUp size={18} weight="bold" />, receive: <ArrowDown size={18} weight="bold" />, swap: <ArrowsLeftRight size={18} weight="bold" />,
  "stake-sol": <Coins size={18} weight="fill" />, "stake-native": <Coins size={18} weight="fill" />, "kamino-deposit": <Bank size={18} weight="fill" />,
  "marginfi-deposit": <Bank size={18} weight="fill" />, "close-empty-accounts": <Broom size={18} weight="fill" />,
};
const LABELS: Record<string, string> = { fund: "Add funds", send: "Send", receive: "Receive", swap: "Swap", "stake-sol": "Stake", "stake-native": "Stake", "kamino-deposit": "Earn", "marginfi-deposit": "Lend", "close-empty-accounts": "Clean up" };

/** header receives the balance so each surface can place it in its own top bar. */
type HeaderSlot = ReactNode | ((balance: ReactNode) => ReactNode);

export function Home({ state, active, header, compact }: { state: WalletState; active: AccountMeta; header: HeaderSlot; compact?: boolean }) {
  const h = useHome(state.apiBase, active.address);
  return (
    <ActionProvider executor={extensionExecutor(state, active)} onDone={() => void h.run({ fresh: true })}>
      <Body h={h} header={header} compact={compact} watch={active.kind === "watch"} address={active.address} apiBase={state.apiBase} />
    </ActionProvider>
  );
}

function Body({ h, header, compact, watch, address, apiBase }: { h: ReturnType<typeof useHome>; header: HeaderSlot; compact?: boolean; watch: boolean; address: string; apiBase: string }) {
  const { open } = useActions();
  const [detail, setDetail] = useState<string | null>(null);
  const [receive, setReceive] = useState(false);
  const [fund, setFund] = useState(false);
  const [arrived, setArrived] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const snap = h.snap;
  // Switching accounts keeps this view mounted (no flash); drop what belonged to the last one.
  useEffect(() => { setDetail(null); setReceive(false); setFund(false); setArrived(null); setPrompt(""); }, [address]);

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

  // Watch balances while open: when tokens arrive (or leave), refresh the home and say what came in.
  const run = h.run;
  useEffect(() => {
    let base: Map<string, number> | null = null, stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`${apiBase}/api/balance?owner=${address}`);
        const j = (await r.json()) as { tokens?: { mint: string; symbol: string; amount: number; priceUsd?: number }[] };
        if (stop || !r.ok || !j.tokens) return;
        const now = new Map(j.tokens.map((t) => [t.mint, t.amount]));
        if (base) {
          const ins = j.tokens.filter((t) => t.amount - (base!.get(t.mint) ?? 0) > Math.max(1e-9, (base!.get(t.mint) ?? 0) * 1e-4) && (t.amount - (base!.get(t.mint) ?? 0)) * (t.priceUsd ?? 1) >= 0.05);
          const changed = ins.length || [...base].some(([m, a]) => Math.abs((now.get(m) ?? 0) - a) > Math.max(1e-9, a * 1e-4));
          if (changed) {
            if (ins.length) setArrived(`Received ${ins.slice(0, 2).map((t) => `${amt(t.amount - (base!.get(t.mint) ?? 0))} ${t.symbol}`).join(" and ")}`);
            setFund(false);
            void run({ fresh: true });
          }
        }
        base = now;
      } catch { /* try again next tick */ }
    };
    void tick();
    const id = setInterval(tick, 12_000);
    return () => { stop = true; clearInterval(id); };
  }, [apiBase, address, run]);
  useEffect(() => { if (!arrived) return; const id = setTimeout(() => setArrived(null), 8000); return () => clearTimeout(id); }, [arrived]);

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

  const site = useActiveSite();
  // Quick moves, by context: funding first when empty or out of fee SOL, this site's moves next, then the home's picks.
  const quick = [...new Set([...(empty || lowSol ? ["fund"] : []), ...(site?.tools ?? []).filter((t) => h.tools.some((x) => x.id === t)), ...h.actions, "receive"])].slice(0, 5);
  const suggestions = usePageSuggestions(apiBase, address, site);
  const swapTool = h.tools.find((t) => t.id === "swap");
  const usdcHeld = snap?.tokens.find((t) => t.symbol === "USDC")?.valueUsd ?? 0;
  const ask = (t: string) => {
    setPrompt("");
    // "long btc", "short eth 5x $50": open the trade form instantly; no need to wait on the agent.
    const perp = parsePerp(t), tool = perp && h.tools.find((x) => x.id === "phoenix-perp");
    if (perp && tool) { open({ kind: "tool", tool, params: { ...perp, slippage: "0.5" }, form: true }); return; }
    void h.ask(t, site?.host);
  };
  const asking = !!h.answer && !h.answer.done;

  // Keep the eye where the work is: follow the answer and each module as it appears, until the user scrolls themselves.
  const scroller = useRef<HTMLDivElement>(null);
  const answerRef = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState<number[]>([]);
  const following = useRef(false);
  const scrollToEl = (el: Element | null | undefined, offset = 72) => {
    const box = scroller.current;
    if (!box || !el) return;
    const top = box.scrollTop + el.getBoundingClientRect().top - box.getBoundingClientRect().top - offset;
    const from = box.scrollTop;
    box.scrollTo({ top, behavior: "smooth" });
    // Some contexts skip smooth scrolling entirely; land there anyway.
    setTimeout(() => { if (box.scrollTop === from) box.scrollTop = top; }, 700);
  };
  useEffect(() => {
    if (!asking) return;
    following.current = true;
    const stop = () => { following.current = false; };
    const box = scroller.current;
    box?.addEventListener("wheel", stop, { passive: true }); box?.addEventListener("touchmove", stop, { passive: true });
    requestAnimationFrame(() => scrollToEl(answerRef.current, 12));
    return () => { box?.removeEventListener("wheel", stop); box?.removeEventListener("touchmove", stop); };
  }, [asking]);
  const showChanged = (idx: number[]) => {
    if (!idx.length) return;
    setFlash(idx);
    setTimeout(() => scrollToEl(scroller.current?.querySelector(`[data-section="${idx.at(-1)}"]`)), 150);
    setTimeout(() => setFlash([]), 2400);
  };
  // Each new card in the answer, and each new home module, is brought into view as it lands.
  const cardCount = h.answer?.cards.length ?? 0;
  useEffect(() => {
    if (cardCount && following.current) setTimeout(() => scrollToEl(answerRef.current?.querySelector(`[data-card="${cardCount - 1}"]`), 24), 60);
  }, [cardCount]);
  const changedKey = h.answer?.changed?.join(",");
  useEffect(() => {
    if (changedKey && (following.current || h.answer?.done)) showChanged(h.answer?.changed ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changedKey]);

  // Hand edits: remove (with undo), move to top, pin from an answer.
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(null), 5000); return () => clearTimeout(id); }, [toast]);
  const remove = (i: number) => { const undo = h.removeSection(i); setToast({ text: "Removed", undo }); };
  const pinCard = (c: import("@/lib/genui/spec").Card) => { const i = h.pin(c); setToast({ text: "Pinned to home" }); showChanged([i]); };

  // A transaction the agent built opens straight into review (simulation + balance changes).
  useEffect(() => {
    if (!h.proposal) return;
    const prep = h.proposal; h.clearProposal();
    open({ kind: "prepared", prep, title: "Review" });
  }, [h.proposal, h, open]);

  return (
    <div className={`flex flex-col ${compact ? "h-[600px] w-[360px] overflow-hidden" : "min-h-screen"}`}>
      {typeof header === "function" ? header(<Balance total={snap?.netWorthUsd} wallet={walletUsd} defi={defiUsd} />) : header}
      <div ref={scroller} className={`flex-1 overflow-y-auto ${compact ? "pb-28" : "pb-32"}`}>

        {/* Where the user is: what matters on this site */}
        {site && snap && !empty && <SiteContext site={site} apiBase={apiBase} positions={snap.positions} tools={h.tools} onOpenPosition={setDetail} onTool={(t) => open({ kind: "tool", tool: t, params: {}, form: true })} />}

        {snap && !watch && <PageSuggestions state={suggestions} swap={swapTool}
          onBuy={(s) => swapTool && open({ kind: "tool", tool: swapTool, params: { from: usdcHeld >= 5 ? "USDC" : "SOL", to: s.mint }, form: true })}
          onCheck={(s) => ask(`Is this token legit? ${s.mint}`)} />}

        {/* What the AI is doing */}
        <Working notes={h.notes} working={h.working && !asking} quiet={h.sections.length > 0} />

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
            {h.answer && <div ref={answerRef}><AnswerPanel a={h.answer} onClose={h.clearAnswer} onShow={() => showChanged(h.answer?.changed ?? [])} onPin={pinCard} snapReady /></div>}
            <div className="mt-2">
              {!empty && h.sections.map((s, i) => (
                <div key={`${i}-${s.kind}`} data-section={i} onClickCapture={(e) => { if (!(e.target as Element).closest("[data-menu]")) h.tap(i); }}
                  className={`group/sec relative rounded-[var(--t-radius)] transition-shadow duration-500 ${flash.includes(i) ? "ring-2 ring-tape/70 ring-offset-2 ring-offset-cloth" : ""}`}>
                  <SectionView s={s} positions={snap.positions} tokens={snap.tokens} tools={h.tools} onOpen={setDetail} />
                  {!h.working && <SectionMenu first={i === 0} onRemove={() => remove(i)} onTop={() => h.moveTop(i)} />}
                </div>
              ))}
              {/* Never a blank wallet: if there's money but no modules (yet), show what's held. */}
              {!empty && !h.sections.length && !h.working && <SectionView s={{ kind: "tokens", title: "Tokens" }} positions={snap.positions} tokens={snap.tokens} tools={h.tools} onOpen={setDetail} />}
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

      {toast && (
        <div className={`${compact ? "absolute" : "fixed"} inset-x-0 bottom-[116px] z-30 flex justify-center px-4 rise`}>
          <div className="card !rounded-full flex items-center gap-3 px-4 py-2 text-[13px] shadow-2xl">
            {toast.text}{toast.undo && <button className="font-medium text-tape" onClick={() => { toast.undo?.(); setToast(null); }}>Undo</button>}
          </div>
        </div>
      )}

      {/* Ask bar, with the moves you'd likely make right now just above it */}
      <div className={`${compact ? "absolute" : "fixed"} inset-x-0 bottom-0 z-30 px-3 pb-3 pt-6 bg-gradient-to-t from-cloth via-cloth/95 to-transparent`}>
        {!prompt && !asking && snap && (
          <div className="mb-2 -mx-3 px-3 flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
            {quick.map((ref) => (
              <button key={ref} className="shrink-0 flex items-center gap-1.5 h-8 pl-2.5 pr-3 rounded-full bg-panel border border-line text-[12.5px] text-chalk/90 hover:bg-panel-2 disabled:opacity-40 transition-colors" disabled={watch && ref !== "receive"} onClick={() => runAction(ref)}>
                <span className="text-tape [&>svg]:size-[14px]">{iconFor(ref)}</span>{labelFor(ref)}
              </button>
            ))}
          </div>
        )}

        <form className="flex gap-2 card !rounded-full p-1 pl-4" onSubmit={(e) => { e.preventDefault(); if (prompt.trim()) ask(prompt.trim()); }}>
          <input className="flex-1 min-w-0 bg-transparent text-[14px] outline-none placeholder:text-faint" placeholder={h.working ? "Tailoring…" : site?.name ? `Ask about ${site.name}…` : "Ask Tailor anything…"} value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={!snap || h.working} />
          <button className="btn btn-primary !rounded-full !px-4" disabled={!snap || h.working || !prompt.trim()}>Go</button>
        </form>
      </div>

      {receive && <Sheet onClose={() => setReceive(false)}><Receive address={address} /></Sheet>}
      {fund && <Sheet onClose={() => setFund(false)}><div className="pb-4"><Funding address={address} apiBase={apiBase} compact /></div></Sheet>}
    </div>
  );
}

/** The agent's answer: its steps while it works, then streamed text, cards, and pointers to anything it changed. */
function AnswerPanel({ a, onClose, onShow, onPin, snapReady }: { a: import("./useHome").Answer; onClose(): void; onShow(): void; onPin(c: import("@/lib/genui/spec").Card): void; snapReady: boolean }) {
  const changed = a.changed?.length ?? 0;
  return (
    <section className="mx-4 mt-4 card p-3.5 rise overflow-hidden">
      {!a.done && <div className="h-[3px] -mx-3.5 -mt-3.5 mb-3 overflow-hidden bg-panel-2"><div className="h-full w-1/3 bg-tape animate-[slide_1.2s_ease-in-out_infinite]" /></div>}
      <div className="flex items-start justify-between gap-3">
        <p className="text-[12px] text-faint truncate">{a.prompt}</p>
        {a.done && <button className="text-faint hover:text-chalk" aria-label="Dismiss" onClick={onClose}><X size={14} weight="bold" /></button>}
      </div>
      {a.steps.length > 0 && (!a.done || !a.text) && (
        <ul className="mt-2 flex flex-col gap-1">
          {a.steps.map((t, i) => {
            const live = !a.done && i === a.steps.length - 1;
            return <li key={i} className={`flex items-start gap-1.5 text-[12px] rise ${live ? "text-chalk" : "text-faint"}`}>{live ? <span className="mt-[5px] size-1.5 shrink-0 rounded-full bg-tape animate-pulse" /> : <CheckCircle size={12} weight="fill" className="mt-[2px] shrink-0 text-pos/80" />}<span className="[overflow-wrap:anywhere]">{t}</span></li>;
          })}
        </ul>
      )}
      {a.text && <AnswerText text={a.text} done={a.done} clamp={a.done && a.cards.length > 0} />}
      {!a.text && !a.done && !a.steps.length && <p className="mt-1.5 text-[14px] text-dim caret">Working on it</p>}
      {a.error && <p className="mt-1.5 text-[13px] text-danger">{a.error}</p>}
      {snapReady && a.cards.length > 0 && (
        <div className="mt-3 grid grid-cols-1 gap-3">
          {a.cards.map((c, i) => (
            <div key={i} data-card={i}>
              <GenCard card={{ ...c, span: 4 }} />
              {a.done && <button className="mt-1.5 flex items-center gap-1 text-[11.5px] text-faint hover:text-chalk" onClick={() => onPin(c)}><PushPin size={12} weight="fill" />Pin to home</button>}
            </div>
          ))}
        </div>
      )}
      {a.done && (changed > 0 || a.restyled) && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {changed > 0 && <button className="btn !py-1 !text-[12px]" onClick={onShow}><ArrowDown size={12} weight="bold" />{changed === 1 ? "See it on your home" : `See ${changed} changes on your home`}</button>}
          {a.restyled && <span className="text-[12px] text-dim self-center">Restyled</span>}
        </div>
      )}
    </section>
  );
}

const FILLER = new Set(["go", "a", "an", "i", "want", "to", "on", "the", "perp", "perps", "position", "with", "at", "for", "me", "open", "please", "some", "of", "usd", "usdc", "dollars", "leverage", "lev", "x"]);
/** Parse "long btc", "short eth 5x $50", "go short sol with 100" into perp params, or null. */
function parsePerp(text: string): Record<string, string> | null {
  const t = text.toLowerCase().replace(/[,!?.]/g, " ");
  const side = /\b(long|short)\b/.exec(t)?.[1];
  if (!side || t.split(/\s+/).filter(Boolean).length > 9) return null;
  const lev = /(\d+(?:\.\d+)?)\s*x\b/.exec(t)?.[1];
  const amount = /\$\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:usd|usdc|dollars)\b/.exec(t);
  const words = t.replace(/\$?\d+(?:\.\d+)?\s*x?\b/g, " ").split(/\s+/).filter((w) => w && w !== side && !FILLER.has(w));
  const market = words.find((w) => /^\$?[a-z][a-z0-9]{1,7}$/.test(w))?.replace("$", "");
  if (!market || words.length !== 1) return null; // anything more is a question for the agent
  return { market: market.toUpperCase(), side, ...(lev ? { leverage: lev } : {}), ...(amount ? { collateral: amount[1] ?? amount[2] } : {}) };
}

/** The total, small and in the top bar. Tap to hide it (screen sharing, coffee shops). */
function Balance({ total, wallet, defi }: { total?: number; wallet: number; defi: number }) {
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem("hideBalance") === "1"; } catch { return false; } });
  const toggle = () => setHidden((x) => { try { localStorage.setItem("hideBalance", x ? "0" : "1"); } catch { /* storage blocked */ } return !x; });
  if (total == null) return <span className="inline-block h-4 w-14 rounded bg-panel animate-pulse" />;
  return (
    <button className="num text-[15px] font-medium px-1.5 py-1 rounded-md hover:bg-panel-2" onClick={toggle}
      title={hidden ? "Show balance" : defi > 1 ? `${usd(wallet, true)} wallet · ${usd(defi, true)} in DeFi — tap to hide` : "Tap to hide"}>
      {hidden ? "••••" : usd(total, total >= 100_000)}
    </button>
  );
}

/** A module's own menu: tucked away until hovered or focused, so the home stays clean. */
function SectionMenu({ first, onRemove, onTop }: { first: boolean; onRemove(): void; onTop(): void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="absolute right-6 top-3 z-10" data-menu>
      <button aria-label="Module options" className={`size-6 rounded-full flex items-center justify-center text-faint hover:text-chalk hover:bg-panel-2 transition-opacity ${open ? "opacity-100" : "opacity-0 group-hover/sec:opacity-100 focus:opacity-100"}`} onClick={() => setOpen((o) => !o)}>
        <DotsThree size={16} weight="bold" />
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-36 card p-1 shadow-2xl text-[13px]" onMouseLeave={() => setOpen(false)}>
          {!first && <button className="w-full rounded-md px-2 py-1.5 text-left hover:bg-panel-2" onClick={() => { setOpen(false); onTop(); }}>Move to top</button>}
          <button className="w-full rounded-md px-2 py-1.5 text-left text-danger hover:bg-panel-2" onClick={() => { setOpen(false); onRemove(); }}>Remove</button>
        </div>
      )}
    </div>
  );
}

/** With a card below, long text is clamped to a few lines: the card is the answer, the text its caption. */
function AnswerText({ text, done, clamp }: { text: string; done: boolean; clamp: boolean }) {
  const [more, setMore] = useState(false);
  const long = clamp && text.length > 160;
  return (
    <>
      <p className={`mt-1.5 text-[14px] leading-snug whitespace-pre-wrap [overflow-wrap:anywhere] ${done ? "" : "caret"} ${long && !more ? "line-clamp-3" : ""}`}><RichText text={text} /></p>
      {long && <button className="mt-0.5 text-[12px] text-faint hover:text-chalk" onClick={() => setMore((m) => !m)}>{more ? "Less" : "More"}</button>}
    </>
  );
}

/** The AI's progress: chain reads tick off quietly, its notes type in. Collapses when done. */
function Working({ notes, working, quiet }: { notes: Note[]; working: boolean; quiet?: boolean }) {
  const [open, setOpen] = useState(false);
  const ai = notes.filter((n) => n.source === "ai");
  const chain = notes.filter((n) => n.source === "chain");
  if (!working && !notes.length) return null;
  // Refreshing behind content that's already on screen: one clear line saying what it's doing.
  if (working && quiet && !ai.length) return (
    <div className="mx-4 mt-4 rounded-full bg-panel overflow-hidden rise">
      <div className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-dim"><span className="size-1.5 rounded-full bg-tape animate-pulse shrink-0" /><span className="truncate">{chain.at(-1)?.text ?? "Checking your wallet"}</span></div>
      <div className="h-[2px] bg-panel-2"><div className="h-full w-1/3 bg-tape animate-[slide_1.2s_ease-in-out_infinite]" /></div>
    </div>
  );
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
