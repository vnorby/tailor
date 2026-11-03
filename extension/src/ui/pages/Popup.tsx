import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { ArrowDown, ArrowUp, ArrowsLeftRight, GearSix, LockSimple } from "@phosphor-icons/react";
import { call, type WalletState } from "~/shared/messages";
import type { Token, ToolDef } from "@/lib/core/types";
import { ActionProvider, useActions } from "@/components/ActionSheet";
import { amt, usd } from "@/lib/ui/format";
import { AccountSwitcher, extensionExecutor, Logo, mount, short, Unlock, useWalletState } from "../common";

type View = "home" | "receive" | "settings";

function Popup() {
  const { state, active, refresh } = useWalletState();
  if (!state) return <Frame><p className="m-auto text-dim text-[13px]">Loading…</p></Frame>;
  if (!state.initialized) return (
    <Frame>
      <div className="m-auto flex flex-col gap-4 px-6 text-center">
        <Logo size={44} /><div className="tape" />
        <p className="text-chalk/80 text-[14px]">Set up Tailor to get started.</p>
        <button className="btn btn-primary justify-center" onClick={() => chrome.tabs.create({ url: "onboarding.html" })}>Set up wallet</button>
      </div>
    </Frame>
  );
  if (!state.unlocked) return <Frame><Unlock onUnlocked={() => void refresh()} /></Frame>;
  if (!active) return <Frame><p className="m-auto text-dim">No account.</p></Frame>;
  return <Home state={state} refresh={refresh} />;
}

