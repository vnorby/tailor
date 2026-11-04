import { useEffect, useRef, useState } from "react";
import { ShieldCheck, ShieldWarning, CaretRight } from "@phosphor-icons/react";
import type { Position, ToolDef } from "@/lib/core/types";
import { siteFor, type SiteInfo } from "@/lib/ui/sites";
import { PROTOCOLS } from "@/lib/ui/protocols";
import { usd } from "@/lib/ui/format";
import { call, type PageRead } from "~/shared/messages";
import { amt } from "@/lib/ui/format";

export interface ActiveSite extends SiteInfo { origin: string; connected: boolean; rev: number }

/** The site in the focused tab, kept current as the user switches tabs or navigates. */
export function useActiveSite(): ActiveSite | null {
  const [site, setSite] = useState<ActiveSite | null>(null);
  useEffect(() => {
    let live = true, rev = 0;
    // rev bumps on every refresh so page-level consumers (suggestions) notice in-site navigation too.
    const refresh = () => void call<{ origin: string; connected: boolean } | null>({ type: "activeSite" })
      .then((r) => { if (!live) return; const s = r && siteFor(r.origin); setSite(s && r ? { ...s, origin: r.origin, connected: r.connected, rev: ++rev } : null); })
      .catch(() => live && setSite(null));
    refresh();
    // A page's content script connects a moment after load, hence the short retry.
    let t: ReturnType<typeof setTimeout> | undefined;
    const onUpdated = () => { clearTimeout(t); t = setTimeout(refresh, 900); };
    const onActivated = () => { refresh(); setTimeout(refresh, 800); };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.windows.onFocusChanged.addListener(onActivated);
    return () => { live = false; chrome.tabs.onActivated.removeListener(onActivated); chrome.tabs.onUpdated.removeListener(onUpdated); chrome.windows.onFocusChanged.removeListener(onActivated); };
  }, []);
  return site;
}

/**
 * What matters on this site, at a glance: is it safe and connected, your positions on its
 * protocol, and the moves it's for. One line for sites Tailor doesn't know.
 */
export function SiteContext({ site, apiBase, positions, tools, onOpenPosition, onTool }: {
  site: ActiveSite; apiBase: string; positions: Position[]; tools: ToolDef[]; onOpenPosition(id: string): void; onTool(t: ToolDef): void;
}) {
  const [verdict, setVerdict] = useState<"ok" | "suspicious" | "malicious" | null>(null);
  useEffect(() => {
    setVerdict(null);
    const ac = new AbortController();
    fetch(`${apiBase}/api/security/domain?origin=${encodeURIComponent(site.origin)}`, { signal: ac.signal })
      .then((r) => r.json()).then((j) => setVerdict(j.verdict ?? null)).catch(() => {});
    return () => ac.abort();
  }, [site.origin, apiBase]);

  const mine = positions.filter((p) => site.protocols.includes(p.protocol)).sort((a, b) => (b.risk.level === "danger" ? 1 : 0) - (a.risk.level === "danger" ? 1 : 0) || b.valueUsd - a.valueUsd);
  const moves = site.tools.map((id) => tools.find((t) => t.id === id)).filter((t): t is ToolDef => !!t);
  const bad = verdict === "suspicious" || verdict === "malicious";

  return (
    <section className={`mx-4 mt-4 card p-3 rise ${bad ? "!border-danger/60" : ""}`}>
      <div className="flex items-center gap-2 text-[12.5px]">
        {bad ? <ShieldWarning size={15} weight="fill" className="text-danger shrink-0" /> : <ShieldCheck size={15} weight="fill" className={`shrink-0 ${verdict === "ok" ? "text-pos" : "text-faint"}`} />}
        <span className="font-medium truncate">{site.host}</span>
        <span className={`ml-auto shrink-0 text-[11.5px] ${bad ? "text-danger" : site.connected ? "text-pos" : "text-faint"}`}>
          {verdict === "malicious" ? "Known scam" : verdict === "suspicious" ? "Looks suspicious" : site.connected ? "Connected" : "Not connected"}
        </span>
      </div>
      {!bad && mine.length > 0 && (
        <ul className="mt-2 flex flex-col">
          {mine.slice(0, 3).map((p) => (
            <li key={p.id}>
              <button className="w-full flex items-center gap-2 rounded-md px-1 py-1.5 text-left hover:bg-panel-2" onClick={() => onOpenPosition(p.id)}>
                <span className="size-2 rounded-full shrink-0" style={{ background: PROTOCOLS[p.protocol].color }} />
                <span className="flex-1 min-w-0 text-[13px] truncate">{p.title}</span>
                {p.risk.level !== "ok" && <span className={`text-[11px] shrink-0 ${p.risk.level === "danger" ? "text-danger" : "text-warn"}`}>{p.risk.level === "danger" ? "At risk" : "Watch"}</span>}
                <span className="num text-[13px] shrink-0">{usd(p.valueUsd)}</span>
                <CaretRight size={11} className="text-faint shrink-0" />
              </button>
            </li>
          ))}
          {mine.length > 3 && <li className="px-1 pt-0.5 text-[11.5px] text-faint">+{mine.length - 3} more</li>}
        </ul>
      )}
      {!bad && site.name && !mine.length && <p className="mt-1.5 text-[12px] text-dim">No {site.name} positions yet.</p>}
      {!bad && moves.length > 0 && (
        <div className="mt-2 flex gap-2">{moves.map((t) => <button key={t.id} className="btn !py-1 !text-[12px]" onClick={() => onTool(t)}>{t.label}</button>)}</div>
      )}
    </section>
  );
}

