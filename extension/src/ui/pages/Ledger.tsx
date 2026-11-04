import { useState } from "react";
import { Check } from "@phosphor-icons/react";
import { call } from "~/shared/messages";
import { LEDGER_PATHS, ledgerAccounts, ledgerSupported } from "~/ledger/ledger";
import { mount, short } from "../common";

/** Pair a Ledger: pick a derivation scheme, read the first addresses, choose which to add. */
function LedgerPage() {
  const [scheme, setScheme] = useState<(typeof LEDGER_PATHS)[number]>(LEDGER_PATHS[0]);
  const [accounts, setAccounts] = useState<{ address: string; path: string }[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const read = async (s = scheme) => {
    setBusy(true); setErr(null);
    try { const list = await ledgerAccounts(s, 5); setAccounts(list); setPicked(new Set([list[0]?.address].filter(Boolean) as string[])); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <main className="min-h-screen flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-[520px] flex flex-col gap-5">
        <span className="font-serif text-[28px] leading-none">Tailor</span>
        <div className="tape" />
        <h1 className="font-serif text-[40px] leading-[1.03]">Connect a Ledger</h1>
        {!ledgerSupported() ? <p className="text-danger text-[14px]">This browser doesn&apos;t support WebHID. Use Chrome on desktop.</p> : done ? (
          <>
            <p className="text-[15px] text-chalk/85">Added. Your Ledger accounts are in the account menu. Every transaction is confirmed on the device.</p>
            <button className="btn btn-primary justify-center" onClick={() => window.close()}>Done</button>
          </>
        ) : (
          <>
            <ol className="text-[14px] text-chalk/85 list-decimal pl-5 flex flex-col gap-1">
              <li>Plug in and unlock your Ledger.</li>
              <li>Open the Solana app on it.</li>
              <li>Choose the address scheme your accounts use, then connect.</li>
            </ol>
            <div className="flex flex-col gap-2">
              {LEDGER_PATHS.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-[14px]">
                  <input type="radio" name="scheme" checked={scheme.id === s.id} onChange={() => { setScheme(s); if (accounts.length) void read(s); }} />{s.label}
                </label>
              ))}
            </div>
            <button className="btn btn-primary justify-center !py-3" disabled={busy} onClick={() => read()}>{busy ? "Reading from your Ledger…" : accounts.length ? "Read again" : "Connect Ledger"}</button>
            {err && <p className="text-danger text-[13px]">{err}</p>}
            {accounts.length > 0 && (
              <>
                <ul className="card divide-y divide-line overflow-hidden">
                  {accounts.map((a) => {
                    const on = picked.has(a.address);
                    return (
                      <li key={a.address}>
                        <button className="w-full flex items-center gap-3 px-3.5 py-3 text-left hover:bg-panel-2" onClick={() => setPicked((p) => { const n = new Set(p); if (on) n.delete(a.address); else n.add(a.address); return n; })}>
                          <span className={`size-5 rounded-md border flex items-center justify-center ${on ? "bg-tape border-tape text-on-tape" : "border-line"}`}>{on && <Check size={12} weight="bold" />}</span>
                          <span className="flex-1 num text-[13px]">{short(a.address)}</span>
                          <span className="num text-[11.5px] text-faint">{a.path}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <button className="btn btn-primary justify-center" disabled={!picked.size || busy} onClick={async () => {
                  setErr(null);
                  try { await call({ type: "addLedger", accounts: accounts.filter((a) => picked.has(a.address)) }); setDone(true); }
                  catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
                }}>Add {picked.size} account{picked.size === 1 ? "" : "s"}</button>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}

mount(<LedgerPage />);