function Home({ state, refresh }: { state: WalletState; refresh(): Promise<void> }) {
  const active = state.accounts.find((a) => a.id === state.activeId)!;
  const [view, setView] = useState<View>("home");
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [total, setTotal] = useState(0);
  const [tools, setTools] = useState<ToolDef[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await fetch(`${state.apiBase}/api/balance?owner=${active.address}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setTokens(j.tokens); setTotal(j.totalUsd);
    } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't load balances."); }
  }, [state.apiBase, active.address]);

  useEffect(() => { setTokens(null); void load(); }, [load]);
  useEffect(() => { fetch(`${state.apiBase}/api/tools`).then((r) => r.json()).then((j) => setTools(j.tools ?? [])).catch(() => {}); }, [state.apiBase]);

  const openPanel = async () => { const w = await chrome.windows.getCurrent(); await chrome.sidePanel.open({ windowId: w.id! }); window.close(); };

  return (
    <ActionProvider executor={extensionExecutor(state, active)} onDone={() => void load()}>
      <Frame>
        <header className="flex items-center justify-between px-3 pt-3">
          <AccountSwitcher state={state} active={active} onChanged={() => void refresh()} />
          <div className="flex items-center gap-1">
            <button className="btn !px-2 !py-1.5" title="Settings" aria-label="Settings" onClick={() => setView(view === "settings" ? "home" : "settings")}><GearSix size={16} weight="fill" /></button>
            <button className="btn !px-2 !py-1.5" title="Lock" aria-label="Lock" onClick={async () => { await call({ type: "lock" }); await refresh(); }}><LockSimple size={16} weight="fill" /></button>
          </div>
        </header>

        {view === "home" && (
          <>
            <section className="px-4 pt-5 pb-3">
              <div className="font-serif text-[44px] leading-none">{tokens ? usd(total) : "—"}</div>
              <div className="tape mt-4" />
            </section>
            <QuickActions tools={tools} watch={active.kind === "watch"} onReceive={() => setView("receive")} />
            <button className="mx-4 mt-3 card px-3 py-2.5 text-left hover:border-tape/50 transition-colors" onClick={openPanel}>
              <div className="text-[13px] font-medium">Open your wallet →</div>
              <div className="text-[12px] text-dim">A full dashboard built around your positions. Ask it for anything.</div>
            </button>
            <ul className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2.5">
              {err && <li className="text-[13px] text-danger">{err}</li>}
              {!tokens && !err && [0, 1, 2].map((i) => <li key={i} className="h-8 rounded-lg bg-panel animate-pulse" />)}
              {tokens?.map((t) => (
                <li key={t.mint} className="flex items-center gap-2.5 text-[14px]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {t.icon ? <img src={t.icon} alt="" className="size-7 rounded-full bg-panel-2" /> : <span className="size-7 rounded-full bg-panel-2" />}
                  <span className="flex-1 min-w-0"><span className="block truncate">{t.symbol}</span><span className="block num text-[11.5px] text-dim">{amt(t.amount)}</span></span>
                  <span className="num">{usd(t.valueUsd)}</span>
                </li>
              ))}
              {tokens?.length === 0 && <li className="text-[13px] text-dim">No tokens yet. Receive some SOL to get started.</li>}
            </ul>
          </>
        )}
        {view === "receive" && <Receive address={active.address} onBack={() => setView("home")} />}
        {view === "settings" && <Settings state={state} activeId={active.id} onBack={() => setView("home")} refresh={refresh} />}
      </Frame>
    </ActionProvider>
  );
}

function QuickActions({ tools, watch, onReceive }: { tools: ToolDef[]; watch: boolean; onReceive(): void }) {
  const { open } = useActions();
  const tool = (id: string) => tools.find((t) => t.id === id);
  const btn = (label: string, icon: React.ReactNode, onClick: () => void, disabled = false) => <button className="btn flex-col !gap-1.5 !py-2.5 flex-1 justify-center" disabled={disabled} onClick={onClick}>{icon}<span className="text-[12.5px]">{label}</span></button>;
  return (
    <div className="px-4 flex gap-2">
      {btn("Send", <ArrowUp size={16} weight="bold" />, () => { const t = tool("send"); if (t) open({ kind: "tool", tool: t, params: {}, form: true }); }, watch || !tool("send"))}
      {btn("Receive", <ArrowDown size={16} weight="bold" />, onReceive)}
      {btn("Swap", <ArrowsLeftRight size={16} weight="bold" />, () => { const t = tool("swap"); if (t) open({ kind: "tool", tool: t, params: {}, form: true }); }, watch || !tool("swap"))}
    </div>
  );
}

function Receive({ address, onBack }: { address: string; onBack(): void }) {
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => { void QRCode.toDataURL(address, { margin: 1, width: 220, color: { dark: "#141416", light: "#ece6d8" } }).then(setQr); }, [address]);
  return (
    <div className="flex-1 flex flex-col items-center gap-4 px-6 pt-6">
      {qr && <img src={qr} alt="Address QR code" className="rounded-xl" width={200} height={200} />}
      <p className="num text-[12.5px] text-center break-all text-chalk/90">{address}</p>
      <button className="btn btn-primary w-full justify-center" onClick={() => { void navigator.clipboard.writeText(address); setCopied(true); }}>{copied ? "Copied" : "Copy address"}</button>
      <p className="text-[12px] text-dim text-center">Only send Solana (SPL) tokens to this address.</p>
      <button className="text-[13px] text-dim hover:text-chalk" onClick={onBack}>Back</button>
    </div>
  );
}

function Settings({ state, activeId, onBack, refresh }: { state: WalletState; activeId: string; onBack(): void; refresh(): Promise<void> }) {
  const [sites, setSites] = useState<{ origin: string }[]>([]);
  const [revealWhat, setRevealWhat] = useState<null | "mnemonic" | "privateKey">(null);
  const [pw, setPw] = useState(""); const [secret, setSecret] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const [api, setApi] = useState(state.apiBase);
  useEffect(() => { call<{ origin: string }[]>({ type: "connectedSites" }).then(setSites).catch(() => {}); }, []);
  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-5 text-[13px]">
      <button className="text-left text-dim hover:text-chalk" onClick={onBack}>← Back</button>
      <section className="flex flex-col gap-2">
        <h3 className="text-[11px] uppercase tracking-[0.12em] text-faint">Connected sites</h3>
        {sites.length === 0 && <p className="text-dim">None.</p>}
        {sites.map((s) => (
          <div key={s.origin} className="flex items-center justify-between"><span className="truncate">{s.origin.replace(/^https?:\/\//, "")}</span>
            <button className="btn !py-1 !px-2 text-[12px]" onClick={async () => { await call({ type: "disconnectSite", origin: s.origin }); setSites((x) => x.filter((y) => y.origin !== s.origin)); }}>Disconnect</button></div>
        ))}
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-[11px] uppercase tracking-[0.12em] text-faint">Auto-lock</h3>
        <select className="input" value={state.autoLockMinutes} onChange={async (e) => { await call({ type: "setAutoLock", minutes: Number(e.target.value) }); await refresh(); }}>
          {[5, 15, 30, 60, 240, 720].map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? "s" : ""}`}</option>)}
        </select>
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-[11px] uppercase tracking-[0.12em] text-faint">Secrets</h3>
        {!revealWhat ? (
          <div className="flex gap-2"><button className="btn flex-1 justify-center" onClick={() => setRevealWhat("mnemonic")}>Show recovery phrase</button><button className="btn flex-1 justify-center" onClick={() => setRevealWhat("privateKey")}>Export private key</button></div>
        ) : secret ? (
          <div className="flex flex-col gap-2"><p className="text-warn text-[12px]">Never share this. Anyone with it controls your funds.</p><pre className="card p-3 num text-[12px] whitespace-pre-wrap break-all">{secret}</pre><button className="btn justify-center" onClick={() => { setSecret(null); setRevealWhat(null); setPw(""); }}>Hide</button></div>
        ) : (
          <form className="flex flex-col gap-2" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { setSecret(await call<string>({ type: "reveal", password: pw, what: revealWhat, id: activeId })); } catch (x) { setErr(x instanceof Error ? x.message : String(x)); } }}>
            <input className="input" type="password" autoFocus placeholder="Enter your password" value={pw} onChange={(e) => setPw(e.target.value)} />
            {err && <p className="text-danger text-[12px]">{err}</p>}
            <div className="flex gap-2"><button className="btn btn-danger flex-1 justify-center" disabled={!pw}>Reveal</button><button type="button" className="btn" onClick={() => setRevealWhat(null)}>Cancel</button></div>
          </form>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-[11px] uppercase tracking-[0.12em] text-faint">Tailor server</h3>
        <div className="flex gap-2"><input className="input num !text-[12px]" value={api} onChange={(e) => setApi(e.target.value)} /><button className="btn" onClick={async () => { await call({ type: "setApiBase", url: api }); await refresh(); }}>Save</button></div>
      </section>
      <p className="text-[11px] text-faint">Account {short(state.accounts.find((a) => a.id === activeId)?.address ?? "")} · Tailor 0.1.0</p>
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="w-[360px] h-[600px] flex flex-col overflow-hidden">{children}</div>;
}

mount(<Popup />);