export interface MarketSuggestion { question: string; outcome: string; prob: number; volume: number; url: string; why: string }
export interface Suggestion { mint: string; symbol: string; name: string; icon?: string; price?: number; change24h?: number; verified: boolean; stock: boolean; why: string; held?: number }

/** Tradable things on the page in the focused tab. Re-reads when the site or page changes. */
export interface PageState { tokens: Suggestion[]; markets: MarketSuggestion[]; reading?: string; empty?: boolean }

export function usePageSuggestions(apiBase: string, owner: string, site: ActiveSite | null): PageState {
  const none: PageState = { tokens: [], markets: [] };
  const [list, setList] = useState<PageState>(none);
  // The page currently wanted; a response is applied only if it's still for this page. Re-checks of
  // the same page (tab events fire often) neither refetch nor cancel the request in flight.
  const wanted = useRef("");
  useEffect(() => {
    if (!site) { setList(none); wanted.current = ""; return; }
    void (async () => {
      const page = await call<PageRead | null>({ type: "readPage" }).catch(() => null);
      if (!page) { wanted.current = ""; setList(none); return; }
      const key = `${owner}|${page.url}|${page.selection}|${page.text.slice(0, 200)}`;
      if (key === wanted.current) return;
      wanted.current = key;
      // Say what's being read while Claude looks, so the wait is visible.
      setList({ ...none, reading: page.title || new URL(page.url).hostname });
      const r = await fetch(`${apiBase}/api/suggest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner, page }) }).catch(() => null);
      const j = r?.ok ? await r.json() : null;
      if (wanted.current !== key) return;
      const tokens = j?.suggestions ?? [], markets = j?.markets ?? [];
      setList({ tokens, markets, empty: !tokens.length && !markets.length });
      // "Nothing here" is a closing note, not a fixture.
      if (!tokens.length && !markets.length) setTimeout(() => { if (wanted.current === key) setList(none); }, 2200);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, owner, site?.origin, site?.rev]);
  return list;
}

/** "On this page": one tap to buy what you're reading about. Unverified addresses are only offered for a check. */
export function PageSuggestions({ state, swap, onBuy, onCheck }: { state: PageState; swap: ToolDef | undefined; onBuy(s: Suggestion): void; onCheck(s: Suggestion): void }) {
  const { tokens: list, markets } = state;
  if (state.reading) return (
    <section className="mx-4 mt-3 card p-3 rise overflow-hidden">
      <div className="h-[3px] -mx-3 -mt-3 mb-2.5 overflow-hidden bg-panel-2"><div className="h-full w-1/3 bg-tape animate-[slide_1.2s_ease-in-out_infinite]" /></div>
      <p className="text-[12px] text-dim truncate caret">Reading “{state.reading}”</p>
      <div className="mt-2 flex items-center gap-2.5"><span className="size-7 rounded-full bg-panel-2 animate-pulse" /><span className="h-3 flex-1 rounded bg-panel-2 animate-pulse" /><span className="h-6 w-12 rounded-full bg-panel-2 animate-pulse" /></div>
    </section>
  );
  if (state.empty) return <p className="mx-5 mt-3 text-[11.5px] text-faint rise">Nothing tradable on this page</p>;
  if (!list.length && !markets.length) return null;
  return (
    <section className="mx-4 mt-3 card p-3 rise">
      <h3 className="text-[11.5px] text-faint mb-1.5">On this page</h3>
      <ul className="flex flex-col gap-1">
        {list.map((s) => (
          <li key={s.mint} className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {s.icon ? <img src={s.icon} alt="" className="size-7 rounded-full bg-panel-2 shrink-0" /> : <span className="size-7 rounded-full bg-panel-2 shrink-0" />}
            <span className="flex-1 min-w-0">
              <span className="flex items-center gap-1.5 text-[13.5px] font-medium">{s.symbol}{!s.verified && <span className="rounded px-1 text-[10px] font-semibold bg-warn/15 text-warn">Unverified</span>}</span>
              <span className="block text-[11.5px] text-dim truncate">{s.held ? `You hold ${amt(s.held)}` : s.why}</span>
            </span>
            {s.price != null && (
              <span className="text-right shrink-0">
                <span className="block num text-[12.5px]">{s.price < 1 ? `$${s.price.toPrecision(3)}` : usd(s.price)}</span>
                {s.change24h != null && <span className={`block num text-[10.5px] ${s.change24h >= 0 ? "text-pos" : "text-danger"}`}>{s.change24h >= 0 ? "+" : ""}{s.change24h.toFixed(1)}%</span>}
              </span>
            )}
            {s.verified && swap
              ? <button className="btn btn-primary !py-1 !px-3 !text-[12px] shrink-0" onClick={() => onBuy(s)}>Buy</button>
              : <button className="btn !py-1 !px-3 !text-[12px] shrink-0" onClick={() => onCheck(s)}>Check</button>}
          </li>
        ))}
        {/* Polymarket runs on Polygon, so these open on Polymarket rather than trading in the wallet. */}
        {markets.map((m) => (
          <li key={m.url + m.question}>
            <a href={m.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2.5 rounded-md py-1 hover:bg-panel-2">
              <span className="size-7 rounded-full bg-panel-2 shrink-0 flex items-center justify-center text-[10px] font-semibold text-dim">{Math.round(m.prob * 100)}%</span>
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] leading-snug line-clamp-2">{m.question}</span>
                <span className="block text-[11px] text-faint truncate">Polymarket · {m.why}</span>
              </span>
              <span className="text-[11px] text-faint shrink-0">↗</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
