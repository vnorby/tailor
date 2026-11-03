import { useEffect, useState } from "react";
import { GearSix, LockSimple, SidebarSimple } from "@phosphor-icons/react";
import { Home } from "../home/Home";
import { call, type WalletState } from "~/shared/messages";
import { AccountSwitcher, Logo, mount, short, Unlock, useWalletState } from "../common";


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
  return <Wallet state={state} refresh={refresh} />;
}

function Wallet({ state, refresh }: { state: WalletState; refresh(): Promise<void> }) {
  const active = state.accounts.find((a) => a.id === state.activeId)!;
  const [settings, setSettings] = useState(false);
  const openPanel = async () => { const w = await chrome.windows.getCurrent(); await chrome.sidePanel.open({ windowId: w.id! }); window.close(); };
  const header = (
    <header className="flex items-center justify-between px-3 pt-3">
      <AccountSwitcher state={state} active={active} onChanged={() => void refresh()} />
      <div className="flex items-center gap-1">
        <button className="btn !px-2 !py-1.5" title="Open full wallet" aria-label="Open full wallet" onClick={openPanel}><SidebarSimple size={16} weight="fill" /></button>
        <button className="btn !px-2 !py-1.5" title="Settings" aria-label="Settings" onClick={() => setSettings(true)}><GearSix size={16} weight="fill" /></button>
        <button className="btn !px-2 !py-1.5" title="Lock" aria-label="Lock" onClick={async () => { await call({ type: "lock" }); await refresh(); }}><LockSimple size={16} weight="fill" /></button>
      </div>
    </header>
  );
  if (settings) return <Frame>{header}<Settings state={state} activeId={active.id} onBack={() => setSettings(false)} refresh={refresh} /></Frame>;
  return <div className="relative"><Home key={active.id} state={state} active={active} header={header} compact /></div>;
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
        <h3 className="text-[11px] uppercase tracking-[0.12em] text-faint">Look</h3>
        <button className="btn justify-center" onClick={() => chrome.tabs.create({ url: "onboarding.html" })}>Restyle wallet</button>
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
