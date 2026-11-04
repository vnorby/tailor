import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { call, type AccountMeta, type WalletState } from "~/shared/messages";
import type { Executor } from "@/components/ActionSheet";
import "./styles.css";
import { watchTheme } from "./theme";
import { passkeyRecord, unlockWithPasskey } from "./passkey";
import { Fingerprint } from "@phosphor-icons/react";

export function mount(node: ReactNode) {
  watchTheme();
  createRoot(document.getElementById("root")!).render(node);
}

export const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** Wallet state from the background, refreshed on storage changes (other windows, auto-lock). */
export function useWalletState() {
  const [state, setState] = useState<WalletState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setState(await call<WalletState>({ type: "state" })); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [refresh]);
  const active = state?.accounts.find((a) => a.id === state.activeId) ?? null;
  return { state, active, refresh, error, setState };
}

/** The extension signs inside its own background worker; the review sheet is the confirmation. */
export function extensionExecutor(state: WalletState, active: AccountMeta): Executor {
  return {
    apiBase: state.apiBase,
    owner: active.address,
    canSign: active.kind !== "watch" && state.unlocked,
    signHint: <p className="text-[13px] text-dim">{active.kind === "watch" ? "This is a watch-only account. Switch to an account you own to sign." : "Unlock Tailor to sign."}</p>,
    // Ledger accounts sign on the device from this page; others in the background worker.
    sign: (txs) => (active.kind === "ledger" ? import("~/ledger/ledger").then((l) => l.ledgerSignTxs(active.address, active.path!, txs)) : call<string[]>({ type: "signOwn", txs })),
  };
}

export function Logo({ size = 22 }: { size?: number }) {
  return <span className="font-serif leading-none" style={{ fontSize: size }}>Tailor</span>;
}

export function Unlock({ onUnlocked, compact }: { onUnlocked(s: WalletState): void; compact?: boolean }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasPasskey, setHasPasskey] = useState(false);
  useEffect(() => { void passkeyRecord().then((r) => setHasPasskey(!!r)); }, []);
  const withPasskey = async () => {
    setBusy(true); setErr(null);
    try { onUnlocked(await unlockWithPasskey()); } catch (x) { setErr(x instanceof Error ? x.message : String(x)); setBusy(false); }
  };
  return (
    <form className={`flex flex-col gap-3 ${compact ? "" : "flex-1 justify-center px-6"}`} onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(null);
      try { onUnlocked(await call<WalletState>({ type: "unlock", password: pw })); } catch (x) { setErr(x instanceof Error ? x.message : String(x)); setBusy(false); }
    }}>
      {!compact && <><Logo size={44} /><div className="tape" /><p className="text-dim text-[14px]">{hasPasskey ? "Unlock with your passkey or password." : "Enter your password to unlock."}</p></>}
      {hasPasskey && <button type="button" className="btn btn-primary justify-center !py-2.5" disabled={busy} onClick={withPasskey}><Fingerprint size={17} weight="fill" />Unlock with Touch ID / passkey</button>}
      <input className="input" type="password" autoFocus placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
      {err && <p className="text-danger text-[13px]">{err}</p>}
      <button className={`btn justify-center ${hasPasskey ? "" : "btn-primary"}`} disabled={!pw || busy}>{busy ? "Unlocking…" : "Unlock with password"}</button>
    </form>
  );
}

export function AccountSwitcher({ state, active, onChanged }: { state: WalletState; active: AccountMeta | null; onChanged(): void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<null | "import" | "watch">(null);
  const [val, setVal] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); setMode(null); setVal(""); setOpen(false); onChanged(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } };
  return (
    <div className="relative">
      <button className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-panel-2" onClick={() => setOpen((o) => !o)}>
        <span className="size-6 rounded-full bg-tape text-on-tape text-[12px] font-semibold flex items-center justify-center">{active?.name.slice(0, 1) ?? "?"}</span>
        <span className="text-left leading-tight">
          <span className="block text-[13px] font-medium">{active?.name ?? "No account"}{active?.kind === "watch" && <span className="ml-1 text-[10px] text-faint">watch</span>}</span>
          {active && <span className="block num text-[11px] text-dim">{short(active.address)}</span>}
        </span>
        <span className="text-faint text-[10px]">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 z-40 mt-1 w-72 card p-1.5 shadow-2xl">
          {state.accounts.map((a) => (
            <button key={a.id} className={`w-full flex items-center justify-between gap-2 rounded-lg px-2 py-2 text-left hover:bg-panel-2 ${a.id === state.activeId ? "bg-panel-2" : ""}`} onClick={() => act(() => call({ type: "setActive", id: a.id }))}>
              <span className="text-[13px]">{a.name}{a.kind !== "derived" && <span className="ml-1 text-[10px] text-faint">{a.kind === "ledger" ? "Ledger" : a.kind}</span>}</span>
              <span className="num text-[11px] text-dim">{short(a.address)}</span>
            </button>
          ))}
          <div className="border-t border-line my-1" />
          {mode ? (
            <form className="p-1.5 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void act(() => call(mode === "import" ? { type: "importKey", privateKey: val } : { type: "addWatch", address: val })); }}>
              <input className="input num !text-[12px]" type={mode === "import" ? "password" : "text"} autoFocus placeholder={mode === "import" ? "Private key (base58)" : "Address to watch"} value={val} onChange={(e) => setVal(e.target.value)} />
              <div className="flex gap-1.5"><button className="btn btn-primary flex-1 justify-center" disabled={!val}>{mode === "import" ? "Import" : "Watch"}</button><button type="button" className="btn" onClick={() => setMode(null)}>Cancel</button></div>
            </form>
          ) : (
            <>
              <button className="w-full rounded-lg px-2 py-2 text-left text-[13px] hover:bg-panel-2" onClick={() => act(() => call({ type: "addAccount" }))}>+ New account</button>
              <button className="w-full rounded-lg px-2 py-2 text-left text-[13px] hover:bg-panel-2" onClick={() => setMode("import")}>Import private key</button>
              <button className="w-full rounded-lg px-2 py-2 text-left text-[13px] hover:bg-panel-2" onClick={() => setMode("watch")}>Watch an address</button>
              <button className="w-full rounded-lg px-2 py-2 text-left text-[13px] hover:bg-panel-2" onClick={() => chrome.tabs.create({ url: "ledger.html" })}>Connect a Ledger</button>
            </>
          )}
          {err && <p className="px-2 pb-1 text-[12px] text-danger">{err}</p>}
        </div>
      )}
    </div>
  );
}
